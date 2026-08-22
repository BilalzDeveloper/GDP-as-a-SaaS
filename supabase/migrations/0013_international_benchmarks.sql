-- Migration 0013 — international benchmarks
--
-- Published GDP figures for other economies, so a compiler can put their own
-- estimate beside the ones the world already has. Two uses:
--
--   * Context. An office compiling for the first time wants to know whether
--     its total is the right order of magnitude before anyone publishes it.
--   * The beginnings of an answer to D16. The engine has never been checked
--     against published national accounts; comparing a compiled figure with
--     the published one for the same country and period is where that check
--     starts. It is not the check itself — a headline total agreeing proves
--     far less than the components agreeing — but it is the first screen.
--
-- REFERENCE DATA, NOT TENANT DATA. These are public figures about countries,
-- not anybody's pre-release estimate. Every authenticated reader sees the same
-- rows, exactly as they do the classifications, and no runtime code writes
-- them: they arrive by seed or by the loader script.
--
-- PROVENANCE IS PART OF THE TABLE. A figure whose source is unrecorded is
-- worse than no figure in this application, so the source carries a name, a
-- URL, a retrieval date and a `verified` flag — the same treatment migration
-- 0002 gives a classification version (D12). The seeded set ships
-- `verified = false` and says so wherever it is displayed.

create table benchmark_source (
  code         text primary key,
  name         text not null,
  url          text,
  retrieved_at date,
  /* False until the figures came from the official file rather than from a
     transcription. The interface must say so while it is false. */
  verified     boolean not null default false,
  note         text not null
);

create table benchmark_observation (
  id            bigint generated always as identity primary key,
  source_code   text not null references benchmark_source (code) on delete cascade,
  country_iso3  text not null references country (iso3),
  indicator     text not null
                check (indicator in ('gdp_current_usd', 'population')),
  period_label  text not null,
  value         numeric(20,6) not null,
  unit_code     text not null references unit (code),
  unique (source_code, country_iso3, indicator, period_label)
);

comment on table benchmark_observation is
  'Published international figures, for context beside a tenant''s own '
  'compilation. Per-capita is derived from these two indicators rather than '
  'stored, so the three can never disagree.';

create index benchmark_observation_lookup_idx
  on benchmark_observation (indicator, period_label);

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
-- Readable by every authenticated user, writable by none. The same shape the
-- reference tables use: seeds arrive through a privileged connection, and no
-- application code may write here.

grant select on benchmark_source, benchmark_observation to authenticated;

alter table benchmark_source enable row level security;
alter table benchmark_source force row level security;
create policy benchmark_source_read on benchmark_source for select using (true);

alter table benchmark_observation enable row level security;
alter table benchmark_observation force row level security;
create policy benchmark_observation_read on benchmark_observation
  for select using (true);
