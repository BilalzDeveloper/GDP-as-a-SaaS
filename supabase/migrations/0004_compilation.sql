-- Migration 0004 — Compilation workflow (milestone 5)
--
-- A compilation run is a named exercise ("2024 Annual Estimates, first
-- release") that reads observations from a vintage, executes the engine, and
-- stores what came out.
--
-- Non-negotiable 1 (reproducibility): a run pins BOTH its input vintage and
-- its method_version (engine semver + full config). Those two plus the stored
-- observations are sufficient to re-compute any published figure.

set check_function_bodies = off;

create type run_status as enum (
  'draft',        -- created, no results yet
  'computing',    -- execution in progress
  'computed',     -- results available
  'failed',       -- execution raised; see error_message
  'under_review', -- milestone 7
  'approved',     -- milestone 7
  'published',    -- milestone 7
  'superseded'
);

create type compilation_approach as enum (
  'production', 'expenditure', 'income', 'summary'
);

-- -----------------------------------------------------------------------------
-- Method versions
-- -----------------------------------------------------------------------------
-- System-wide and append-only: pinning a method that could later change would
-- defeat the point. A row is created on demand for each (engine version,
-- config) pair actually used.

create table method_version (
  id             uuid primary key default gen_random_uuid(),
  engine_semver  text not null,
  engine_git_sha text,
  /* Balancing anchor, FISIM treatment, discrepancy threshold, and anything
   * else that changes a computed result. */
  config         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  unique nulls not distinct (engine_semver, engine_git_sha, config)
);

grant select on method_version to authenticated;
alter table method_version enable row level security;
create policy method_version_read on method_version for select using (true);

-- Method versions are immutable once created: a run that pinned one must be
-- re-computable from it forever.
create function private.reject_method_version_change()
returns trigger language plpgsql as
$$ begin
     raise exception 'method_version rows are immutable; create a new one'
       using errcode = 'P0001';
   end; $$;

create trigger method_version_immutable
  before update or delete on method_version
  for each row execute function private.reject_method_version_change();

-- Pinning a method version is find-or-create. App roles hold no INSERT grant
-- on the table — it is system-wide, not tenant-scoped, so letting any tenant
-- write rows directly would let one pollute a shared registry. This function
-- is the whole authorized surface: it takes no tenant input beyond the config
-- the engine itself produced, and returns the existing row when one matches.
-- See DECISIONS.md D23.
create function public.pin_method_version(
  p_engine_semver  text,
  p_engine_git_sha text,
  p_config         jsonb
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select id into v_id from public.method_version
   where engine_semver = p_engine_semver
     and engine_git_sha is not distinct from p_engine_git_sha
     and config = p_config;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.method_version (engine_semver, engine_git_sha, config)
  values (p_engine_semver, p_engine_git_sha, p_config)
  on conflict (engine_semver, engine_git_sha, config) do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost a race; the row now exists.
    select id into v_id from public.method_version
     where engine_semver = p_engine_semver
       and engine_git_sha is not distinct from p_engine_git_sha
       and config = p_config;
  end if;
  return v_id;
end;
$$;

revoke execute on function public.pin_method_version(text, text, jsonb) from public, anon;
grant execute on function public.pin_method_version(text, text, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- Runs
-- -----------------------------------------------------------------------------

create table compilation_run (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organization (id) on delete cascade,
  name              text not null,
  description       text,
  frequency         period_frequency not null,
  /** The vintage whose observations this run reads. */
  input_vintage_id  uuid not null references data_vintage (id),
  /** Pinned when the run executes, not when it is created. */
  method_version_id uuid references method_version (id),
  /* Which approach is published as the headline; see DECISIONS.md D17. */
  anchor_approach   text not null default 'production'
                    check (anchor_approach in
                      ('production', 'expenditure', 'income', 'none')),
  status            run_status not null default 'draft',
  error_message     text,
  executed_at       timestamptz,
  created_by        uuid references auth.users (id),
  created_at        timestamptz not null default now(),
  unique (org_id, name)
);

create index compilation_run_org_idx on compilation_run (org_id, created_at desc);

-- Which source datasets fed a run. The observations themselves carry
-- source_dataset_id, so this is the run's declared scope rather than the
-- derivation — kept because a compiler needs to state what was intended,
-- and a mismatch between intended and actual is itself worth seeing.
create table compilation_run_source (
  run_id     uuid not null references compilation_run (id) on delete cascade,
  dataset_id uuid not null references source_dataset (id) on delete cascade,
  org_id     uuid not null references organization (id) on delete cascade,
  primary key (run_id, dataset_id)
);

-- -----------------------------------------------------------------------------
-- Results
-- -----------------------------------------------------------------------------
-- Long format, deliberately: an NSO's breakdowns vary by country, so a wide
-- table would need a column per measure and would not survive the first
-- customer with a different one. `measure` is a small controlled vocabulary
-- (see src/compile/measures.ts); activity_item_id is set for per-industry
-- rows and null for totals.

create table compilation_result (
  id               bigint generated always as identity primary key,
  org_id           uuid not null references organization (id) on delete cascade,
  run_id           uuid not null references compilation_run (id) on delete cascade,
  period_id        uuid not null references reference_period (id),
  approach         compilation_approach not null,
  measure          text not null,
  activity_item_id uuid references classification_item (id),
  value            numeric(20,6),
  created_at       timestamptz not null default now(),
  unique nulls not distinct (run_id, period_id, approach, measure, activity_item_id)
);

create index compilation_result_run_idx on compilation_result (run_id, period_id);
create index compilation_result_activity_idx on compilation_result (activity_item_id)
  where activity_item_id is not null;

-- Engine diagnostics, kept with the run they came from: a figure and the
-- cautions attached to it belong together.
create table compilation_diagnostic (
  id         bigint generated always as identity primary key,
  org_id     uuid not null references organization (id) on delete cascade,
  run_id     uuid not null references compilation_run (id) on delete cascade,
  period_id  uuid references reference_period (id),
  severity   text not null check (severity in ('warning', 'info')),
  code       text not null,
  message    text not null,
  subject    text,
  created_at timestamptz not null default now()
);

create index compilation_diagnostic_run_idx on compilation_diagnostic (run_id);

-- -----------------------------------------------------------------------------
-- Audit
-- -----------------------------------------------------------------------------
-- Runs are audited. Results and diagnostics are not: they are derived output,
-- rewritten wholesale on every execution, and fully reproducible from the
-- pinned vintage and method version. Auditing them would bury the meaningful
-- entries without adding recoverable information.

create trigger audit_compilation_run
  after insert or update or delete on compilation_run
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------

grant select, insert, update, delete on
  compilation_run, compilation_run_source, compilation_result,
  compilation_diagnostic
  to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'compilation_run', 'compilation_run_source', 'compilation_result',
    'compilation_diagnostic'
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
