-- Migration 0005 — Volume measures (milestone 6)
--
-- Deflators arrive as ordinary observations: a series whose unit has
-- unit_type 'index'. No new intake path is needed — the unit registry already
-- distinguishes an index from a currency amount, and a deflator shares its
-- dimensions with the series it deflates.
--
-- Results gain a price_basis, so a current-price GDP and a chain-linked
-- volume GDP for the same period sit side by side rather than in separate
-- tables.

set check_function_bodies = off;

-- Existing rows are all current-price by construction.
alter table compilation_result
  add column price_basis price_basis not null default 'current';

-- The uniqueness of a result now includes its price basis.
alter table compilation_result
  drop constraint compilation_result_run_id_period_id_approach_measure_activi_key;

alter table compilation_result
  add constraint compilation_result_identity_key
  unique nulls not distinct
    (run_id, period_id, approach, measure, activity_item_id, price_basis);

-- Volume settings on a run. Null reference period means volumes were not
-- requested; the compiler opts in, because volume measures need deflators
-- that many first compilations do not yet have.
alter table compilation_run
  add column volume_reference_period_label text,
  add column volume_index_formula text
    check (volume_index_formula in ('laspeyres', 'paasche', 'fisher'));

comment on column compilation_run.volume_reference_period_label is
  'Period whose price level chain-linked volumes are expressed in, and where '
  'the chain index equals 100. Null means volumes were not computed.';

-- A deflator is an index-valued series. This view is the one place that
-- decision is written down, so a change of convention has a single site.
create view deflator_series as
  select ts.*
    from time_series ts
    join unit u on u.code = ts.unit_code
   where u.unit_type = 'index';

grant select on deflator_series to authenticated;
