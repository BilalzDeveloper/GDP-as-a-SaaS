-- Migration 0007 — Quarterly accounts and benchmarking (milestone 8)
--
-- Quarterly compilation itself needed no schema: `reference_period` has
-- carried a frequency since 0003 and `compilation_run` has carried one since
-- 0004, so a quarterly run already reads quarterly observations and computes
-- all three approaches on them. What is new is BENCHMARKING — reconciling
-- those quarterly estimates to the annual accounts.
--
-- Three things follow from that.
--
-- 1. A quarterly run needs to name the annual run it is benchmarked to. That
--    reference is provenance, not configuration: a published quarterly figure
--    is only reproducible if the annual totals it was forced to sum to are
--    identified exactly, and an annual run identifies them along with the
--    vintage and method version behind them.
--
-- 2. A benchmarked result and the unbenchmarked indicator it came from are
--    both worth keeping. The indicator is what the source data said; the
--    benchmarked figure is what gets published; the ratio between them is how
--    a compiler judges whether the indicator is any good. So `benchmarked`
--    joins price_basis as part of a result's identity rather than replacing
--    the row.
--
-- 3. Every benchmark constraint that was applied is recorded, with what it
--    required and what the benchmarked quarters actually sum to. That residual
--    is zero by construction; storing it means an auditor can confirm the
--    constraint held rather than taking the method's word for it.

set check_function_bodies = off;

-- -----------------------------------------------------------------------------
-- Benchmarking settings on a run
-- -----------------------------------------------------------------------------

alter table compilation_run
  -- The annual run whose results are the benchmark totals. Null means the
  -- quarterly figures are published unbenchmarked, which is a legitimate
  -- state — the annual accounts for the current year do not exist yet.
  add column benchmark_source_run_id uuid references compilation_run (id),
  add column benchmark_method text not null default 'denton_proportional'
    check (benchmark_method in
      ('denton_proportional', 'denton_additive', 'none')),
  -- A run cannot be benchmarked to itself, and only a quarterly run can be
  -- benchmarked at all.
  add constraint compilation_run_benchmark_not_self
    check (benchmark_source_run_id is distinct from id);

comment on column compilation_run.benchmark_source_run_id is
  'The annual compilation run supplying the totals this quarterly run is '
  'benchmarked to. Part of the run''s provenance: a published quarterly '
  'figure is reproducible only if the annual totals behind it are identified.';

comment on column compilation_run.benchmark_method is
  'Denton first-difference variant. Proportional preserves growth rates and '
  'is the default; additive preserves changes in level and is the right '
  'choice for a series that crosses zero. See DECISIONS.md D33.';

-- -----------------------------------------------------------------------------
-- Benchmarked results
-- -----------------------------------------------------------------------------
-- Existing rows are all unbenchmarked by construction: nothing before this
-- migration could produce a benchmarked figure.

alter table compilation_result
  add column benchmarked boolean not null default false;

comment on column compilation_result.benchmarked is
  'False for the indicator as compiled from source data; true for the figure '
  'after reconciliation to annual totals. Both are kept: the ratio between '
  'them is how a compiler judges the indicator.';

alter table compilation_result
  drop constraint compilation_result_identity_key;

alter table compilation_result
  add constraint compilation_result_identity_key
  unique nulls not distinct
    (run_id, period_id, approach, measure, activity_item_id, price_basis,
     benchmarked);

-- -----------------------------------------------------------------------------
-- The constraints that were applied
-- -----------------------------------------------------------------------------

create table benchmark_constraint (
  id                bigint generated always as identity primary key,
  org_id            uuid not null references organization (id) on delete cascade,
  run_id            uuid not null references compilation_run (id) on delete cascade,
  /* The annual period supplying the total. */
  annual_period_id  uuid not null references reference_period (id),
  approach          compilation_approach not null,
  measure           text not null,
  activity_item_id  uuid references classification_item (id),
  /* What the annual run said. */
  annual_total      numeric(20,6) not null,
  /* What the unbenchmarked quarters summed to, before reconciliation. */
  indicator_total   numeric(20,6) not null,
  /* What the benchmarked quarters sum to. Equal to annual_total. */
  benchmarked_total numeric(20,6) not null,
  /* annual_total − benchmarked_total. Zero, and stored so it can be checked. */
  residual          numeric(20,6) not null,
  created_at        timestamptz not null default now(),
  unique nulls not distinct
    (run_id, annual_period_id, approach, measure, activity_item_id)
);

create index benchmark_constraint_run_idx
  on benchmark_constraint (run_id, annual_period_id);

-- -----------------------------------------------------------------------------
-- Audit
-- -----------------------------------------------------------------------------
-- Like compilation_result and compilation_diagnostic, benchmark_constraint is
-- derived output rewritten wholesale on every execution and reproducible from
-- the run's pins. Not audited, for the same reason.

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------

grant select, insert, update, delete on benchmark_constraint to authenticated;

alter table benchmark_constraint enable row level security;
alter table benchmark_constraint force row level security;

create policy benchmark_constraint_select on benchmark_constraint for select
  using (private.is_org_member(org_id));

create policy benchmark_constraint_write on benchmark_constraint for all
  using (private.has_org_role(org_id, 'admin', 'compiler'))
  with check (private.has_org_role(org_id, 'admin', 'compiler'));

-- -----------------------------------------------------------------------------
-- Cross-tenant safety on the benchmark reference
-- -----------------------------------------------------------------------------
-- `benchmark_source_run_id` points at another row in compilation_run. RLS
-- stops a member of org A from SELECTing org B's run, but a foreign key is
-- checked by the system and does not consult policies: without this trigger a
-- compiler who guessed a UUID could attach another tenant's annual run to
-- their own, and the totals would leak into their results. Non-negotiable 3
-- says that is a catastrophic failure, so it is blocked at the row level
-- rather than trusted to the application.

create or replace function private.check_benchmark_source_same_org()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_source_org uuid;
  v_source_frequency period_frequency;
begin
  if new.benchmark_source_run_id is null then
    return new;
  end if;

  select org_id, frequency into v_source_org, v_source_frequency
    from compilation_run where id = new.benchmark_source_run_id;

  if v_source_org is null or v_source_org <> new.org_id then
    raise exception
      'The benchmark source run does not belong to this organization'
      using errcode = 'check_violation';
  end if;

  if new.frequency = 'annual' then
    raise exception
      'An annual run is not benchmarked; benchmarking reconciles a '
      'higher-frequency series to annual totals'
      using errcode = 'check_violation';
  end if;

  if v_source_frequency <> 'annual' then
    raise exception
      'The benchmark source must be an annual run, not a % one',
      v_source_frequency
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger check_benchmark_source
  before insert or update of benchmark_source_run_id, frequency
  on compilation_run
  for each row execute function private.check_benchmark_source_same_org();
