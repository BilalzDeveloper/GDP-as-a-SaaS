-- Migration 0010 — FISIM and imputed rent get a way in
--
-- The brief asks, under the production approach: "Handle FISIM allocation, and
-- imputed rent for owner-occupied dwellings." The engine has handled both
-- since milestone 3 — `applyFisim` and `applyImputedRent` in
-- src/engine/production.ts, with the allocation check and the
-- imputed-rent-in-expenditure consistency diagnostic. What was missing was any
-- way to supply them: the assembler never populated `FisimInput` or
-- `ImputedRentInput`, so no real compilation could reach that code.
--
-- WHY NEW CODES. Both are adjustments to the ordinary P.1/P.2 figures, and the
-- engine needs them separately rather than folded in:
--
--   * FISIM, because it must check that the allocation exhausts the financial
--     corporations' FISIM output, and must add the intermediate portion to the
--     RIGHT industries. Handed FISIM-inclusive intermediate consumption it
--     would double-count (see the note on IndustryInput.intermediateConsumption).
--   * Imputed rent, because it is imputed — it appears as output of the
--     housing industry AND as household final consumption, and recording one
--     without the other is the classic compilation error the engine
--     diagnoses.
--
-- WHAT THESE CODES ARE, HONESTLY. SNA 2008 describes both adjustments (FISIM
-- in ch.6 and ch.17; owner-occupied dwelling services in ch.6, within the
-- production boundary) without assigning either a single transaction code of
-- the kind P.1 or D.21 are. ESA's transmission programme carries FISIM as a
-- component of output rather than as a transaction in its own right.
--
-- So these are THIS SYSTEM'S vocabulary for supplying an adjustment the
-- manual describes, not codes lifted from the manual. They are marked
-- `kind = 'adjustment'` and their descriptions say so. Pretending otherwise
-- would be the same failure as an unverified classification seed labelled as
-- the official file.

alter table transaction_code
  drop constraint transaction_code_kind_check;

alter table transaction_code
  add constraint transaction_code_kind_check
  check (kind in ('transaction', 'memorandum', 'adjustment'));

comment on column transaction_code.kind is
  'transaction — an SNA flow that can enter a GDP aggregate directly. '
  'memorandum — a statistic presented alongside the accounts (population, '
  'labour inputs) that must never be summed into one. adjustment — a '
  'compilation adjustment the SNA describes but gives no single transaction '
  'code for (FISIM, imputed rent); this system''s own vocabulary, applied by '
  'the engine rather than added to a total.';

insert into transaction_code (code, name, sna2008_ref, description, sort_order, kind)
values
  ('FISIM.P1',
   'FISIM output, total',
   'SNA 2008 ch.6 and ch.17 (this system''s code)',
   'Total financial intermediation services indirectly measured produced by '
   'financial corporations, already included in their P.1. The allocations '
   'below must sum to this figure; the engine reports it when they do not.',
   910, 'adjustment'),

  ('FISIM.P2',
   'FISIM allocated to intermediate consumption',
   'SNA 2008 ch.6 and ch.17 (this system''s code)',
   'FISIM consumed by a producing industry. Carries the industry it belongs '
   'to. GDP-neutral: it raises that industry''s intermediate consumption, '
   'exactly offsetting the financial corporations'' output already counted.',
   911, 'adjustment'),

  ('FISIM.P31',
   'FISIM in household final consumption',
   'SNA 2008 ch.6 and ch.17 (this system''s code)',
   'FISIM consumed by households as final consumers. Final use, so it raises '
   'GDP.',
   912, 'adjustment'),

  ('FISIM.P3',
   'FISIM in government final consumption',
   'SNA 2008 ch.6 and ch.17 (this system''s code)',
   'FISIM consumed by general government as final consumption. Final use, so '
   'it raises GDP.',
   913, 'adjustment'),

  ('FISIM.P6',
   'FISIM exported',
   'SNA 2008 ch.6 and ch.17 (this system''s code)',
   'FISIM supplied to non-residents. Final use, so it raises GDP.',
   914, 'adjustment'),

  ('IMPRENT.P1',
   'Imputed output of owner-occupied dwelling services',
   'SNA 2008 ch.6 (this system''s code)',
   'Housing services produced and consumed by owner-occupiers. Within the '
   'production boundary and imputed, so it appears both here and in household '
   'final consumption. Carries the industry that records it, typically ISIC '
   'division 68.',
   920, 'adjustment'),

  ('IMPRENT.P2',
   'Intermediate consumption of owner-occupied dwelling services',
   'SNA 2008 ch.6 (this system''s code)',
   'Maintenance, insurance and other inputs to the imputed production above. '
   'Must carry the same industry as IMPRENT.P1.',
   921, 'adjustment')
on conflict (code) do update
  set name = excluded.name,
      sna2008_ref = excluded.sna2008_ref,
      description = excluded.description,
      sort_order = excluded.sort_order,
      kind = excluded.kind;

-- -----------------------------------------------------------------------------
-- Run settings
-- -----------------------------------------------------------------------------
-- Both are methodological choices, so both go into the run's pinned
-- method_version config: changing either changes published figures, and must
-- be visibly a different method rather than a silent revision.

alter table compilation_run
  add column fisim_treatment text not null default 'allocated'
    check (fisim_treatment in ('allocated', 'unallocated')),
  -- Tri-state on purpose. NULL is "the compiler has not said", which is a
  -- different fact from "no" and gets its own diagnostic — the engine never
  -- adjusts household consumption on the caller's behalf.
  add column expenditure_includes_imputed_rent boolean;

comment on column compilation_run.fisim_treatment is
  'allocated — the SNA 2008 treatment: FISIM consumed by producers is '
  'intermediate (GDP-neutral), FISIM consumed by households, government and '
  'non-residents is final use and raises GDP. unallocated — the SNA 1993 '
  'convention still encountered: the whole of FISIM is intermediate '
  'consumption of a nominal industry and contributes nothing to GDP. A '
  'compilation choosing unallocated must also exclude FISIM from final '
  'consumption on the expenditure side.';

comment on column compilation_run.expenditure_includes_imputed_rent is
  'Whether the household final consumption figure supplied for this run '
  'already includes imputed rent for owner-occupied dwellings. Used only for '
  'a consistency check: imputed rent recorded as output but absent from '
  'expenditure would put the two approaches out of balance by exactly that '
  'amount. NULL means unstated, which is reported rather than assumed.';
