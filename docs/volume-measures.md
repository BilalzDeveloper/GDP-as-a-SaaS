# Volume measures

Milestone 6: separating a change in value into a change in price and a change
in volume. SNA 2008 chapter 15.

```
value change = price change × volume change
```

Every formula here is a way of splitting that product, and the choice of
formula is a choice about how.

## Start here: chained volumes do not add up

If you read one section, read this one. Users report it as a bug; it is not.

A chain-linked aggregate is **not** the sum of its chain-linked components,
except in the reference period and the one immediately after it. The run page
shows the gap in a **Residual** column and explains it in place.

The reason is weights. Each series is revalued at its *own* previous period's
prices before being linked, so every series carries a different set of price
weights. Adding series with different weights does not give the aggregate,
which carries the weights of the whole economy. The parts agree in the
reference period because everything is valued at the same prices there, and
in the period after because the first link uses those same reference-year
prices for every component. From the second link onward they diverge.

Forcing the components to sum would mean changing each industry's published
volume to preserve an arithmetic property the measure does not have.
Publishing the residual instead is standard practice among national
statistical offices, and it is what this system does. Current-price figures
*are* additive, and are shown alongside.

`nonAdditivityResidual()` computes the gap; the engine test suite demonstrates
it numerically, including the contrast case: with a single common fixed-base
deflator, chaining collapses to fixed-base deflation and additivity returns.
That is not a workaround — it is the same fact seen from the other side.

## Index formulas

All three are implemented, and the choice is per run.

| Formula | Weights | Notes |
|---|---|---|
| **Laspeyres** | base-period quantities (price index) / base-period prices (volume index) | The common practical choice; needs only base-period weights |
| **Paasche** | current-period weights | Implied as the deflator whenever a Laspeyres volume series is published |
| **Fisher** | geometric mean of the two | Superlative; needs both periods' prices *and* quantities at the compiling detail, which many compilations do not have |

The properties the test suite pins down, because they are the strongest
available check that the formulas are right:

- **Factor reversal** — Fisher price × Fisher volume = the change in value,
  exactly. Neither Laspeyres nor Paasche does this alone, but the crosses do:
  Laspeyres price × Paasche volume = the value change, and vice versa.
- **Time reversal** — Fisher forward × Fisher backward = 1. Laspeyres does
  *not* satisfy this, and the suite asserts that it does not, so nobody
  "fixes" it later.
- An item present in only one period contributes to no bilateral index: there
  is no price relative to compute. It is excluded rather than treated as a
  zero, which would send the index to nonsense.

## Deflators are ordinary observations

No separate intake path. A deflator is an observation on a series whose unit
has `unit_type = 'index'` (the `deflator_series` view), sharing the transaction
code and activity of the series it deflates. The deflator for industry C's
value added is therefore a `B.1g` series for activity C denominated in
`INDEX`.

This falls out of the unit registry already distinguishing an index from a
currency amount, so uploading deflators uses the same CSV/XLSX path, the same
validation and the same vintage as any other data.

## Chain-linking: annual overlap

Each period's volume movement is measured at the previous period's prices, and
those links are multiplied into a continuous series:

```
PYP_t = V_t × (P_{t−1} / P_t)     value at the previous period's prices
L_t   = PYP_t / V_{t−1}           the year-on-year volume link
CI_t  = CI_{t−1} × L_t            the chain index, 100 at the reference period
```

Weights are therefore never more than one period out of date — the point of
chaining, since a fixed-base series drifts as the economy's structure moves
away from its base year.

**The aggregate is linked from its components, not from an aggregate
deflator**, which is what `chainLinkAggregate()` does:

```
L_t = Σ_i PYP_{i,t} / Σ_i V_{i,t−1}
```

This matters. Applying a single aggregate deflator to an aggregate value would
give a *fixed-base* result that happens to be additive, and would quietly lose
the compositional change that chaining exists to capture.

Annual overlap is the variant used by most European compilers. One-quarter
overlap and over-the-year linking differ only for sub-annual data, where they
trade a step in the quarterly path against exact consistency with annual
totals. For annual data all three coincide (DECISIONS.md D25).

## Running volumes

Set a **volume reference period** when creating a run, and optionally an index
formula. The run then chain-links each industry's value added and the
aggregate, and stores everything with `price_basis = 'chain_linked'` alongside
the current-price results.

If deflators are missing, the run still produces current prices and records a
`no_deflators` diagnostic rather than failing — volume measures are opt-in and
many first compilations do not have deflators yet.
