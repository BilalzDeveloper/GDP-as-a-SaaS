-- Migration 0003 — Data intake and the observation core (milestone 4)
--
-- Two layers:
--   Intake      source_dataset, column_mapping, staging_row, validation_issue
--   Commit target  reference_period, time_series, data_vintage, observation
--
-- "Staging before commit" implies something to commit into, so the
-- observation core lands here. Milestone 5 builds compilation runs on top of
-- it; this migration is about getting data in correctly, not computing from it.
--
-- Non-negotiable 1 (reproducibility): observations belong to an append-only
-- vintage. Freezing a vintage makes its observations immutable at the database
-- level, so a published figure can always be re-computed from what it was
-- actually built from.

set check_function_bodies = off;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type period_frequency as enum ('annual', 'quarterly');

-- SNA 2008 ch.15: price basis is part of a series' identity, never inferred.
create type price_basis as enum ('current', 'previous_year', 'chain_linked');

-- SNA 2008 ch.6: conversions between valuations must be explicit.
create type valuation_basis as enum ('basic', 'producers', 'purchasers');

create type dataset_status as enum (
  'uploaded',    -- bytes stored, not yet parsed
  'parsed',      -- rows extracted, no mapping applied
  'mapped',      -- a column mapping has been applied
  'validated',   -- validation has run; issues recorded
  'committed',   -- staged rows promoted into observations
  'discarded'
);

create type issue_severity as enum ('error', 'warning', 'info');

create type observation_origin as enum ('source', 'derived');

-- -----------------------------------------------------------------------------
-- Reference periods (org-scoped: fiscal years differ by country)
-- -----------------------------------------------------------------------------

create table reference_period (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organization (id) on delete cascade,
  frequency   period_frequency not null,
  start_date  date not null,
  end_date    date not null,
  label       text not null,              -- '2024', 'FY2024/25', '2024-Q3'
  fiscal_year integer not null,
  created_at  timestamptz not null default now(),
  unique (org_id, frequency, start_date),
  unique (org_id, frequency, label),
  check (end_date > start_date)
);

create index reference_period_org_idx on reference_period (org_id, frequency, start_date);

-- -----------------------------------------------------------------------------
-- Time series and vintages
-- -----------------------------------------------------------------------------
-- A series is a coordinate in the SNA data cube; an observation is a fact at
-- that coordinate, in a vintage. Dimensions are nullable because they are not
-- all meaningful at once (P.3 by COICOP has no activity; B.1g by ISIC has no
-- product), so identity needs UNIQUE NULLS NOT DISTINCT (PG15+).

create table time_series (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organization (id) on delete cascade,
  transaction_code text not null references transaction_code (code),
  activity_item_id uuid references classification_item (id),
  product_item_id  uuid references classification_item (id),
  sector_item_id   uuid references classification_item (id),
  purpose_item_id  uuid references classification_item (id),
  price_basis      price_basis not null default 'current',
  valuation        valuation_basis,
  frequency        period_frequency not null,
  unit_code        text not null references unit (code),
  description      text,
  created_at       timestamptz not null default now(),
  unique nulls not distinct
    (org_id, transaction_code, activity_item_id, product_item_id,
     sector_item_id, purpose_item_id, price_basis, valuation, frequency)
);

create index time_series_org_txn_idx on time_series (org_id, transaction_code);
create index time_series_activity_idx on time_series (activity_item_id)
  where activity_item_id is not null;

create table data_vintage (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organization (id) on delete cascade,
  name                  text not null,
  supersedes_vintage_id uuid references data_vintage (id),
  frozen_at             timestamptz,
  published             boolean not null default false,
  embargo_until         timestamptz,
  created_by            uuid references auth.users (id),
  created_at            timestamptz not null default now(),
  unique (org_id, name),
  -- An unfrozen vintage can still change, so publishing one would make the
  -- published figure unreproducible.
  check (not published or frozen_at is not null)
);

-- -----------------------------------------------------------------------------
-- Source datasets (uploaded files and their provenance)
-- -----------------------------------------------------------------------------

create table source_dataset (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organization (id) on delete cascade,
  name              text not null,
  original_filename text not null,
  content_type      text not null,
  byte_size         integer not null check (byte_size >= 0),
  -- Identifies the exact bytes that produced these rows (non-negotiable 1).
  sha256            char(64) not null,
  -- The file itself. Held in the database so it falls under the same RLS
  -- policies and the same isolation tests as every other tenant row; see
  -- DECISIONS.md D20 for the size cap and the migration path to object
  -- storage.
  file_bytes        bytea,
  status            dataset_status not null default 'uploaded',
  -- Free-form provenance the compiler supplies: which survey, which extract,
  -- which date. Kept alongside the checksum, not instead of it.
  provenance        jsonb not null default '{}'::jsonb,
  /* Parsed shape */
  header            jsonb,                -- column names as found in the file
  row_count         integer,
  sheet_name        text,                 -- xlsx only
  uploaded_by       uuid references auth.users (id),
  uploaded_at       timestamptz not null default now(),
  unique (org_id, sha256)                 -- same bytes uploaded twice is a no-op
);

create index source_dataset_org_idx on source_dataset (org_id, uploaded_at desc);

-- -----------------------------------------------------------------------------
-- Column mappings
-- -----------------------------------------------------------------------------
-- How a file's columns become observation coordinates. Saved per organization
-- so a recurring monthly extract is mapped once, not every time.

create table column_mapping (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organization (id) on delete cascade,
  name         text not null,
  /*
   * Shape:
   *   {
   *     "columns": {
   *       "transactionCode": {"source": "txn"} | {"constant": "P.1"},
   *       "activityCode":    {"source": "isic"},
   *       "periodLabel":     {"source": "year"},
   *       "value":           {"source": "amount"},
   *       ...
   *     },
   *     "activityVersionId": "<uuid>",
   *     "unitCode": "NC_MN",
   *     "priceBasis": "current",
   *     "valuation": "basic",
   *     "frequency": "annual"
   *   }
   * Validated in application code (src/intake/mapping.ts), which owns the
   * shape; the database stores it and enforces tenancy.
   */
  definition   jsonb not null,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  unique (org_id, name)
);

-- -----------------------------------------------------------------------------
-- Staging
-- -----------------------------------------------------------------------------
-- Parsed rows land here and are validated before anything reaches the
-- observation table. Nothing enters `observation` that has not been staged,
-- so a compiler always sees exactly what will be committed.

create table staging_row (
  id               bigint generated always as identity primary key,
  org_id           uuid not null references organization (id) on delete cascade,
  dataset_id       uuid not null references source_dataset (id) on delete cascade,
  /** 1-based line number in the source file, for pointing a human at it. */
  source_row_number integer not null,
  /** The row exactly as parsed, before any interpretation. */
  raw              jsonb not null,
  /*
   * Resolved coordinates — null until a mapping has been applied.
   *
   * NOTE the deliberate absence of foreign keys on transaction_code and
   * unit_code. Staging must be able to hold a row whose codes are WRONG:
   * that is the whole point of staging, and a compiler cannot be shown
   * "transaction code ZZ.9 is not an SNA code" if the row could not be
   * stored in the first place. Validity is recorded in is_valid and
   * validation_issue; the foreign keys live on time_series and observation,
   * which only ever receive rows that passed. See DECISIONS.md D21.
   *
   * The *_item_id columns do keep their foreign keys: they hold resolved
   * identifiers, and are simply left null when resolution failed, with the
   * unresolved source text preserved in `raw`.
   */
  transaction_code text,
  activity_item_id uuid references classification_item (id),
  product_item_id  uuid references classification_item (id),
  sector_item_id   uuid references classification_item (id),
  purpose_item_id  uuid references classification_item (id),
  period_id        uuid references reference_period (id),
  price_basis      price_basis,
  valuation        valuation_basis,
  unit_code        text,
  value            numeric(20,6),
  /** False when any error-severity issue attaches to this row. */
  is_valid         boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (dataset_id, source_row_number)
);

create index staging_row_dataset_idx on staging_row (dataset_id, source_row_number);
create index staging_row_invalid_idx on staging_row (dataset_id) where not is_valid;

create table validation_issue (
  id             bigint generated always as identity primary key,
  org_id         uuid not null references organization (id) on delete cascade,
  dataset_id     uuid not null references source_dataset (id) on delete cascade,
  /** Null for dataset-level findings such as a coverage gap. */
  staging_row_id bigint references staging_row (id) on delete cascade,
  severity       issue_severity not null,
  /** Stable machine code; see src/intake/validate.ts and docs/data-intake.md. */
  code           text not null,
  message        text not null,
  /** Which mapped field the issue concerns, when it concerns one. */
  field          text,
  created_at     timestamptz not null default now()
);

create index validation_issue_dataset_idx on validation_issue (dataset_id, severity);

-- -----------------------------------------------------------------------------
-- Observations
-- -----------------------------------------------------------------------------

create table observation (
  id                bigint generated always as identity primary key,
  org_id            uuid not null references organization (id) on delete cascade,
  series_id         uuid not null references time_series (id) on delete cascade,
  period_id         uuid not null references reference_period (id),
  vintage_id        uuid not null references data_vintage (id),
  value             numeric(20,6),         -- null = explicitly missing
  origin            observation_origin not null default 'source',
  source_dataset_id uuid references source_dataset (id),
  /** The staging row this came from — the drill-down path to source records. */
  staging_row_id    bigint references staging_row (id) on delete set null,
  created_by        uuid references auth.users (id),
  created_at        timestamptz not null default now(),
  unique (series_id, period_id, vintage_id)
);

create index observation_vintage_idx on observation (vintage_id);
create index observation_series_period_idx on observation (series_id, period_id);
create index observation_dataset_idx on observation (source_dataset_id)
  where source_dataset_id is not null;

-- Immutability once the parent vintage is frozen (non-negotiable 1).
create function private.reject_if_vintage_frozen()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_vintage uuid := case when tg_op = 'DELETE' then old.vintage_id else new.vintage_id end;
  v_frozen  timestamptz;
begin
  select frozen_at into v_frozen
    from public.data_vintage where id = v_vintage;
  if v_frozen is not null then
    raise exception
      'vintage % is frozen; observations are immutable — create a new vintage',
      v_vintage using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger observation_frozen_guard
  before insert or update or delete on observation
  for each row execute function private.reject_if_vintage_frozen();

-- A frozen vintage may only flip `published`; freezing is one-way and the
-- embargo cannot move afterwards, or the guarantee is worthless.
create function private.guard_vintage_update()
returns trigger
language plpgsql
as $$
begin
  if old.frozen_at is not null then
    if new.frozen_at is distinct from old.frozen_at
       or new.embargo_until is distinct from old.embargo_until
       or new.supersedes_vintage_id is distinct from old.supersedes_vintage_id
       or new.name is distinct from old.name then
      raise exception 'frozen vintage % may only change its published flag', old.id
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger data_vintage_update_guard
  before update on data_vintage
  for each row execute function private.guard_vintage_update();

-- -----------------------------------------------------------------------------
-- Audit
-- -----------------------------------------------------------------------------
-- Everything that shapes or holds a figure is audited. staging_row and
-- validation_issue are deliberately NOT: they are machine-generated working
-- state, rewritten wholesale on every re-parse, and auditing them would bury
-- the meaningful entries under thousands of rows per upload.

create trigger audit_reference_period
  after insert or update or delete on reference_period
  for each row execute function private.audit_row();
create trigger audit_source_dataset
  after insert or update or delete on source_dataset
  for each row execute function private.audit_row();
create trigger audit_column_mapping
  after insert or update or delete on column_mapping
  for each row execute function private.audit_row();
create trigger audit_time_series
  after insert or update or delete on time_series
  for each row execute function private.audit_row();
create trigger audit_data_vintage
  after insert or update or delete on data_vintage
  for each row execute function private.audit_row();
create trigger audit_observation
  after insert or update or delete on observation
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
-- Same pattern as milestones 1–2: members read, admin/compiler write, FORCE
-- so even the table owner goes through policies. New tenant tables get
-- matching policies AND matching isolation tests in the same change
-- (CLAUDE.md working rules).

grant select, insert, update, delete on
  reference_period, time_series, data_vintage, source_dataset,
  column_mapping, staging_row, validation_issue, observation
  to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'reference_period', 'time_series', 'data_vintage', 'source_dataset',
    'column_mapping', 'staging_row', 'validation_issue', 'observation'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I_select on %I for select
         using (private.is_org_member(org_id))', t, t);
    execute format(
      'create policy %I_write on %I for all
         using (private.has_org_role(org_id, ''admin'', ''compiler''))
         with check (private.has_org_role(org_id, ''admin'', ''compiler''))',
      t, t);
  end loop;
end;
$$;
