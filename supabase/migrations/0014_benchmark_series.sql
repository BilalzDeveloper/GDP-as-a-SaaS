-- Migration 0014 — a series rather than a snapshot, and the oil split
--
-- Migration 0013 held one year. Two things need more than that:
--
--   * Growth. A single year says how big an economy is and nothing about
--     where it is going, which is the question an insights page exists to
--     answer. Year-on-year growth is derived from adjacent periods rather
--     than stored, so it cannot disagree with the levels it came from.
--   * The oil split. Every GCC statistical office publishes oil and non-oil
--     value added as separate headlines, because the two behave completely
--     differently: one tracks a price set outside the country, the other
--     tracks the diversification the region measures itself by. A ranking by
--     total GDP hides exactly that.
--
-- The oil and non-oil figures are VALUE ADDED at basic prices. They do not
-- sum to GDP at market prices — taxes less subsidies on products sit between
-- the two — and the interface says so rather than inviting the subtraction.

alter table benchmark_observation
  drop constraint benchmark_observation_indicator_check;

alter table benchmark_observation
  add constraint benchmark_observation_indicator_check
  check (indicator in ('gdp_current_usd', 'population',
                       'oil_gva_usd', 'non_oil_gva_usd'));

comment on column benchmark_observation.indicator is
  'gdp_current_usd — nominal GDP at market prices. population — mid-year. '
  'oil_gva_usd / non_oil_gva_usd — value added at BASIC prices for the '
  'petroleum sector and the rest of the economy; these two sum to gross '
  'value added, not to GDP.';
