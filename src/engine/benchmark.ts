// Temporal benchmarking: reconciling a high-frequency indicator to
// low-frequency totals, without destroying the movement the indicator shows.
//
// The reference is the IMF *Quarterly National Accounts Manual* (Bloem,
// Dippelsman and Mæhle, 2001; second edition 2017), chapter 6, which SNA 2008
// ch.28 (quarterly accounts) defers to for benchmarking method. The method
// implemented here is Denton (1971), which that manual recommends as the
// practical default.
//
// The problem. Quarterly source data — a turnover survey, VAT receipts, an
// employment index — moves plausibly but does not add up to the annual
// accounts, which are compiled from better sources. Two things must both be
// true of the published quarterly series:
//
//   1. its four quarters sum to the annual figure, exactly;
//   2. it moves the way the indicator moves.
//
// Simply prorating each year's annual total across its quarters by the
// indicator's shares satisfies (1) and breaks (2): it introduces a step at
// every year boundary, because each year's adjustment is applied uniformly
// within the year and then changes abruptly at the turn. Denton's insight is
// to make the adjustment itself as smooth as possible over the whole series,
// so the year boundaries stop being visible.
//
// Pure, like the rest of the engine.
import { assertFinite, solveLinearSystem, sum } from './numeric';
import type { Money } from './types';

/**
 * Which movement Denton preserves.
 *
 * `proportional` minimises the squared change in the benchmark-to-indicator
 * RATIO — it preserves period-to-period growth rates. This is the variant the
 * QNA manual recommends and the one nearly every national statistical office
 * uses, so it is the default here.
 *
 * `additive` minimises the squared change in the DIFFERENCE, preserving
 * period-to-period changes in level instead. It is the right choice for a
 * series that crosses zero or changes sign — changes in inventories (P.52) is
 * the standard example — because a ratio to something near zero is unstable
 * and a ratio to something negative inverts the adjustment.
 *
 * Both are the *first-difference* forms. Denton also defined second-
 * difference variants, and the Cholette–Dagum family generalises the whole
 * problem to allow for autocorrelated and heteroscedastic indicator error.
 * Neither is implemented; the QNA manual's own judgement is that the
 * first-difference proportional form is sufficient in practice, and the
 * alternatives are noted here rather than half-built.
 */
export type BenchmarkVariant = 'proportional' | 'additive';

/** One high-frequency observation of the indicator series. */
export interface IndicatorPoint {
  /** Period label, e.g. '2024-Q3'. Carried through to the result. */
  periodLabel: string;
  /** The indicator value for this period. */
  value: Money;
  /**
   * Which low-frequency total this period is part of — a year label, a fiscal
   * year, whatever the compilation uses. The engine never derives this from
   * the label: fiscal years do not start in January everywhere, and inferring
   * a calendar from a string is how a compilation for one country quietly
   * misstates another. Null means the period falls outside every benchmark.
   */
  benchmarkKey: string | null;
}

/** One low-frequency total the high-frequency series must sum to. */
export interface BenchmarkTotal {
  /** Matches `IndicatorPoint.benchmarkKey`. */
  key: string;
  total: Money;
}

export interface BenchmarkedPoint {
  periodLabel: string;
  benchmarkKey: string | null;
  /** The indicator as it arrived. */
  indicator: Money;
  /** The benchmarked figure — what gets published. */
  benchmarked: Money;
  /**
   * The benchmark-to-indicator relationship Denton smooths: a ratio for the
   * proportional variant, a difference for the additive one. Publishing it
   * is how a compiler sees whether the adjustment is small and steady (the
   * indicator is doing its job) or large and lurching (it is not).
   */
  adjustment: number;
  /** True when this period is covered by a supplied total. */
  constrained: boolean;
  /**
   * True when this period lies beyond the last benchmarked one, so its figure
   * is an extrapolation rather than a reconciliation. Denton extrapolates by
   * carrying the final adjustment forward unchanged, which is exactly what
   * minimising the change in the adjustment implies once the constraints run
   * out — the same arithmetic, not a separate rule.
   */
  extrapolated: boolean;
}

/** How well each supplied total was met. Residuals should be zero. */
export interface BenchmarkConstraintCheck {
  key: string;
  /** The total that was required. */
  total: Money;
  /** What the benchmarked periods in this group actually sum to. */
  benchmarkedSum: Money;
  /** total − benchmarkedSum. Zero to numerical precision, by construction. */
  residual: Money;
}

export interface BenchmarkResult {
  variant: BenchmarkVariant;
  points: BenchmarkedPoint[];
  constraints: BenchmarkConstraintCheck[];
  /**
   * Benchmark keys present on the indicator for which no total was supplied.
   * Those periods are left unconstrained rather than silently dropped, and
   * the caller is told which they were.
   */
  unbenchmarkedKeys: string[];
}

export interface BenchmarkOptions {
  variant?: BenchmarkVariant;
}

export class BenchmarkError extends Error {}

/**
 * Denton first-difference benchmarking.
 *
 * Stated as a constrained least-squares problem. Let I_t be the indicator and
 * X_t the benchmarked series. For the proportional variant, write the
 * adjustment as a ratio r_t = X_t / I_t and
 *
 *   minimise   Σ_{t=2..T} (r_t − r_{t−1})²
 *   subject to Σ_{t ∈ y} I_t · r_t = A_y   for every benchmark group y
 *
 * For the additive variant, write it as a difference d_t = X_t − I_t and
 *
 *   minimise   Σ_{t=2..T} (d_t − d_{t−1})²
 *   subject to Σ_{t ∈ y} d_t = A_y − Σ_{t ∈ y} I_t
 *
 * — the same system with the constraint coefficients changed from I_t to 1,
 * which is the whole difference between the two variants.
 *
 * Both are solved exactly through the Lagrangian stationarity conditions
 *
 *   [ Q   −C' ] [ x ]   [ 0 ]
 *   [ C    0  ] [ λ ] = [ a ]
 *
 * where Q = D'D for the first-difference operator D. No iteration, no
 * convergence criterion, no tuning parameter: for a given indicator and set
 * of totals there is one answer, which is what makes a published quarterly
 * figure reproducible (non-negotiable 1).
 *
 * Periods with no matching total are included in the objective but in no
 * constraint. That single fact gives both extrapolation past the last
 * benchmark year and back-casting before the first, with no special case.
 */
export function dentonBenchmark(
  indicator: readonly IndicatorPoint[],
  totals: readonly BenchmarkTotal[],
  options: BenchmarkOptions = {},
): BenchmarkResult {
  const variant = options.variant ?? 'proportional';
  const n = indicator.length;
  if (n === 0) {
    return { variant, points: [], constraints: [], unbenchmarkedKeys: [] };
  }

  for (const point of indicator) {
    assertFinite(point.value, `indicator value for ${point.periodLabel}`);
  }
  for (const t of totals) assertFinite(t.total, `benchmark total for ${t.key}`);

  const seenLabels = new Set<string>();
  for (const point of indicator) {
    if (seenLabels.has(point.periodLabel)) {
      throw new BenchmarkError(`Period ${point.periodLabel} appears twice in the indicator`);
    }
    seenLabels.add(point.periodLabel);
  }

  const totalByKey = new Map<string, number>();
  for (const t of totals) {
    if (totalByKey.has(t.key)) {
      throw new BenchmarkError(`Benchmark total for ${t.key} was supplied twice`);
    }
    totalByKey.set(t.key, t.total);
  }

  // Groups, in the order the periods appear, so the constraint rows and the
  // reported checks come back in a stable, readable order.
  const groupOrder: string[] = [];
  const membersByKey = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = indicator[i].benchmarkKey;
    if (key === null) continue;
    if (!membersByKey.has(key)) {
      membersByKey.set(key, []);
      groupOrder.push(key);
    }
    membersByKey.get(key)!.push(i);
  }

  for (const key of totalByKey.keys()) {
    if (!membersByKey.has(key)) {
      throw new BenchmarkError(
        `A total was supplied for ${key}, but no period belongs to it. ` +
          'A benchmark that covers no periods cannot be satisfied.',
      );
    }
  }

  const constrainedKeys = groupOrder.filter((key) => totalByKey.has(key));
  const unbenchmarkedKeys = groupOrder.filter((key) => !totalByKey.has(key));

  // Work in scaled units so the KKT matrix is well conditioned whether the
  // figures arrive in units, thousands or millions. r is dimensionless
  // already; d is not, so it is scaled and multiplied back at the end.
  const magnitude = Math.max(
    ...indicator.map((p) => Math.abs(p.value)),
    ...totals.map((t) => Math.abs(t.total)),
  );
  const scale = magnitude > 0 ? magnitude : 1;

  if (variant === 'proportional') {
    for (const key of constrainedKeys) {
      const groupSum = sum(membersByKey.get(key)!.map((i) => indicator[i].value));
      if (groupSum === 0) {
        throw new BenchmarkError(
          `The indicator sums to zero over ${key}, so no proportional adjustment ` +
            'can reach the benchmark total. Use the additive variant for a series ' +
            'that crosses zero.',
        );
      }
    }
  }

  const m = constrainedKeys.length;
  const size = n + m;

  // Q = D'D: the second-difference stencil, with the ends of the series
  // touched by only one difference each.
  const a: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (let i = 0; i < n; i++) {
    if (n === 1) break; // no differences to smooth
    a[i][i] = i === 0 || i === n - 1 ? 1 : 2;
    if (i > 0) a[i][i - 1] = -1;
    if (i < n - 1) a[i][i + 1] = -1;
  }

  const rhs = new Array<number>(size).fill(0);
  for (let c = 0; c < m; c++) {
    const key = constrainedKeys[c];
    const members = membersByKey.get(key)!;
    const required = totalByKey.get(key)!;
    for (const i of members) {
      const coefficient =
        variant === 'proportional' ? indicator[i].value / scale : 1;
      a[n + c][i] = coefficient;
      a[i][n + c] = -coefficient;
    }
    rhs[n + c] =
      variant === 'proportional'
        ? required / scale
        : (required - sum(members.map((i) => indicator[i].value))) / scale;
  }

  // With no constraints there is nothing to reconcile to, and the smoothing
  // objective alone has no unique minimum — any constant adjustment scores
  // zero. The indicator stands as it is, which is both the right answer and
  // the one a compiler expects when the annual accounts are not in yet.
  let solution: number[];
  if (m === 0) {
    solution = new Array<number>(size).fill(variant === 'proportional' ? 1 : 0);
  } else {
    try {
      solution = solveLinearSystem(a, rhs);
    } catch (e) {
      throw new BenchmarkError(
        `Benchmarking could not be solved: ${e instanceof Error ? e.message : String(e)}. ` +
          'This usually means the indicator is flat at zero across a benchmark group.',
      );
    }
  }

  const lastConstrainedIndex = (() => {
    let last = -1;
    for (let i = 0; i < n; i++) {
      const key = indicator[i].benchmarkKey;
      if (key !== null && totalByKey.has(key)) last = i;
    }
    return last;
  })();

  const points: BenchmarkedPoint[] = indicator.map((point, i) => {
    const x = solution[i];
    const benchmarked =
      variant === 'proportional' ? point.value * x : point.value + x * scale;
    const key = point.benchmarkKey;
    const constrained = key !== null && totalByKey.has(key);
    return {
      periodLabel: point.periodLabel,
      benchmarkKey: key,
      indicator: point.value,
      benchmarked,
      adjustment: variant === 'proportional' ? x : x * scale,
      constrained,
      extrapolated: !constrained && lastConstrainedIndex >= 0 && i > lastConstrainedIndex,
    };
  });

  const byLabel = new Map(points.map((p) => [p.periodLabel, p]));
  const constraints: BenchmarkConstraintCheck[] = constrainedKeys.map((key) => {
    const members = membersByKey.get(key)!;
    const benchmarkedSum = sum(
      members.map((i) => byLabel.get(indicator[i].periodLabel)!.benchmarked),
    );
    const required = totalByKey.get(key)!;
    return { key, total: required, benchmarkedSum, residual: required - benchmarkedSum };
  });

  return { variant, points, constraints, unbenchmarkedKeys };
}

/**
 * Sum a high-frequency series into its benchmark groups.
 *
 * Temporal aggregation of a flow is addition — SNA 2008 ch.28: quarterly
 * flows accumulate to the year. It is deliberately NOT applied to stocks or
 * to index numbers, which aggregate by averaging or not at all, so this
 * function takes flows and says so rather than guessing from the data.
 */
export function temporalAggregate(
  points: readonly IndicatorPoint[],
): BenchmarkTotal[] {
  const order: string[] = [];
  const byKey = new Map<string, number[]>();
  for (const point of points) {
    if (point.benchmarkKey === null) continue;
    if (!byKey.has(point.benchmarkKey)) {
      byKey.set(point.benchmarkKey, []);
      order.push(point.benchmarkKey);
    }
    byKey.get(point.benchmarkKey)!.push(point.value);
  }
  return order.map((key) => ({ key, total: sum(byKey.get(key)!) }));
}

export interface QuarterlyGrowthPoint {
  periodLabel: string;
  value: Money;
  /** Change on the immediately preceding quarter, per cent. */
  periodOnPeriodPercent: number | null;
  /** Change on the same quarter a year earlier, per cent. */
  yearOnYearPercent: number | null;
  /**
   * The period-on-period rate compounded to an annual rate. Presented by some
   * offices (notably the US BEA) and not by others; both are published here
   * so the reader can see which is which rather than having to work it out.
   */
  annualisedPercent: number | null;
}

/**
 * Period-on-period and year-on-year growth for a sub-annual series.
 *
 * Year-on-year compares against `periodsPerYear` places back — for quarterly
 * data, the same quarter a year earlier. That comparison is the one usually
 * quoted precisely because it is unaffected by seasonality, which this engine
 * does not attempt to remove: seasonal adjustment (X-13ARIMA-SEATS, TRAMO/
 * SEATS) is a separate discipline, and a series that has been benchmarked but
 * not seasonally adjusted must not be presented as if it had been.
 *
 * A growth rate against a zero or negative base is not meaningful, so it is
 * reported as null rather than as a number that would be quoted.
 */
export function subAnnualGrowth(
  series: readonly { periodLabel: string; value: Money }[],
  periodsPerYear = 4,
): QuarterlyGrowthPoint[] {
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
    throw new RangeError('periodsPerYear must be a positive integer');
  }
  const rate = (current: number, previous: number | undefined): number | null => {
    if (previous === undefined || previous <= 0) return null;
    return ((current - previous) / previous) * 100;
  };

  return series.map((point, i) => {
    assertFinite(point.value, `value for ${point.periodLabel}`);
    const periodOnPeriodPercent = rate(point.value, series[i - 1]?.value);
    return {
      periodLabel: point.periodLabel,
      value: point.value,
      periodOnPeriodPercent,
      yearOnYearPercent: rate(point.value, series[i - periodsPerYear]?.value),
      annualisedPercent:
        periodOnPeriodPercent === null
          ? null
          : ((1 + periodOnPeriodPercent / 100) ** periodsPerYear - 1) * 100,
    };
  });
}
