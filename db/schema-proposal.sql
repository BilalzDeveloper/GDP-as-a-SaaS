-- =============================================================================
-- SNA GDP Compilation SaaS — proposed schema, milestones 1–3
-- =============================================================================
-- Target: PostgreSQL 15+ on Supabase (uses auth.uid()/auth.users and
-- UNIQUE NULLS NOT DISTINCT). Written as a single reviewable proposal; will be
-- split into numbered Drizzle migrations once approved.
--
-- Layering:
--   §1  Roles/enums and helper functions
--   §2  Tenancy: organizations, memberships          (milestone 1)
--   §3  Audit: append-only audit_log + trigger       (milestone 1)
--   §4  Reference data: countries, currencies, units,
--       SNA transaction codes, classifications,
--       tenant mapping layer                          (milestone 2)
--   §5  Compilation core: periods, method versions,
--       runs, series, vintages, observations          (milestone 3)
--   §6  RLS policies
--
-- Conventions:
--   - Every tenant-owned table has org_id and FORCE ROW LEVEL SECURITY.
--   - Reference tables (no org_id, or owner_org_id NULL) are world-readable,
--     seeded only via migrations/service scripts — app roles cannot write them.
--   - Money/values: NUMERIC(20,6). Engine-side handling: see DECISIONS.md D3.
-- =============================================================================

create extension if not exists pgcrypto;

-- Private schema for helpers that must not be exposed via PostgREST.
create schema if not exists private;

-- -----------------------------------------------------------------------------
-- §1 Enums and helpers
-- -----------------------------------------------------------------------------

create type org_role as enum ('admin', 'compiler', 'reviewer', 'viewer');

-- Generic kind tag for classifications. Institutional sectors (S.11…S.2) are
-- deliberately a classification, not an enum — requirement 4.
create type classification_kind as enum
  ('activity', 'product', 'consumption_purpose', 'government_function',
   'institutional_sector', 'geography', 'other');

-- SNA 2008 ch.6 (valuation of output, §6.51ff) and ch.14: conversions between
-- these must be explicit, so the basis is part of the series identity.
create type valuation_basis as enum ('basic', 'producers', 'purchasers');

-- SNA 2008 ch.15: price/volume decomposition.
create type price_basis as enum ('current', 'previous_year', 'chain_linked');

create type period_frequency as enum ('annual', 'quarterly');

create type run_status as enum
  ('draft', 'computing', 'computed', 'under_review', 'approved',
   'published', 'superseded');

create type observation_origin as enum ('source', 'derived');

create type dataset_validation_status as enum ('pending', 'passed', 'failed');

-- Membership checks used inside RLS policies. SECURITY DEFINER so the check
-- itself is not subject to RLS on membership (avoids policy recursion).
-- LOAD-BEARING ASSUMPTION: everything in `private` is owned by a role with
-- the BYPASSRLS attribute (Supabase's `postgres` role has it). That is what
-- breaks the policy→helper→policy recursion under FORCE ROW LEVEL SECURITY,
-- and what lets the org-bootstrap trigger (§6) insert the creator's first
-- membership row before any admin exists. The milestone-1 CI suite must
-- assert (a) this ownership holds after migration and (b) app roles cannot
-- reach these functions except through the policies that use them.
-- Justification recorded in DECISIONS.md D7; bodies are intentionally trivial.
create function private.is_org_member(p_org uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membership m
    where m.org_id = p_org and m.user_id = auth.uid()
  );
$$;

create function private.has_org_role(p_org uuid, variadic p_roles org_role[])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membership m
    where m.org_id = p_org
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
  );
$$;

-- -----------------------------------------------------------------------------
-- §2 Tenancy (milestone 1)
-- -----------------------------------------------------------------------------

create table organization (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  slug                    text not null unique
                          check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  country_code            char(3),           -- FK added in §4 (country defined there)
  -- Not every country runs January–December (brief, "Reference periods").
  fiscal_year_start_month smallint not null default 1
                          check (fiscal_year_start_month between 1 and 12),
  created_at              timestamptz not null default now()
);

create table membership (
  org_id     uuid not null references organization (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       org_role not null default 'viewer',
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- -----------------------------------------------------------------------------
-- §3 Audit (milestone 1) — requirement 2: who, when, what changed, and why
-- -----------------------------------------------------------------------------

create table audit_log (
  id          bigint generated always as identity primary key,
  org_id      uuid,                          -- null for reference-data writes
  actor_id    uuid,                          -- auth.uid() at write time
  occurred_at timestamptz not null default now(),
  table_name  text not null,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  row_pk      text not null,
  old_data    jsonb,
  new_data    jsonb,
  reason      text not null                  -- app must set app.reason
);

-- The "why": app layer runs set_config('app.reason', <text>, true) inside the
-- transaction. Audited writes without a reason are rejected outright.
create function private.audit_row()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(current_setting('app.reason', true), '');
  v_row    record;
begin
  if v_reason is null then
    raise exception 'audited write to % requires app.reason to be set', tg_table_name
      using errcode = 'P0001';
  end if;
  v_row := coalesce(new, old);
  insert into public.audit_log
    (org_id, actor_id, table_name, action, row_pk, old_data, new_data, reason)
  values (
    -- organization rows ARE the org; every other tenant table carries org_id
    coalesce(
      to_jsonb(v_row) ->> 'org_id',
      case when tg_table_name = 'organization' then to_jsonb(v_row) ->> 'id' end
    )::uuid,
    auth.uid(), tg_table_name, tg_op,
    coalesce(to_jsonb(v_row) ->> 'id',
             to_jsonb(v_row) ->> 'org_id') ,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    v_reason
  );
  return coalesce(new, old);
end;
$$;

-- audit_log is append-only for everyone, owner included.
create function private.reject_change()
returns trigger language plpgsql as
$$ begin raise exception '% is append-only', tg_table_name; end; $$;

create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function private.reject_change();

-- (The audit trigger itself is attached per-table in §5/§6 after the audited
-- tables exist; milestone 1 attaches it to organization and membership.)

-- -----------------------------------------------------------------------------
-- §4 Reference data (milestone 2)
-- -----------------------------------------------------------------------------

create table currency (
  code        char(3) primary key,           -- ISO 4217
  name        text not null,
  minor_units smallint not null default 2
);

create table country (
  iso3          char(3) primary key,
  iso2          char(2) not null unique,
  name          text not null,
  currency_code char(3) references currency (code)
);

alter table organization
  add constraint organization_country_fk
  foreign key (country_code) references country (iso3);

-- Unit-of-measure registry. "GBP millions" = (currency GBP, multiplier 1e6).
create table unit (
  code          text primary key,            -- e.g. 'GBP_MN', 'INDEX', 'PERSONS'
  name          text not null,
  unit_type     text not null check (unit_type in
                  ('currency', 'index', 'count', 'other')),
  currency_code char(3) references currency (code),
  multiplier    numeric(20,6) not null default 1 check (multiplier > 0),
  check (unit_type <> 'currency' or currency_code is not null)
);

-- SNA 2008 transaction/balancing-item codes (P.1, P.2, B.1g, D.21, …).
-- Seeded from the brief's list; sna2008_ref cites the defining paragraph(s).
create table transaction_code (
  code        text primary key,              -- 'P.1', 'B.1g', 'D.21', …
  name        text not null,
  sna2008_ref text not null,
  description text
);

-- Classifications: ISIC Rev.4, CPC 2.1, COICOP, COFOG, institutional sectors —
-- and tenant-defined national adaptations (owner_org_id set).
create table classification (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,                -- 'ISIC4', 'CPC21', 'NACE-XX', …
  name         text not null,
  kind         classification_kind not null,
  owner_org_id uuid references organization (id) on delete cascade,
  -- National variants declare what they adapt (e.g. national ISIC).
  based_on_id  uuid references classification (id),
  unique nulls not distinct (code, owner_org_id)
);

create table classification_version (
  id                uuid primary key default gen_random_uuid(),
  classification_id uuid not null references classification (id)
                    on delete cascade,
  version_label     text not null,           -- 'Rev.4', '2.1', 'v2024'
  valid_from        date,
  is_current        boolean not null default false,
  unique (classification_id, version_label)
);

create table classification_item (
  id         uuid primary key default gen_random_uuid(),
  version_id uuid not null references classification_version (id)
             on delete cascade,
  code       text not null,                  -- '01', '0111', 'S.11', '05.1.1'
  name       text not null,
  parent_id  uuid references classification_item (id) on delete cascade,
  level      smallint not null default 1 check (level >= 1),
  sort_order integer not null default 0,
  unique (version_id, code)
);

create index classification_item_parent_idx on classification_item (parent_id);
create index classification_item_version_idx
  on classification_item (version_id, level);

-- Tenant mapping layer: national/custom version -> standard version.
create table classification_mapping (
  id              uuid primary key default gen_random_uuid(),
  owner_org_id    uuid references organization (id) on delete cascade,
  name            text not null,
  from_version_id uuid not null references classification_version (id),
  to_version_id   uuid not null references classification_version (id),
  created_at      timestamptz not null default now(),
  check (from_version_id <> to_version_id)
);

-- weight supports 1-to-many splits (one national code feeding several ISIC
-- codes); weights for a from_item conventionally sum to 1 — enforced by a
-- validation query at mapping activation, not a constraint (partial drafts
-- must be saveable).
create table classification_mapping_entry (
  id           uuid primary key default gen_random_uuid(),
  mapping_id   uuid not null references classification_mapping (id)
               on delete cascade,
  from_item_id uuid not null references classification_item (id),
  to_item_id   uuid not null references classification_item (id),
  weight       numeric(9,6) not null default 1 check (weight > 0 and weight <= 1),
  unique (mapping_id, from_item_id, to_item_id)
);

-- -----------------------------------------------------------------------------
-- §5 Compilation core (milestone 3)
-- -----------------------------------------------------------------------------

-- Org-scoped periods: fiscal years differ, so periods carry explicit dates.
create table reference_period (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organization (id) on delete cascade,
  frequency   period_frequency not null,
  start_date  date not null,
  end_date    date not null,
  label       text not null,                 -- '2024', 'FY2024/25', '2024-Q3'
  fiscal_year integer not null,
  unique (org_id, frequency, start_date),
  check (end_date > start_date)
);

-- Requirement 1 (reproducibility): every computed result pins the exact engine
-- release and full configuration that produced it. System-wide, append-only.
create table method_version (
  id             uuid primary key default gen_random_uuid(),
  engine_semver  text not null,
  engine_git_sha text,
  config         jsonb not null default '{}'::jsonb,  -- balancing anchor,
                                                      -- index formula, etc.
  created_at     timestamptz not null default now(),
  unique (engine_semver, engine_git_sha)
);

-- Minimal stub now so observations can carry provenance from day one;
-- the full intake model (column mappings, staging) is milestone 4.
create table source_dataset (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organization (id)
                    on delete cascade,
  name              text not null,
  storage_path      text,                    -- Supabase Storage object path
  file_sha256       text,
  provenance        jsonb not null default '{}'::jsonb,
  validation_status dataset_validation_status not null default 'pending',
  uploaded_by       uuid references auth.users (id),
  uploaded_at       timestamptz not null default now()
);

create table compilation_run (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organization (id)
                    on delete cascade,
  name              text not null,           -- '2024 Annual, first release'
  description       text,
  frequency         period_frequency not null,
  method_version_id uuid not null references method_version (id),
  -- Which approach anchors balancing; SNA 2008 §2.164ff on discrepancies.
  anchor_approach   text not null default 'production'
                    check (anchor_approach in
                      ('production', 'expenditure', 'income', 'none')),
  status            run_status not null default 'draft',
  created_by        uuid references auth.users (id),
  created_at        timestamptz not null default now(),
  unique (org_id, name)
);

-- A series is a coordinate in the SNA data cube. Dimensions are nullable —
-- P.3 by COICOP has no activity; B.1g by ISIC has no product. Identity is the
-- full tuple, so UNIQUE NULLS NOT DISTINCT is required (PG15+).
create table time_series (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organization (id)
                    on delete cascade,
  transaction_code  text not null references transaction_code (code),
  activity_item_id  uuid references classification_item (id),
  product_item_id   uuid references classification_item (id),
  sector_item_id    uuid references classification_item (id),
  purpose_item_id   uuid references classification_item (id), -- COICOP/COFOG
  price_basis       price_basis not null default 'current',
  valuation         valuation_basis,         -- null where not meaningful
  frequency         period_frequency not null,
  unit_code         text not null references unit (code),
  description       text,
  created_at        timestamptz not null default now(),
  unique nulls not distinct
    (org_id, transaction_code, activity_item_id, product_item_id,
     sector_item_id, purpose_item_id, price_basis, valuation, frequency)
);

create index time_series_org_txn_idx on time_series (org_id, transaction_code);
create index time_series_activity_idx on time_series (activity_item_id)
  where activity_item_id is not null;

-- Requirement 1: never mutate historical data in place. A vintage is the unit
-- of publication and freezing; corrections while open, immutable once frozen.
create table data_vintage (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organization (id)
                        on delete cascade,
  run_id                uuid references compilation_run (id),
  name                  text not null,       -- 'first estimate', 'revision 1'
  supersedes_vintage_id uuid references data_vintage (id),
  frozen_at             timestamptz,
  published             boolean not null default false,
  embargo_until         timestamptz,
  created_by            uuid references auth.users (id),
  created_at            timestamptz not null default now(),
  check (not published or frozen_at is not null)  -- can't publish unfrozen
);

create table observation (
  id                bigint generated always as identity primary key,
  org_id            uuid not null references organization (id)
                    on delete cascade,
  series_id         uuid not null references time_series (id)
                    on delete cascade,
  period_id         uuid not null references reference_period (id),
  vintage_id        uuid not null references data_vintage (id),
  value             numeric(20,6),           -- null = explicit missing
  origin            observation_origin not null default 'source',
  source_dataset_id uuid references source_dataset (id),
  created_by        uuid references auth.users (id),
  created_at        timestamptz not null default now(),
  unique (series_id, period_id, vintage_id)
);

create index observation_vintage_idx on observation (vintage_id);
create index observation_series_period_idx on observation (series_id, period_id);

-- Immutability once the parent vintage is frozen.
create function private.reject_if_vintage_frozen()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_vintage uuid := case when tg_op = 'DELETE'
                         then old.vintage_id else new.vintage_id end;
  v_frozen  timestamptz;
begin
  select frozen_at into v_frozen
    from public.data_vintage where id = v_vintage;
  if v_frozen is not null then
    raise exception 'vintage % is frozen; observations are immutable — create a new vintage',
      v_vintage;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger observation_frozen_guard
  before insert or update or delete on observation
  for each row execute function private.reject_if_vintage_frozen();

-- A frozen vintage row itself may only flip published (post-embargo) — never
-- un-freeze, never change embargo after freezing.
create function private.guard_vintage_update()
returns trigger
language plpgsql
as $$
begin
  if old.frozen_at is not null then
    if new.frozen_at is distinct from old.frozen_at
       or new.embargo_until is distinct from old.embargo_until
       or new.run_id is distinct from old.run_id
       or new.supersedes_vintage_id is distinct from old.supersedes_vintage_id then
      raise exception 'frozen vintage % may only change its published flag', old.id;
    end if;
  end if;
  return new;
end;
$$;

create trigger data_vintage_update_guard
  before update on data_vintage
  for each row execute function private.guard_vintage_update();

-- Audit triggers on every audited table (attach in milestone order).
create trigger audit_organization      after insert or update or delete on organization
  for each row execute function private.audit_row();
create trigger audit_membership        after insert or update or delete on membership
  for each row execute function private.audit_row();
create trigger audit_compilation_run   after insert or update or delete on compilation_run
  for each row execute function private.audit_row();
create trigger audit_data_vintage      after insert or update or delete on data_vintage
  for each row execute function private.audit_row();
create trigger audit_observation       after insert or update or delete on observation
  for each row execute function private.audit_row();
create trigger audit_source_dataset    after insert or update or delete on source_dataset
  for each row execute function private.audit_row();
create trigger audit_classification    after insert or update or delete on classification
  for each row execute function private.audit_row();
create trigger audit_mapping           after insert or update or delete on classification_mapping
  for each row execute function private.audit_row();
create trigger audit_mapping_entry     after insert or update or delete on classification_mapping_entry
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- §6 Row-Level Security
-- -----------------------------------------------------------------------------
-- FORCE on every tenant table: even the table owner goes through policies.
-- App runtime connects as `authenticated` via the pooled connection with
-- request.jwt.claims SET LOCAL per transaction (see PLAN.md, stack challenge 1).

-- Tenancy -------------------------------------------------------------------
alter table organization enable row level security;
alter table organization force row level security;

create policy org_select on organization for select
  using (private.is_org_member(id));
-- No INSERT policy: organizations are created only via the SECURITY DEFINER
-- RPC public.create_organization(name, slug, fiscal_year_start_month), which
-- inserts the org and the creator's admin membership atomically. (An insert
-- policy + AFTER-trigger bootstrap fails subtly: INSERT ... RETURNING must
-- also pass the SELECT policy, and the trigger-created membership does not
-- exist yet at RETURNING time. See migration 0001 for the implementation.)
create policy org_update on organization for update
  using (private.has_org_role(id, 'admin'));
create policy org_delete on organization for delete
  using (private.has_org_role(id, 'admin'));

alter table membership enable row level security;
alter table membership force row level security;

create policy membership_select on membership for select
  using (private.is_org_member(org_id));
create policy membership_write on membership for all
  using (private.has_org_role(org_id, 'admin'))
  with check (private.has_org_role(org_id, 'admin'));

-- Audit ---------------------------------------------------------------------
alter table audit_log enable row level security;
alter table audit_log force row level security;

-- Read: org-scoped entries for members; inserts happen only via the
-- SECURITY DEFINER trigger, so no insert policy for app roles.
create policy audit_select on audit_log for select
  using (org_id is not null and private.is_org_member(org_id));

-- Reference data ------------------------------------------------------------
-- World-readable; writable only via service/migration scripts (no policies
-- granting writes to app roles). Classifications additionally allow tenant
-- writes on their own custom rows.
alter table currency         enable row level security;
alter table country          enable row level security;
alter table unit             enable row level security;
alter table transaction_code enable row level security;
alter table method_version   enable row level security;

create policy currency_read  on currency         for select using (true);
create policy country_read   on country          for select using (true);
create policy unit_read      on unit             for select using (true);
create policy txn_read       on transaction_code for select using (true);
create policy method_read    on method_version   for select using (true);

alter table classification enable row level security;
alter table classification force row level security;
create policy classification_select on classification for select
  using (owner_org_id is null or private.is_org_member(owner_org_id));
create policy classification_write on classification for all
  using (owner_org_id is not null
         and private.has_org_role(owner_org_id, 'admin', 'compiler'))
  with check (owner_org_id is not null
              and private.has_org_role(owner_org_id, 'admin', 'compiler'));

-- Versions/items inherit visibility from their classification.
create function private.can_read_classification(p_classification uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.classification c
    where c.id = p_classification
      and (c.owner_org_id is null or private.is_org_member(c.owner_org_id))
  );
$$;

create function private.can_write_classification(p_classification uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.classification c
    where c.id = p_classification
      and c.owner_org_id is not null
      and private.has_org_role(c.owner_org_id, 'admin', 'compiler')
  );
$$;

alter table classification_version enable row level security;
alter table classification_version force row level security;
create policy clsver_select on classification_version for select
  using (private.can_read_classification(classification_id));
create policy clsver_write on classification_version for all
  using (private.can_write_classification(classification_id))
  with check (private.can_write_classification(classification_id));

create function private.can_read_version(p_version uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.classification_version v
                 where v.id = p_version
                   and private.can_read_classification(v.classification_id));
$$;

create function private.can_write_version(p_version uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.classification_version v
                 where v.id = p_version
                   and private.can_write_classification(v.classification_id));
$$;

alter table classification_item enable row level security;
alter table classification_item force row level security;
create policy clsitem_select on classification_item for select
  using (private.can_read_version(version_id));
create policy clsitem_write on classification_item for all
  using (private.can_write_version(version_id))
  with check (private.can_write_version(version_id));

alter table classification_mapping enable row level security;
alter table classification_mapping force row level security;
create policy mapping_select on classification_mapping for select
  using (owner_org_id is null or private.is_org_member(owner_org_id));
create policy mapping_write on classification_mapping for all
  using (owner_org_id is not null
         and private.has_org_role(owner_org_id, 'admin', 'compiler'))
  with check (owner_org_id is not null
              and private.has_org_role(owner_org_id, 'admin', 'compiler'));

create function private.can_read_mapping(p_mapping uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.classification_mapping m
                 where m.id = p_mapping
                   and (m.owner_org_id is null
                        or private.is_org_member(m.owner_org_id)));
$$;

create function private.can_write_mapping(p_mapping uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.classification_mapping m
                 where m.id = p_mapping
                   and m.owner_org_id is not null
                   and private.has_org_role(m.owner_org_id, 'admin', 'compiler'));
$$;

alter table classification_mapping_entry enable row level security;
alter table classification_mapping_entry force row level security;
create policy mapentry_select on classification_mapping_entry for select
  using (private.can_read_mapping(mapping_id));
create policy mapentry_write on classification_mapping_entry for all
  using (private.can_write_mapping(mapping_id))
  with check (private.can_write_mapping(mapping_id));

-- Compilation core ----------------------------------------------------------
-- Uniform pattern: members read; compiler/admin write. Reviewer-only
-- transitions (approval, publication) are milestone 7 and will be enforced
-- with dedicated policies/functions on the status columns.

do $$
declare
  t text;
begin
  foreach t in array array['reference_period', 'source_dataset',
                           'compilation_run', 'time_series',
                           'data_vintage', 'observation']
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

-- =============================================================================
-- Milestone-1 acceptance test (implemented as a Vitest integration suite):
--   seed org A (users a_admin, a_viewer) and org B (b_admin);
--   authenticated as each user through the production pooled-connection path,
--   assert: every tenant table returns only own-org rows; direct PK probes of
--   the other org's rows return zero rows (not errors that leak existence);
--   a_viewer cannot write anywhere; audit_log rejects UPDATE/DELETE; writes
--   without app.reason fail on audited tables.
-- =============================================================================
