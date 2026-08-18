# Compilation workflow

Milestone 5: create a run, execute it over committed observations, see GDP by
all three approaches with the statistical discrepancy between them, and drill
from any aggregate down to the source records that produced it.

```
vintage of observations → assemble → engine → results + diagnostics
                                                  ↓
                        drill-down: result → observation → staging row → file
```

## A run is a named exercise

"2024 Annual Estimates, first release". It pins two things:

- **Its input vintage**, fixed at creation. The run reads that vintage's
  observations and nothing else.
- **Its method version**, fixed at execution: engine semver, git SHA where
  available, and the full config (balancing anchor, discrepancy threshold).

Those two plus the stored observations are what makes a published figure
re-computable (non-negotiable 1). `method_version` rows are immutable — a
trigger refuses updates and deletes — because a method that could change
afterwards would pin nothing.

Runs move `draft → computing → computed | failed`. Execution is synchronous
today, but the status field exists so moving it to a background worker is a
change of caller, not of schema — which matters because Vercel caps function
time and a 400-industry run may not fit in a request (PLAN.md, challenge 3).

## The assembler will not guess

`src/compile/assemble.ts` is pure — no database imports — and turns
observations into engine inputs. Its most important behaviour is what it
refuses to do:

- **A missing required component withholds the whole approach.** If the
  expenditure account has no P.7, no expenditure GDP is produced. A total
  assembled from an incomplete account is not approximately right; it is wrong
  in a way that looks entirely plausible in a published table.
- **Producers'-price output is refused**, matching the engine (D19): the
  conversion needs the embedded tax and subsidy amounts, which are not in the
  data.
- **Mixed units are flagged**, never summed.
- **Absent D.21 withholds production GDP** — value added at basic prices
  cannot become GDP at market prices without it.

Genuinely optional components are the exception and are treated as zero with
a diagnostic: NPISH consumption (several countries fold it into households),
changes in inventories, and valuables.

Every refusal is written to `compilation_diagnostic` against the run, so the
reason a figure is absent sits next to the figures that are present.

## Results

`compilation_result` is long format — `(run, period, approach, measure,
activity_item_id, value)` — because breakdowns vary by country and a wide
table would not survive the first customer with a different one. The `measure`
vocabulary is in `src/compile/measures.ts`.

Per-industry rows carry `activity_item_id`; totals leave it null. Summary rows
hold the headline GDP and one statistical-discrepancy row per approach.

## The discrepancy is reported, not removed

The run's anchor decides which approach is published as the headline. Every
other approach is stored with its discrepancy — anchor minus that approach, so
a positive figure means the approach falls short of the headline. Nothing is
adjusted to make them agree: balancing belongs in the supply-and-use process,
and averaging would destroy the most informative signal a compiler has
(DECISIONS.md D17).

## Drill-down

From a per-industry value added on the run page, "sources" walks:

```
compilation_result (activity, period)
  → observation      (same activity, period, run's vintage)
  → staging_row      (the row as parsed, with its line number)
  → source_dataset   (filename and SHA-256)
```

so a reviewer asking "where did this 300 come from?" gets the two source rows
that produced it, the file they came from, and the checksum of the exact bytes.

## Re-executing

Results and diagnostics are replaced wholesale on each execution — a run has
one current set of results, not an accumulating pile. Re-executing the same
run over the same vintage produces identical figures, which is asserted in the
test suite rather than assumed.
