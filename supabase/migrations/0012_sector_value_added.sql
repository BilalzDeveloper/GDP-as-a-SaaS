-- Migration 0012 — value added by institutional sector
--
-- SNA 2008 ch.4: every producer belongs both to an industry (what it makes)
-- and to an institutional sector (what kind of unit it is), so the production
-- account can be summed either way from the same records. Chapter 14's supply
-- and use tables present both cuts side by side, and general government or
-- household value added is a table most offices publish.
--
-- The sector dimension has been on `time_series` since migration 0003 and has
-- resolved final consumption since 0010's successor work (D46). This gives it
-- a second reader: a per-sector cut of value added.
--
-- WHAT IT IS NOT. It is value added, never GDP. Taxes and subsidies on
-- products are levied on products rather than on producers and cannot be
-- attributed to an institutional sector (SNA 2008 §7.88), so there is no
-- sector figure to add them to. The engine computes no sector GDP and this
-- table stores none.
--
-- The figures are also computed BEFORE the FISIM and imputed-rent
-- adjustments, which are attributed to industries and have no sector to go
-- to. The engine compares the sector total against the industries as supplied
-- so that the coverage check compares like with like, and reports
-- `sector_value_added_incomplete` when producers carry no sector.

alter table compilation_result
  add column sector_item_id uuid references classification_item (id);

comment on column compilation_result.sector_item_id is
  'Set on the per-sector cut of value added; null on every other row. '
  'A row never carries both an activity and a sector: they are two '
  'groupings of the same producers, not two dimensions of one figure.';

-- A result's identity gains the sector, exactly as it gained price_basis in
-- 0005 and benchmarked in 0007. Without this the per-sector rows would
-- collide with each other on the existing key.
alter table compilation_result
  drop constraint compilation_result_identity_key;

alter table compilation_result
  add constraint compilation_result_identity_key
  unique nulls not distinct (run_id, period_id, approach, measure,
                             activity_item_id, sector_item_id, price_basis,
                             benchmarked);

create index compilation_result_sector_idx on compilation_result (sector_item_id)
  where sector_item_id is not null;
