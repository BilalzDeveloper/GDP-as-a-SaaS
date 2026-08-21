-- Migration 0011 — every compiled figure records the observations behind it
--
-- Milestone 5 asks to "drill from an aggregate down to contributing source
-- records". Until now only per-industry aggregates could: the run page looked
-- observations up by activity_item_id, which happens to match how the
-- assembler groups industries. Household final consumption, capital
-- formation, net exports, compensation of employees — none of them had a way
-- back to the rows they were summed from.
--
-- WHY RECORD IT RATHER THAN LOOK IT UP. Two reasons, and the second is the
-- stronger.
--
--   1. It is not derivable from a transaction code any more. Final
--      consumption is resolved by institutional sector (D46) and FISIM
--      arrives on codes of its own (D45), so which rows fed a figure is a
--      question about the assembler's rules rather than about the data.
--   2. A run pins its method version, and non-negotiable 1 says a published
--      figure must be re-computable from stored inputs plus that method. A
--      drill-down that re-derived provenance from today's code would answer a
--      question about today's rules, not about the run in front of the
--      reviewer. Recording it makes the answer as reproducible as the figure.
--
-- Like compilation_result itself this is derived output: rewritten wholesale
-- on every execution, not audited, and reproducible from the vintage and the
-- method version.

create table result_source (
  id             bigint generated always as identity primary key,
  org_id         uuid not null references organization (id) on delete cascade,
  result_id      bigint not null references compilation_result (id) on delete cascade,
  observation_id bigint not null references observation (id) on delete cascade,
  unique (result_id, observation_id)
);

-- Reading always starts from the figure the reviewer clicked.
create index result_source_result_idx on result_source (result_id);
-- And the reverse — "what did this observation end up in" — is the question
-- an auditor asks about a source record they distrust.
create index result_source_observation_idx on result_source (observation_id);

comment on table result_source is
  'The observations that produced one compilation_result row, recorded at '
  'execution by the code that did the summing. Not re-derived at read time: '
  'a run pins its method version, so its provenance must be as fixed as its '
  'figures.';

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
-- Same shape as the table it hangs off. Provenance names which source records
-- lie behind a pre-release estimate, so it is exactly as market-sensitive as
-- the estimate and gets the same isolation.

grant select, insert, update, delete on result_source to authenticated;

alter table result_source enable row level security;
alter table result_source force row level security;

create policy result_source_select on result_source
  for select using (private.is_org_member(org_id));

create policy result_source_write on result_source
  for all using (private.has_org_role(org_id, 'admin', 'compiler'))
  with check (private.has_org_role(org_id, 'admin', 'compiler'));
