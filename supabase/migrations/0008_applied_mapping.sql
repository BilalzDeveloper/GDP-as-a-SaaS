-- Migration 0008 — Record the mapping a dataset was actually staged with
--
-- Found by the end-to-end suite (tests/e2e/compile.spec.ts), which walked the
-- intake flow the way a compiler does and could not get past Commit.
--
-- The bug had two halves, and the second is the serious one.
--
-- 1. `column_mapping` holds NAMED, reusable mappings — the point being that a
--    recurring monthly extract is mapped once rather than every month. Naming
--    one is optional in the interface, and rightly so: a one-off file does not
--    need a library entry. But `commitStaged` read the mapping back out of
--    that library, so a compiler who skipped the optional name could stage and
--    validate a dataset and then find Commit refusing, with a message that did
--    not say the name was the problem.
--
-- 2. Worse: it read the organization's MOST RECENTLY SAVED mapping, whichever
--    dataset that belonged to. Map dataset A, map dataset B differently, then
--    commit A — and A's rows would be interpreted with B's mapping. Silently.
--    Every value could land under the wrong transaction code, the wrong
--    industry or the wrong period, and nothing in the interface would say so.
--
-- The mapping a dataset was staged with is a property of that dataset, not of
-- the organization's mapping library. It is also part of the dataset's
-- provenance: the bytes plus the mapping are what produced the observations,
-- so reproducing a figure needs both (non-negotiable 1).

alter table source_dataset
  add column applied_mapping jsonb;

comment on column source_dataset.applied_mapping is
  'The column mapping this dataset was last staged with. Part of provenance: '
  'the file bytes and this mapping together are what produced the '
  'observations. Distinct from column_mapping, which is the organization''s '
  'library of named, reusable mappings.';

-- Backfill is deliberately not attempted. Existing rows were staged before
-- this column existed and there is no record of which library entry was used —
-- inventing one would be a guess written into provenance. Those datasets can
-- be re-mapped, which is one click and leaves an accurate record.
