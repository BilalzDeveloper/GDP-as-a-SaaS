-- Migration 0002 — Reference data (milestone 2)
-- Currencies, countries, units, SNA transaction codes, and the generic
-- classification structure (ISIC, CPC, COICOP, COFOG, institutional sectors)
-- plus the tenant mapping layer for national adaptations.
--
-- Non-negotiable 4: classifications are DATA, not enums. A 10-industry
-- aggregate and a 400-industry detailed compilation are two rows in
-- classification_version, not two code paths.

set check_function_bodies = off;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type classification_kind as enum (
  'activity',              -- ISIC and national activity classifications
  'product',               -- CPC and national product classifications
  'consumption_purpose',   -- COICOP
  'government_function',   -- COFOG
  'institutional_sector',  -- S.11 … S.2 (SNA 2008 ch.4)
  'geography',
  'other'
);

-- How a version's contents got into the database. NSOs must be able to tell
-- audited-official data from data awaiting verification — see DECISIONS.md D12.
create type reference_provenance as enum (
  'official_file',                     -- parsed from the published source file;
                                       -- URL, sha256 and retrieval date recorded
  'transcribed_pending_verification',  -- hand-entered from the published
                                       -- structure; must be diffed against the
                                       -- official file before publication use
  'tenant_defined'                     -- a tenant's own national adaptation
);

-- -----------------------------------------------------------------------------
-- Units, currencies, countries
-- -----------------------------------------------------------------------------

create table currency (
  code        char(3) primary key,          -- ISO 4217 alphabetic
  name        text not null,
  minor_units smallint not null default 2 check (minor_units between 0 and 4)
);

create table country (
  iso3          char(3) primary key,        -- ISO 3166-1 alpha-3
  iso2          char(2) not null unique,    -- ISO 3166-1 alpha-2
  name          text not null,
  currency_code char(3) references currency (code)
);

alter table organization
  add constraint organization_country_fk
  foreign key (country_code) references country (iso3);

-- "GBP millions" = (unit_type currency, currency GBP, multiplier 1e6).
-- Keeping the multiplier explicit stops the classic scale error where a
-- source in thousands is added to a series in millions.
create table unit (
  code          text primary key,
  name          text not null,
  unit_type     text not null
                check (unit_type in ('currency', 'index', 'count', 'other')),
  currency_code char(3) references currency (code),
  multiplier    numeric(20,6) not null default 1 check (multiplier > 0),
  -- Currency units may be generic (national currency, resolved per compilation)
  -- or pinned to one currency; non-currency units must not name a currency.
  check (unit_type = 'currency' or currency_code is null)
);

-- -----------------------------------------------------------------------------
-- SNA transaction and balancing-item codes
-- -----------------------------------------------------------------------------
-- sna2008_ref is chapter-level unless the paragraph has been checked against
-- the manual; ref_verified records whether that check has happened. The brief
-- says these will be checked against the manual — this column is where that
-- review is recorded rather than assumed.

create table transaction_code (
  code         text primary key,            -- 'P.1', 'B.1g', 'D.21', …
  name         text not null,
  sna2008_ref  text not null,
  ref_verified boolean not null default false,
  description  text,
  sort_order   integer not null default 0
);

-- -----------------------------------------------------------------------------
-- Classifications
-- -----------------------------------------------------------------------------

create table classification (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,               -- 'ISIC4', 'CPC21', 'NACE-XX'
  name         text not null,
  kind         classification_kind not null,
  -- NULL = system-wide standard; set = a tenant's own classification.
  owner_org_id uuid references organization (id) on delete cascade,
  based_on_id  uuid references classification (id),
  created_at   timestamptz not null default now(),
  unique nulls not distinct (code, owner_org_id)
);

create table classification_version (
  id                  uuid primary key default gen_random_uuid(),
  classification_id   uuid not null references classification (id)
                      on delete cascade,
  version_label       text not null,        -- 'Rev.4', '2.1', '1999', 'v2024'
  valid_from          date,
  is_current          boolean not null default false,
  provenance          reference_provenance not null,
  source_url          text,
  source_file_sha256  char(64),
  source_retrieved_at timestamptz,
  -- Deepest hierarchy level present. ISIC seeded to divisions = 2; the full
  -- official file goes to class level = 4. The UI must not imply completeness
  -- beyond this.
  seeded_to_level     smallint not null default 1 check (seeded_to_level >= 1),
  notes               text,
  created_at          timestamptz not null default now(),
  unique (classification_id, version_label),
  -- Claiming official provenance requires the evidence for it.
  constraint official_needs_evidence check (
    provenance <> 'official_file'
    or (source_url is not null
        and source_file_sha256 is not null
        and source_retrieved_at is not null)
  )
);

create table classification_item (
  id         uuid primary key default gen_random_uuid(),
  version_id uuid not null references classification_version (id)
             on delete cascade,
  code       text not null,                 -- '01', '0111', 'S.11', 'A'
  name       text not null,
  parent_id  uuid references classification_item (id) on delete cascade,
  level      smallint not null default 1 check (level >= 1),
  sort_order integer not null default 0,
  unique (version_id, code)
);

create index classification_item_parent_idx on classification_item (parent_id);
create index classification_item_version_level_idx
  on classification_item (version_id, level, sort_order);

-- A parent must live in the same version — a hierarchy spanning versions
-- would silently corrupt every aggregation built on it.
create function private.check_item_parent()
returns trigger
language plpgsql
as $$
declare
  v_parent_version uuid;
begin
  if new.parent_id is null then
    return new;
  end if;
  select version_id into v_parent_version
    from public.classification_item where id = new.parent_id;
  if v_parent_version is distinct from new.version_id then
    raise exception 'parent item % belongs to a different classification version',
      new.parent_id;
  end if;
  return new;
end;
$$;

create trigger classification_item_parent_guard
  before insert or update on classification_item
  for each row execute function private.check_item_parent();

-- Drill-down helper. A hierarchy self-join must constrain BOTH sides by
-- version_id: the parent is guaranteed to be in the same version (enforced by
-- classification_item_parent_guard above), but the planner cannot know that,
-- so it hash-joins against every item of every tenant. Measured in the risk-3
-- spike at 12k items: 3.98 ms with a 12,368-row sequential scan versus 0.59 ms
-- using the index, and the gap widens with each additional tenant. Application
-- code should read hierarchies through this function rather than hand-rolling
-- the join. See DECISIONS.md D14.
create function public.classification_tree(p_version uuid)
returns table (
  item_id     uuid,
  code        text,
  name        text,
  level       smallint,
  sort_order  integer,
  parent_id   uuid,
  parent_code text
)
language sql stable security invoker
set search_path = public, pg_catalog
as $$
  select child.id, child.code, child.name, child.level, child.sort_order,
         child.parent_id, parent.code
    from classification_item child
    left join classification_item parent
      on parent.id = child.parent_id
     and parent.version_id = child.version_id   -- keeps the index in play
   where child.version_id = p_version
   order by child.sort_order;
$$;

-- -----------------------------------------------------------------------------
-- Tenant mapping layer
-- -----------------------------------------------------------------------------
-- Maps a national/custom version onto a standard version. Weights support
-- 1-to-many splits (one national code feeding several ISIC codes).

create table classification_mapping (
  id              uuid primary key default gen_random_uuid(),
  owner_org_id    uuid not null references organization (id) on delete cascade,
  name            text not null,
  from_version_id uuid not null references classification_version (id),
  to_version_id   uuid not null references classification_version (id),
  -- Set once the mapping passes validation; only activated mappings may be
  -- used by a compilation run (enforced from milestone 5).
  activated_at    timestamptz,
  created_at      timestamptz not null default now(),
  check (from_version_id <> to_version_id)
);

create table classification_mapping_entry (
  id           uuid primary key default gen_random_uuid(),
  mapping_id   uuid not null references classification_mapping (id)
               on delete cascade,
  from_item_id uuid not null references classification_item (id),
  to_item_id   uuid not null references classification_item (id),
  weight       numeric(9,6) not null default 1
               check (weight > 0 and weight <= 1),
  unique (mapping_id, from_item_id, to_item_id)
);

create index mapping_entry_from_idx
  on classification_mapping_entry (mapping_id, from_item_id);

-- Validation is a query, not a constraint: partial drafts must be saveable,
-- and the weights-sum-to-one rule only has to hold at activation. Returns one
-- row per problem; an empty result means the mapping is sound.
create function public.validate_classification_mapping(p_mapping uuid)
returns table (problem text, item_code text, detail text)
language sql stable security invoker
set search_path = public, pg_catalog
as $$
  -- Entries whose weights do not sum to 1 (tolerance 1e-6 for rounding).
  select 'weights_do_not_sum_to_one',
         fi.code,
         'sum = ' || round(sum(e.weight), 6)::text
    from classification_mapping_entry e
    join classification_item fi on fi.id = e.from_item_id
   where e.mapping_id = p_mapping
   group by fi.code
  having abs(sum(e.weight) - 1) > 0.000001

  union all
  -- Source items with no mapping at all: their values would vanish.
  select 'unmapped_source_item', fi.code, 'no entry in this mapping'
    from classification_mapping m
    join classification_item fi on fi.version_id = m.from_version_id
   where m.id = p_mapping
     and not exists (select 1 from classification_mapping_entry e
                      where e.mapping_id = p_mapping
                        and e.from_item_id = fi.id)

  union all
  -- Entries pointing outside the mapping's declared versions.
  select 'entry_outside_declared_versions',
         coalesce(fi.code, ti.code),
         'from_version/to_version mismatch'
    from classification_mapping m
    join classification_mapping_entry e on e.mapping_id = m.id
    left join classification_item fi on fi.id = e.from_item_id
    left join classification_item ti on ti.id = e.to_item_id
   where m.id = p_mapping
     and (fi.version_id is distinct from m.from_version_id
          or ti.version_id is distinct from m.to_version_id);
$$;

-- Activation is gated on validation passing.
create function public.activate_classification_mapping(p_mapping uuid)
returns void
language plpgsql security invoker
set search_path = public, pg_catalog
as $$
declare
  v_problems integer;
begin
  select count(*) into v_problems
    from public.validate_classification_mapping(p_mapping);
  if v_problems > 0 then
    raise exception 'mapping % has % validation problem(s); run validate_classification_mapping to see them',
      p_mapping, v_problems using errcode = 'P0001';
  end if;
  update public.classification_mapping
     set activated_at = now()
   where id = p_mapping;
end;
$$;

-- -----------------------------------------------------------------------------
-- Audit triggers
-- -----------------------------------------------------------------------------
-- Tenant-owned reference data is audited like any other tenant data. The
-- system-wide tables (currency/country/unit/transaction_code) are seeded by
-- migration scripts, not by users, so they are not audited.

create trigger audit_classification
  after insert or update or delete on classification
  for each row execute function private.audit_row();
create trigger audit_classification_mapping
  after insert or update or delete on classification_mapping
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------

-- Shared reference tables: readable by every signed-in user, writable only by
-- migration/seed scripts (no write policies, no write grants for app roles).
grant select on currency, country, unit, transaction_code to authenticated, anon;

alter table currency         enable row level security;
alter table country          enable row level security;
alter table unit             enable row level security;
alter table transaction_code enable row level security;

create policy currency_read  on currency         for select using (true);
create policy country_read   on country          for select using (true);
create policy unit_read      on unit             for select using (true);
create policy txn_read       on transaction_code for select using (true);

-- Classifications: standards (owner_org_id null) are world-readable; tenant
-- classifications follow membership, and only admin/compiler may write.
grant select, insert, update, delete
  on classification, classification_version, classification_item,
     classification_mapping, classification_mapping_entry
  to authenticated;
grant execute on function public.classification_tree(uuid) to authenticated;
grant execute on function public.validate_classification_mapping(uuid)
  to authenticated;
grant execute on function public.activate_classification_mapping(uuid)
  to authenticated;

alter table classification enable row level security;
alter table classification force row level security;

create policy classification_select on classification for select
  using (owner_org_id is null or private.is_org_member(owner_org_id));
create policy classification_write on classification for all
  using (owner_org_id is not null
         and private.has_org_role(owner_org_id, 'admin', 'compiler'))
  with check (owner_org_id is not null
              and private.has_org_role(owner_org_id, 'admin', 'compiler'));

-- Versions and items inherit visibility from their classification. Helpers
-- are SECURITY DEFINER for the same reason as milestone 1's (DECISIONS.md D7):
-- the policy would otherwise re-enter RLS on the parent table.
create function private.can_read_classification(p_classification uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.classification c
    where c.id = p_classification
      and (c.owner_org_id is null or private.is_org_member(c.owner_org_id))
  );
$$;

create function private.can_write_classification(p_classification uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.classification c
    where c.id = p_classification
      and c.owner_org_id is not null
      and private.has_org_role(c.owner_org_id, 'admin', 'compiler')
  );
$$;

create function private.can_read_version(p_version uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.classification_version v
    where v.id = p_version and private.can_read_classification(v.classification_id)
  );
$$;

create function private.can_write_version(p_version uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.classification_version v
    where v.id = p_version and private.can_write_classification(v.classification_id)
  );
$$;

alter table classification_version enable row level security;
alter table classification_version force row level security;
create policy clsver_select on classification_version for select
  using (private.can_read_classification(classification_id));
create policy clsver_write on classification_version for all
  using (private.can_write_classification(classification_id))
  with check (private.can_write_classification(classification_id));

alter table classification_item enable row level security;
alter table classification_item force row level security;
create policy clsitem_select on classification_item for select
  using (private.can_read_version(version_id));
create policy clsitem_write on classification_item for all
  using (private.can_write_version(version_id))
  with check (private.can_write_version(version_id));

-- Mappings are always tenant-owned.
alter table classification_mapping enable row level security;
alter table classification_mapping force row level security;
create policy mapping_select on classification_mapping for select
  using (private.is_org_member(owner_org_id));
create policy mapping_write on classification_mapping for all
  using (private.has_org_role(owner_org_id, 'admin', 'compiler'))
  with check (private.has_org_role(owner_org_id, 'admin', 'compiler'));

create function private.can_read_mapping(p_mapping uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.classification_mapping m
    where m.id = p_mapping and private.is_org_member(m.owner_org_id)
  );
$$;

create function private.can_write_mapping(p_mapping uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.classification_mapping m
    where m.id = p_mapping
      and private.has_org_role(m.owner_org_id, 'admin', 'compiler')
  );
$$;

alter table classification_mapping_entry enable row level security;
alter table classification_mapping_entry force row level security;
create policy mapentry_select on classification_mapping_entry for select
  using (private.can_read_mapping(mapping_id));
create policy mapentry_write on classification_mapping_entry for all
  using (private.can_write_mapping(mapping_id))
  with check (private.can_write_mapping(mapping_id));
