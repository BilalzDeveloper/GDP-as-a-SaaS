# Quarterly accounts and benchmarking

Milestone 8. Quarterly GDP compiled from sub-annual source data, reconciled to
the annual accounts by the Denton method.

The methodological reference is the IMF *Quarterly National Accounts Manual*
(Bloem, Dippelsman and Mæhle, 2001; second edition 2017), chapter 6. SNA 2008
chapter 28 covers quarterly accounts and defers to that manual for
benchmarking method, so the citations in `src/engine/benchmark.ts` point there.

---

## Why benchmarking exists

Annual and quarterly national accounts are built from different sources.

The annual accounts rest on the best available material: structural business
surveys with high coverage, audited government accounts, full-year tax and
customs records, sometimes a census. They arrive late — often a year or more
after the period they describe — and they are what the country is held to.

The quarterly accounts rest on indicators: a monthly turnover survey, VAT
receipts, employment, electricity consumption, port throughput. They arrive
within weeks. They track *movement* well and *level* badly.

So a quarterly series compiled straight from its indicators will not sum to the
annual figure for the same year. Publishing both without reconciling them puts
two different numbers for the same year into the public record, and the office
is then asked which one is right in front of a parliamentary committee. There
is only one acceptable answer: the quarters must sum to the year, exactly.

The question is how to make them.

## What Denton does that prorating does not

The obvious approach is to prorate: take each year's annual total and split it
across that year's quarters in the indicator's proportions. The quarters then
sum correctly.

It also introduces a defect. Each year gets one uniform adjustment, and the
adjustment changes at the turn of the year. If the indicator over-states 2023
by 2% and under-states 2024 by 3%, prorating shrinks every quarter of 2023 by
the same factor and inflates every quarter of 2024 by another — so the growth
rate from 2023-Q4 to 2024-Q1 picks up the whole 5% swing between the two
adjustments. That step is an artefact of the method. Nothing in the economy
did it, and it lands squarely on the quarter-on-quarter growth rate that gets
quoted in the news.

Denton (1971) removes it by asking for the *smoothest* adjustment that still
meets every annual total, over the whole series at once rather than year by
year. Formally, for the proportional variant, with indicator `I` and published
series `X`, writing the adjustment as a ratio `r = X / I`:

```
minimise    Σ (r_t − r_t−1)²
subject to  Σ_{t in year y} I_t · r_t = A_y     for every year y
```

The constraint is the annual accounts. The objective is "change the adjustment
as little as possible from one quarter to the next". The result absorbs the
same annual revisions but spreads them across the series instead of stacking
them at the year boundaries.

`tests/engine/benchmark.test.ts` asserts this directly: given a flat indicator
and annual totals of 4 and 8, prorating would give ratios `1, 1, 1, 1, 2, 2, 2,
2`; Denton gives a strictly increasing sequence with no step larger than 0.5.

## The two variants

Both are first-difference forms. They differ in what "the adjustment" means.

| | Preserves | Use for |
|---|---|---|
| **Proportional** (default) | period-to-period **growth rates** | almost everything |
| **Additive** | period-to-period **changes in level** | series that cross zero |

Proportional is the QNA manual's recommendation and what nearly every office
uses. It is the default here.

Additive exists for the case proportional cannot handle. Changes in inventories
(P.52) is the standard example: the annual figure is a small net of large gross
movements, so the indicator crosses zero, and a *ratio* to something near zero
is unstable while a ratio to something negative inverts the adjustment. Where
the indicator sums to zero over a year, proportional Denton has no solution at
all — no constant multiple of zero reaches a non-zero total — and the engine
refuses rather than returning a number.

The engine reports a warning when a proportional run meets a series that
changes sign, naming the series, so the compiler can re-run it additively.

**Not implemented, deliberately:** the second-difference forms Denton also
defined, and the Cholette–Dagum family, which generalises the problem to allow
for autocorrelated and heteroscedastic indicator error. The QNA manual's own
judgement is that first-difference proportional is sufficient in practice.
Recorded as D33.

## How it is solved

As a constrained least-squares problem, through the Lagrangian stationarity
conditions:

```
[ Q   −C' ] [ x ]   [ 0 ]
[ C    0  ] [ λ ] = [ a ]
```

where `Q = D'D` for the first-difference operator `D`, `C` carries the
aggregation constraints, and `a` the annual totals. That is one linear solve —
`solveLinearSystem` in `src/engine/numeric.ts`, Gaussian elimination with
partial pivoting, written out in full rather than pulled from a matrix library
so the part a statistician most wants to check stays in the repo.

No iteration, no convergence criterion, no tuning parameter. For a given
indicator and set of totals there is exactly one answer, which is what makes a
published quarterly figure reproducible.

Two of the tests check the solve against answers derived on paper rather than
from the code, so a wrong implementation fails with a number that can be
verified by hand. The clearest: an indicator flat at 1 over two two-period
years with totals 2 and 4 has the closed-form solution `5/6, 7/6, 11/6, 13/6`.

## Extrapolation past the last annual year

The current year has no annual accounts yet — that is the normal state of a
quarterly compilation. Those quarters are included in the objective and in no
constraint, so minimising the change in the adjustment carries the last
adjustment forward unchanged. That is Denton's standard extrapolation, and it
falls out of the same arithmetic rather than being a separate rule bolted on.

The same fact handles quarters *before* the first annual benchmark: the first
adjustment is carried backwards.

Extrapolated quarters are flagged in the results and named in an `info`
diagnostic, because they will be revised when the annual accounts for those
years are compiled. That is expected behaviour for quarterly accounts, not a
defect in the figures, and the UI says so.

## How quarters are grouped into years

By the `fiscal_year` column on `reference_period`, set when the period was
defined — never by parsing the period label.

A fiscal year does not start in January everywhere. Australia runs July to
June, India April to March, the United States federal year October to
September. Deriving a year from the string `2024-Q3` would give the right
answer for some tenants and a quietly wrong one for others, which is precisely
the failure mode non-negotiable 4 exists to prevent.

The engine never sees a date at all: `dentonBenchmark` takes a `benchmarkKey`
per period and treats it as opaque. The mapping from quarter to key is made in
`src/compile/benchmark.ts`, against the database.

## What the compilation layer does

A quarterly run names an **annual run** as its benchmark source. Not a set of
numbers — a run, which carries its own input vintage, pinned engine version and
method configuration. That reference is provenance: a published quarterly
figure is reproducible only if the annual totals it was forced to sum to are
identified exactly, along with what produced them.

Both the benchmark source and the variant go into the run's pinned
`method_version` config, so re-executing against a different annual run is
visibly a different method rather than a silent change of figures.

Every quarterly series with an annual counterpart of the same
(approach, measure, industry) is benchmarked. Series with no counterpart are
left as compiled and reported in an `info` diagnostic — published
unbenchmarked and flagged as such, not silently dropped.

**Statistical discrepancies are never benchmarked.** A discrepancy is the
difference between two estimates, not a flow with an annual total of its own;
forcing quarterly discrepancies to sum to an annual discrepancy would be
meaningless arithmetic on a residual, and a series hovering around zero is the
worst possible input to proportional Denton besides.

### Both figures are kept

`compilation_result.benchmarked` distinguishes the indicator as compiled from
the figure after reconciliation. Both rows are stored for the same cell.

The unbenchmarked row is not clutter. The ratio between the two is how a
compiler judges whether the indicator is doing its job: a small, steady
adjustment means the quarterly source tracks the annual movement; a large or
lurching one means it does not, and the office should be looking for a better
indicator rather than trusting the reconciled series. A run whose largest
adjustment exceeds 10% gets a warning saying exactly that.

### Benchmarked components do not add up across a quarter

Each series is benchmarked on its own — univariate Denton, as the QNA manual
describes. Nothing ties the components to their aggregate *within* a quarter,
so benchmarked industries do not sum exactly to benchmarked total value added,
even though each series sums correctly down its own year.

This is the same situation as the non-additivity of chained volumes, and it
gets the same treatment: the residual is measured and reported in an `info`
diagnostic rather than removed. Forcing the components to sum would mean
altering published industry figures to preserve an identity the method does not
deliver.

The multivariate extensions that would preserve the cross-sectional identities
as well (Di Fonzo–Marini; Cholette–Dagum with contemporaneous constraints) are
not implemented. Recorded as D35.

## What is *not* done: seasonal adjustment

These series are benchmarked, not seasonally adjusted.

Seasonal adjustment is a separate discipline with its own established tools —
X-13ARIMA-SEATS, TRAMO/SEATS — and its own decisions about outliers, calendar
effects, and revision policy. None of it is implemented here, and a
benchmarked series must not be presented as though it were.

The consequence is stated in the UI next to the growth rates:
quarter-on-quarter movements carry the seasonal pattern as well as the
underlying change, which is why the **year-on-year** column is the one usually
quoted — comparing a quarter with the same quarter a year earlier cancels the
seasonal pattern without adjusting anything.

Recorded as D36.

## Reconciliation is stored, not asserted

Every constraint applied is written to `benchmark_constraint`: the annual
total required, what the indicator summed to before reconciliation, what the
benchmarked quarters sum to, and the residual between them.

The residual is zero by construction. It is stored anyway, and shown in the UI,
so an auditor can confirm the constraint held from the data rather than taking
the method's word for it. The indicator total is stored alongside so the size
of the adjustment is recoverable from the database alone, without re-running
anything.

## Exports

Both exporters carry `benchmarked` as a dimension:

- **SDMX-CSV** gains a `BENCHMARKED` column (`true`/`false`). Deliberately not
  sent as SDMX's `ADJUSTMENT` concept, which means seasonal and calendar
  adjustment — neither of which this is. Conformance remains unverified
  (D31).
- **Excel** gains a *Benchmarked* column on the current-prices sheet, with a
  note under the data explaining which rows to publish.

## Diagnostics this produces

| Code | Severity | Means |
|---|---|---|
| `not_benchmarked` | info | Quarterly run with no benchmark source chosen |
| `benchmark_unavailable` | warning | The chosen annual run has no results yet |
| `benchmark_no_match` | warning | No quarterly series had an annual counterpart |
| `benchmark_partial` | info | Some series had no counterpart, left as compiled |
| `benchmark_failed` | warning | One series could not be solved — names it and why |
| `benchmark_sign_change` | warning | Proportional Denton on a series that crosses zero |
| `benchmark_extrapolated` | info | Quarters past the last annual year, named |
| `benchmark_large_adjustment` | warning | Largest adjustment above 10% of the indicator |
| `benchmark_components_not_additive` | info | Benchmarked industries do not sum across a quarter |

## Tenant isolation

`benchmark_source_run_id` is a foreign key to another row in
`compilation_run`. RLS stops a member of one organization from *selecting*
another's run, but a foreign key is checked by the system and does not consult
policies — so without further protection a compiler who guessed a UUID could
attach another tenant's annual run to their own, and those totals would appear
in their results.

A `BEFORE INSERT OR UPDATE` trigger blocks it, along with two other states that
are simply meaningless: benchmarking an annual run, and benchmarking against a
run that is not annual. `tests/compile/quarterly.test.ts` exercises all three
plus the self-reference case.

## Running it

1. Define quarterly **and** annual reference periods for the organization, with
   matching `fiscal_year` values.
2. Upload and commit the annual source data; create and execute an **annual**
   run.
3. Upload and commit the quarterly source data.
4. Create a **quarterly** run, choosing the executed annual run under
   *Benchmark to* and a variant under *Benchmarking method*.
5. Execute. The run page shows the quarterly path — indicator, benchmarked
   figure, ratio, quarter-on-quarter and year-on-year growth — followed by the
   reconciliation table and the diagnostics.
