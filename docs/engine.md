# Calculation engine

`src/engine/` computes GDP by the production, expenditure and income
approaches under SNA 2008. It is pure: no database imports, no I/O, no npm
dependencies, no environment access. A test (`tests/engine/purity.test.ts`)
enforces that mechanically, because the property is easy to state and easy to
erode with one convenient import.

The engine now covers all eight milestones' worth of calculation:

- **Current prices**, all three approaches, with reconciliation and the
  statistical discrepancy (this document).
- **Volume measures** — deflation, index numbers, chain-linking by annual
  overlap. See [`volume-measures.md`](volume-measures.md).
- **Temporal benchmarking** — Denton first-difference, both variants, for
  reconciling quarterly series to annual totals. See
  [`quarterly-accounts.md`](quarterly-accounts.md).

Everything stays inside the purity boundary, including the linear solver
benchmarking needs — `solveLinearSystem` in `numeric.ts` is written out rather
than pulled from a matrix library, so the arithmetic a statistician would want
to audit stays in the repo.

## Status: internally consistent, not yet externally validated

The engine agrees with itself — 93 tests covering the identities, the
invariants, FISIM, imputed rent and the reconciliation machinery. It has
**not** been checked against a published set of national accounts, because
this environment cannot reach `unstats.un.org`, `dst.dk` or `ec.europa.eu`.

Please read [`tests/engine/fixtures/README.md`](../tests/engine/fixtures/README.md)
before relying on any figure. Adding one official fixture is the single
highest-value next step for confidence in this module.

## Using it

```ts
import { compileGdp } from '@/engine';

const result = compileGdp(
  { production, expenditure, income },
  { anchor: 'production' },
);

result.gdp;          // the published figure, per the anchor
result.approaches;   // each approach's estimate and its discrepancy
result.diagnostics;  // things a compiler should look at
```

Every component identity is also exported on its own (`grossValueAdded`,
`finalConsumptionExpenditure`, `totalFactorIncomes`, …) so a compilation can
be traced step by step rather than treated as a black box.

## The identities

**Production** (SNA 2008 ch.6, ch.7)

```
B.1g (industry) = P.1 − P.2
GDP at market prices = Σ B.1g at basic prices + D.21 − D.31
```

**Expenditure** (SNA 2008 ch.9, ch.10, ch.14)

```
GDP = P.31(S.14) + P.31(S.15) + P.3(S.13)
    + P.51g + P.52 + P.53
    + P.6 − P.7
```

**Income** (SNA 2008 ch.7)

```
GDP = D.1 + B.2g + B.3g + D.2 − D.3
```

## Citation policy — please read

The brief asks every function to cite the SNA 2008 paragraph or the standard
practice it implements, and says these will be checked against the manual.

Citations here are **chapter-level, not paragraph-level**, and each function
states the identity or definition it implements in full. This is deliberate:
the code was written without access to the manual, and a paragraph number
recalled from memory is exactly what a reader checking against the text would
catch. A wrong pinpoint is worse than an honest chapter reference, because it
looks verified.

Pinning paragraph numbers is a review pass to run with the manual open. The
same convention applies to `transaction_code.sna2008_ref` in the database,
which carries a `ref_verified` flag for recording that check.

## Conventions the caller must know

**Signs.** Imports (P.7) and subsidies (D.31, D.3) are supplied as positive
amounts and subtracted by the engine, so the convention lives in one place.
Passing them pre-negated double-negates and inflates GDP; the engine emits a
diagnostic when it sees a negative figure in those fields. Changes in
inventories (P.52) and net acquisitions of valuables (P.53) are genuinely
signed and are accepted either way.

**Valuation.** GDP is derived from value added at **basic prices**. Output at
producers' prices is refused, not silently accepted — convert it explicitly
with `basicPricesFromProducers(output, taxesIncluded, subsidiesExcluded)`.
The brief requires valuation conversions to be explicit, and the engine
cannot infer the embedded tax and subsidy amounts.

**FISIM.** `IndustryInput.intermediateConsumption` must **exclude** FISIM
allocated to that industry; the engine applies the allocation from the
`fisim` input. Supplying FISIM-inclusive intermediate consumption alongside a
`fisim` input double-counts it. A compilation supplies both this and
`imputedRent` on the `FISIM.*` and `IMPRENT.*` codes — see
`docs/data-intake.md` and D45.

**Units.** The engine never converts units or currencies. Every figure in one
compilation must be in the same unit — see the `unit` registry, where the
multiplier is explicit for this reason.

## Methodological variants

| Choice | Default | Alternative |
|---|---|---|
| FISIM | `allocated` — SNA 2008: the portion consumed by producers is intermediate (GDP-neutral), the portion consumed by households, government and non-residents is final use (raises GDP) | `unallocated` — SNA 1993 convention: the whole of FISIM is intermediate consumption of a nominal industry and contributes nothing to GDP. Callers choosing this must also exclude FISIM from final consumption. |
| Balancing anchor | `production` when available | `expenditure`, `income`, or `none` (report all three, publish no headline). Full supply-and-use balancing is out of scope until milestone 5. |
| Discrepancy warning | 1% of the headline | any threshold via `discrepancyWarningThreshold` |
| Chain-linking | annual overlap (D25) | one-quarter overlap, over-the-year linking — identical for annual data |
| Benchmarking | Denton proportional first-difference (D33) | Denton additive, for series that cross zero. Second-difference forms and Cholette–Dagum are not implemented. |
| Seasonal adjustment | **not implemented** (D36) | X-13ARIMA-SEATS or TRAMO/SEATS, outside this engine |

The engine **never** reconciles the approaches by adjusting them. It reports
what each says and quantifies the gap. Averaging or forcing agreement would
destroy the most informative signal a compiler has.

## Diagnostics

Returned alongside results rather than thrown, so one questionable input does
not block a whole compilation:

| Code | Raised when |
|---|---|
| `fisim_allocation_mismatch` | FISIM allocations do not sum to FISIM output |
| `imputed_rent_not_in_expenditure` | Imputed rent is in production but household consumption excludes it, or the caller has not confirmed either way |
| `negative_value_added` | An industry's B.1g is negative — occasionally genuine, usually a sign or mapping error |
| `component_missing` | FISIM allocated to an unknown industry, or a pre-negated import/subsidy figure |
| `approaches_diverge` | A discrepancy exceeds the configured threshold |

## Numeric policy

Doubles internally, `NUMERIC(20,6)` at rest, rounding once at publication
(DECISIONS.md D3). Summation is Neumaier-compensated: adding hundreds of
industry figures of very different magnitudes with naive summation
accumulates error that surfaces as a phantom statistical discrepancy, which a
compiler would then waste real time investigating.

`roundForPublication` rounds half away from zero — what statistical
publications do and what a reader checking by hand expects — unlike
`Math.round`, which sends −0.5 to −0.

## Versioning

`ENGINE_VERSION` is pinned into `method_version` when a compilation runs, so
any published figure can be re-computed from stored inputs plus a stored
method version (non-negotiable 1). **Bump it on any change that alters a
computed result**, and record why in `DECISIONS.md`.
