-- Migration 0009 — Memorandum items, so population has somewhere to live
--
-- The brief asks for "per-capita GDP and growth rates". Per-capita needs a
-- population figure, and there was nowhere to put one.
--
-- WHY IT GOES THROUGH THE OBSERVATION MODEL. Population could have been a
-- column on `organization`, or its own little table. It is neither, for the
-- same reason deflators are not (DECISIONS.md D27): a population figure is a
-- statistic with a period, a source, a vintage and a revision history, and
-- everything that makes GDP reproducible has to apply to it too. A published
-- per-capita figure is only re-computable if the population behind it is
-- pinned to the same frozen vintage as the GDP — a number edited in a
-- settings field would break that on the first revision.
--
-- So population arrives as an ordinary uploaded observation, on a series whose
-- unit is a count (PERSONS, PERSONS_TH — both already in the unit registry
-- since milestone 2). No new intake path, no new isolation surface.
--
-- WHY THE CODE TABLE NEEDS A `kind`. A series is keyed by a transaction code,
-- and population is not a transaction. SNA 2008 treats population and labour
-- inputs as memorandum items presented alongside the accounts (ch.19 on
-- population and labour inputs; ch.20 §20.2 on per-capita presentation), not
-- as flows within them. Filing `POP` in a table called `transaction_code`
-- without saying so would make the vocabulary quietly wrong, and the
-- distinction is load-bearing: the assembler must never sweep a memorandum
-- item into a GDP aggregate.

alter table transaction_code
  add column kind text not null default 'transaction'
    check (kind in ('transaction', 'memorandum'));

comment on column transaction_code.kind is
  'transaction — an SNA flow that can enter a GDP aggregate. memorandum — a '
  'statistic presented alongside the accounts (population, labour inputs) '
  'that must never be summed into one. The assembler reads named transaction '
  'codes only, so a memorandum item cannot reach an aggregate by accident; '
  'this column is what lets validation say so out loud.';

-- Seeded here rather than in seeds/transaction-codes.csv alone, so a database
-- migrated but not re-seeded still has somewhere to put a population figure.
insert into transaction_code (code, name, sna2008_ref, description, sort_order, kind)
values (
  'POP',
  'Total population',
  'SNA 2008 ch.19; presentation per ch.20 §20.2',
  'Mid-year (or period-average) resident population. A memorandum item, not a '
  'transaction: it is never summed into an aggregate, and is used only as the '
  'denominator of per-capita measures.',
  900,
  'memorandum'
)
on conflict (code) do update
  set name = excluded.name,
      sna2008_ref = excluded.sna2008_ref,
      description = excluded.description,
      sort_order = excluded.sort_order,
      kind = excluded.kind;
