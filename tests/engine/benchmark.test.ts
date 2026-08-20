// Denton benchmarking: quarterly indicators reconciled to annual totals.
//
// The tests that matter here are of three kinds:
//
//   1. The constraint is met — exactly, not approximately. A quarterly series
//      whose four quarters do not sum to the published annual figure is not
//      publishable, so this is the property everything else rests on.
//   2. Hand-checkable worked examples. Two cases below have closed-form
//      answers derived from the Lagrangian on paper, so if the linear solve
//      is wrong the test says so with a number a statistician can verify.
//   3. Properties Denton is *chosen* for: no step at the year boundary,
//      movement preserved when the indicator already adds up, extrapolation
//      that carries the last adjustment forward.
import { describe, expect, it } from 'vitest';
import {
  BenchmarkError,
  dentonBenchmark,
  solveLinearSystem,
  subAnnualGrowth,
  temporalAggregate,
  type IndicatorPoint,
} from '@/engine';

/** Four quarters of a year, labelled and keyed the way a run would key them. */
function year(label: string, values: readonly number[]): IndicatorPoint[] {
  return values.map((value, i) => ({
    periodLabel: `${label}-Q${i + 1}`,
    value,
    benchmarkKey: label,
  }));
}

describe('solveLinearSystem', () => {
  it('solves a system with a known answer', () => {
    // 2x + y = 5 ; x + 3y = 10  →  x = 1, y = 3
    const x = solveLinearSystem(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(x[0]).toBeCloseTo(1, 12);
    expect(x[1]).toBeCloseTo(3, 12);
  });

  it('handles a system needing a row swap to find a pivot', () => {
    // A zero in the first pivot position: without partial pivoting this
    // divides by zero rather than swapping.
    const x = solveLinearSystem(
      [
        [0, 2],
        [3, 1],
      ],
      [4, 5],
    );
    expect(x[0]).toBeCloseTo(1, 12);
    expect(x[1]).toBeCloseTo(2, 12);
  });

  it('reproduces the right-hand side when the solution is substituted back', () => {
    const a = [
      [4, -2, 1],
      [-2, 4, -2],
      [1, -2, 4],
    ];
    const b = [11, -16, 17];
    const x = solveLinearSystem(a, b);
    for (let i = 0; i < 3; i++) {
      const row = a[i][0] * x[0] + a[i][1] * x[1] + a[i][2] * x[2];
      expect(row).toBeCloseTo(b[i], 10);
    }
  });

  it('refuses a singular system rather than returning nonsense', () => {
    expect(() =>
      solveLinearSystem(
        [
          [1, 2],
          [2, 4],
        ],
        [3, 6],
      ),
    ).toThrow(/singular/i);
  });

  it('judges singularity relative to the scale of the matrix', () => {
    // Entries in millions: a fixed absolute threshold would call this
    // singular even though it is perfectly well conditioned.
    const x = solveLinearSystem(
      [
        [2e6, 1e6],
        [1e6, 3e6],
      ],
      [5e6, 10e6],
    );
    expect(x[0]).toBeCloseTo(1, 9);
    expect(x[1]).toBeCloseTo(3, 9);
  });

  it('rejects a non-square matrix', () => {
    expect(() => solveLinearSystem([[1, 2, 3]], [1])).toThrow(/square/i);
  });

  it('leaves the caller’s arrays untouched', () => {
    const a = [
      [2, 1],
      [1, 3],
    ];
    const b = [5, 10];
    solveLinearSystem(a, b);
    expect(a).toEqual([
      [2, 1],
      [1, 3],
    ]);
    expect(b).toEqual([5, 10]);
  });
});

describe('dentonBenchmark — the constraint', () => {
  it('makes the quarters sum to the annual total, exactly', () => {
    const indicator = [
      ...year('2022', [102, 98, 110, 95]),
      ...year('2023', [108, 104, 118, 101]),
      ...year('2024', [115, 112, 126, 108]),
    ];
    const result = dentonBenchmark(indicator, [
      { key: '2022', total: 420 },
      { key: '2023', total: 448 },
      { key: '2024', total: 479 },
    ]);

    for (const check of result.constraints) {
      expect(Math.abs(check.residual)).toBeLessThan(1e-9);
      expect(check.benchmarkedSum).toBeCloseTo(check.total, 9);
    }
  });

  it('meets the constraint for the additive variant too', () => {
    const indicator = [
      ...year('2023', [40, -12, 25, -8]),
      ...year('2024', [33, -20, 41, -6]),
    ];
    const result = dentonBenchmark(
      indicator,
      [
        { key: '2023', total: 60 },
        { key: '2024', total: 32 },
      ],
      { variant: 'additive' },
    );
    for (const check of result.constraints) {
      expect(Math.abs(check.residual)).toBeLessThan(1e-9);
    }
  });

  it('holds the constraint when figures arrive in millions', () => {
    const indicator = [...year('2024', [102e6, 98e6, 110e6, 95e6])];
    const result = dentonBenchmark(indicator, [{ key: '2024', total: 420e6 }]);
    expect(result.constraints[0].benchmarkedSum).toBeCloseTo(420e6, 2);
  });
});

describe('dentonBenchmark — worked examples checked by hand', () => {
  it('scales a single year by a constant ratio', () => {
    // One benchmark group: a constant ratio satisfies the constraint and
    // makes the objective exactly zero, so it is the unique minimum.
    // Σ I = 10, A = 20 → r ≡ 2.
    const result = dentonBenchmark([...year('2024', [1, 2, 3, 4])], [
      { key: '2024', total: 20 },
    ]);
    expect(result.points.map((p) => p.benchmarked)).toEqual([
      expect.closeTo(2, 10),
      expect.closeTo(4, 10),
      expect.closeTo(6, 10),
      expect.closeTo(8, 10),
    ]);
    for (const point of result.points) expect(point.adjustment).toBeCloseTo(2, 10);
  });

  it('matches the closed-form solution across a year boundary', () => {
    // Two years, two quarters each, indicator flat at 1, totals 2 and 4.
    //
    // Write r1 = 1−u, r2 = 1+u, r3 = 2−v, r4 = 2+v to satisfy the two
    // constraints. The objective becomes 4u² + (1−u−v)² + 4v²; setting both
    // partial derivatives to zero gives 5u + v = 1 and u + 5v = 1, so
    // u = v = 1/6 and r = [5/6, 7/6, 11/6, 13/6].
    const indicator: IndicatorPoint[] = [
      { periodLabel: 'H1-1', value: 1, benchmarkKey: 'Y1' },
      { periodLabel: 'H1-2', value: 1, benchmarkKey: 'Y1' },
      { periodLabel: 'H2-1', value: 1, benchmarkKey: 'Y2' },
      { periodLabel: 'H2-2', value: 1, benchmarkKey: 'Y2' },
    ];
    const result = dentonBenchmark(indicator, [
      { key: 'Y1', total: 2 },
      { key: 'Y2', total: 4 },
    ]);
    const got = result.points.map((p) => p.benchmarked);
    expect(got[0]).toBeCloseTo(5 / 6, 12);
    expect(got[1]).toBeCloseTo(7 / 6, 12);
    expect(got[2]).toBeCloseTo(11 / 6, 12);
    expect(got[3]).toBeCloseTo(13 / 6, 12);
  });

  it('spreads an additive adjustment evenly within a single group', () => {
    // Σ I = 10, A = 14, one group: the difference d must sum to 4 and the
    // objective is minimised when it is constant, so d ≡ 1.
    const result = dentonBenchmark(
      [...year('2024', [1, 2, 3, 4])],
      [{ key: '2024', total: 14 }],
      { variant: 'additive' },
    );
    expect(result.points.map((p) => p.benchmarked)).toEqual([
      expect.closeTo(2, 10),
      expect.closeTo(3, 10),
      expect.closeTo(4, 10),
      expect.closeTo(5, 10),
    ]);
    for (const point of result.points) expect(point.adjustment).toBeCloseTo(1, 10);
  });
});

describe('dentonBenchmark — the properties it is chosen for', () => {
  it('leaves an indicator that already adds up completely alone', () => {
    // Movement preservation in its strongest form: when the indicator's own
    // annual sums equal the benchmarks, the objective can reach zero with
    // r ≡ 1, so Denton must not move a single quarter.
    const values = [
      ...year('2023', [21, 24, 26, 29]),
      ...year('2024', [23, 27, 28, 32]),
    ];
    const result = dentonBenchmark(values, [
      { key: '2023', total: 100 },
      { key: '2024', total: 110 },
    ]);
    result.points.forEach((point, i) => {
      expect(point.benchmarked).toBeCloseTo(values[i].value, 9);
      expect(point.adjustment).toBeCloseTo(1, 9);
    });
  });

  it('does not put a step in the adjustment at the year boundary', () => {
    // This is the whole reason to prefer Denton to pro-rating each year
    // separately. Pro-rating would give ratios 1.0, 1.0, 1.0, 1.0, then jump
    // to 2.0 for every quarter of the second year — a visible break in the
    // published growth rate at the turn of the year, which is an artefact of
    // the method rather than anything the economy did.
    const indicator = [...year('Y1', [1, 1, 1, 1]), ...year('Y2', [1, 1, 1, 1])];
    const result = dentonBenchmark(indicator, [
      { key: 'Y1', total: 4 },
      { key: 'Y2', total: 8 },
    ]);
    const ratios = result.points.map((p) => p.adjustment);

    // Strictly increasing throughout: the adjustment moves gradually.
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
    }
    // And the biggest single step is far smaller than the 1.0 jump pro-rating
    // would leave at the boundary.
    const steps = ratios.slice(1).map((r, i) => r - ratios[i]);
    expect(Math.max(...steps)).toBeLessThan(0.5);
    // Pro-rating is what we are avoiding, so assert we did not land on it.
    expect(ratios[3]).not.toBeCloseTo(1, 3);
    expect(ratios[4]).not.toBeCloseTo(2, 3);
  });

  it('extrapolates by carrying the last adjustment forward unchanged', () => {
    const indicator = [
      ...year('2023', [100, 102, 105, 103]),
      ...year('2024', [107, 110, 112, 111]),
      ...year('2025', [115, 118, 120, 119]),
    ];
    // Only two annual totals: 2025 is not yet benchmarked.
    const result = dentonBenchmark(indicator, [
      { key: '2023', total: 420 },
      { key: '2024', total: 448 },
    ]);

    const lastConstrained = result.points[7];
    const extrapolated = result.points.slice(8);
    expect(lastConstrained.constrained).toBe(true);
    for (const point of extrapolated) {
      expect(point.constrained).toBe(false);
      expect(point.extrapolated).toBe(true);
      expect(point.adjustment).toBeCloseTo(lastConstrained.adjustment, 10);
      expect(point.benchmarked).toBeCloseTo(point.indicator * lastConstrained.adjustment, 9);
    }
    expect(result.unbenchmarkedKeys).toEqual(['2025']);
  });

  it('carries the first adjustment backwards for periods before the first benchmark', () => {
    const indicator = [
      ...year('2022', [90, 92, 94, 93]),
      ...year('2023', [100, 102, 105, 103]),
    ];
    const result = dentonBenchmark(indicator, [{ key: '2023', total: 420 }]);
    const firstConstrained = result.points[4];
    for (const point of result.points.slice(0, 4)) {
      expect(point.constrained).toBe(false);
      // Before the first benchmark, so not an extrapolation forward.
      expect(point.extrapolated).toBe(false);
      expect(point.adjustment).toBeCloseTo(firstConstrained.adjustment, 10);
    }
  });

  it('is scale invariant', () => {
    const base = [...year('2023', [21, 24, 26, 29]), ...year('2024', [23, 27, 28, 32])];
    const scaled = base.map((p) => ({ ...p, value: p.value * 1000 }));
    const small = dentonBenchmark(base, [
      { key: '2023', total: 104 },
      { key: '2024', total: 118 },
    ]);
    const large = dentonBenchmark(scaled, [
      { key: '2023', total: 104_000 },
      { key: '2024', total: 118_000 },
    ]);
    small.points.forEach((point, i) => {
      expect(large.points[i].benchmarked / 1000).toBeCloseTo(point.benchmarked, 6);
      expect(large.points[i].adjustment).toBeCloseTo(point.adjustment, 9);
    });
  });

  it('is deterministic — the same inputs give bit-identical output', () => {
    // Reproducibility is non-negotiable 1: a published quarterly figure has
    // to come back the same on re-execution, not merely close.
    const indicator = [
      ...year('2023', [100, 102, 105, 103]),
      ...year('2024', [107, 110, 112, 111]),
    ];
    const totals = [
      { key: '2023', total: 415 },
      { key: '2024', total: 452 },
    ];
    const first = dentonBenchmark(indicator, totals);
    const second = dentonBenchmark(indicator, totals);
    expect(second.points.map((p) => p.benchmarked)).toEqual(
      first.points.map((p) => p.benchmarked),
    );
  });

  it('holds the constraint over a long series with irregular movement', () => {
    // Twelve years of quarters, generated from a fixed recurrence so the
    // series is reproducible but not smooth. Exercises the linear solve at a
    // size a real compilation reaches.
    const indicator: IndicatorPoint[] = [];
    const totals: { key: string; total: number }[] = [];
    let x = 100;
    for (let y = 0; y < 12; y++) {
      const key = String(2013 + y);
      let annual = 0;
      for (let q = 0; q < 4; q++) {
        // A deterministic wobble: no randomness, so the test cannot flake.
        x = x * 1.008 + ((y * 4 + q) % 5) - 2;
        indicator.push({ periodLabel: `${key}-Q${q + 1}`, value: x, benchmarkKey: key });
        annual += x;
      }
      totals.push({ key, total: annual * (1 + 0.01 * Math.sin(y)) });
    }

    const result = dentonBenchmark(indicator, totals);
    expect(result.points).toHaveLength(48);
    for (const check of result.constraints) {
      expect(Math.abs(check.residual)).toBeLessThan(1e-6);
    }
    // Adjustments stay smooth: no quarter-to-quarter jump anywhere near the
    // size of the annual revisions being absorbed.
    const ratios = result.points.map((p) => p.adjustment);
    for (let i = 1; i < ratios.length; i++) {
      expect(Math.abs(ratios[i] - ratios[i - 1])).toBeLessThan(0.02);
    }
  });
});

describe('dentonBenchmark — series that cross zero', () => {
  const inventories = [
    { periodLabel: '2024-Q1', value: 10, benchmarkKey: '2024' },
    { periodLabel: '2024-Q2', value: -5, benchmarkKey: '2024' },
    { periodLabel: '2024-Q3', value: 3, benchmarkKey: '2024' },
    { periodLabel: '2024-Q4', value: -8, benchmarkKey: '2024' },
  ];

  it('refuses the proportional variant when the indicator sums to zero', () => {
    // Changes in inventories (P.52) is the standard case: the annual figure
    // is a small net of large gross movements, and no constant multiple of
    // an indicator summing to zero can reach a non-zero total.
    expect(() => dentonBenchmark(inventories, [{ key: '2024', total: 4 }])).toThrow(
      BenchmarkError,
    );
    expect(() => dentonBenchmark(inventories, [{ key: '2024', total: 4 }])).toThrow(
      /additive/,
    );
  });

  it('handles the same series additively', () => {
    const result = dentonBenchmark(inventories, [{ key: '2024', total: 4 }], {
      variant: 'additive',
    });
    expect(result.constraints[0].benchmarkedSum).toBeCloseTo(4, 9);
    // Σ I = 0 and A = 4, so the difference must sum to 4 and, being smoothed,
    // is spread evenly: exactly 1 per quarter.
    for (const point of result.points) expect(point.adjustment).toBeCloseTo(1, 9);
  });
});

describe('dentonBenchmark — refusing what it cannot do', () => {
  it('rejects a total for a group no period belongs to', () => {
    expect(() =>
      dentonBenchmark([...year('2024', [1, 2, 3, 4])], [
        { key: '2024', total: 10 },
        { key: '2025', total: 12 },
      ]),
    ).toThrow(/no period belongs to it/);
  });

  it('rejects a duplicated period', () => {
    const indicator = [...year('2024', [1, 2, 3, 4])];
    expect(() => dentonBenchmark([...indicator, indicator[0]], [])).toThrow(/twice/);
  });

  it('rejects a duplicated total', () => {
    expect(() =>
      dentonBenchmark([...year('2024', [1, 2, 3, 4])], [
        { key: '2024', total: 10 },
        { key: '2024', total: 12 },
      ]),
    ).toThrow(/twice/);
  });

  it('rejects a non-finite indicator value', () => {
    expect(() =>
      dentonBenchmark(
        [{ periodLabel: '2024-Q1', value: Number.NaN, benchmarkKey: '2024' }],
        [{ key: '2024', total: 1 }],
      ),
    ).toThrow(TypeError);
  });

  it('returns an empty result for an empty indicator', () => {
    const result = dentonBenchmark([], []);
    expect(result.points).toEqual([]);
    expect(result.constraints).toEqual([]);
  });

  it('leaves an entirely unconstrained series as it found it', () => {
    const indicator = [...year('2024', [1, 2, 3, 4])];
    const result = dentonBenchmark(indicator, []);
    result.points.forEach((point, i) => {
      expect(point.benchmarked).toBeCloseTo(indicator[i].value, 12);
      expect(point.constrained).toBe(false);
      expect(point.extrapolated).toBe(false);
    });
    expect(result.unbenchmarkedKeys).toEqual(['2024']);
  });
});

describe('temporalAggregate', () => {
  it('sums a flow into its benchmark groups, in the order they appear', () => {
    const totals = temporalAggregate([
      ...year('2023', [1, 2, 3, 4]),
      ...year('2024', [5, 6, 7, 8]),
    ]);
    expect(totals).toEqual([
      { key: '2023', total: 10 },
      { key: '2024', total: 26 },
    ]);
  });

  it('ignores periods that belong to no group', () => {
    const totals = temporalAggregate([
      { periodLabel: 'a', value: 5, benchmarkKey: '2024' },
      { periodLabel: 'b', value: 7, benchmarkKey: null },
    ]);
    expect(totals).toEqual([{ key: '2024', total: 5 }]);
  });
});

describe('subAnnualGrowth', () => {
  const series = [
    { periodLabel: '2023-Q1', value: 100 },
    { periodLabel: '2023-Q2', value: 102 },
    { periodLabel: '2023-Q3', value: 101 },
    { periodLabel: '2023-Q4', value: 104 },
    { periodLabel: '2024-Q1', value: 106 },
  ];

  it('computes period-on-period growth', () => {
    const growth = subAnnualGrowth(series);
    expect(growth[0].periodOnPeriodPercent).toBeNull();
    expect(growth[1].periodOnPeriodPercent).toBeCloseTo(2, 10);
    expect(growth[2].periodOnPeriodPercent).toBeCloseTo((-1 / 102) * 100, 10);
  });

  it('computes year-on-year growth against the same quarter a year earlier', () => {
    const growth = subAnnualGrowth(series);
    // Only the fifth point has a counterpart four quarters back.
    expect(growth.slice(0, 4).map((g) => g.yearOnYearPercent)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(growth[4].yearOnYearPercent).toBeCloseTo(6, 10);
  });

  it('annualises the period-on-period rate by compounding', () => {
    const growth = subAnnualGrowth(series);
    expect(growth[1].annualisedPercent).toBeCloseTo((1.02 ** 4 - 1) * 100, 10);
  });

  it('reports null rather than a number for a zero or negative base', () => {
    const growth = subAnnualGrowth([
      { periodLabel: 'a', value: -4 },
      { periodLabel: 'b', value: 6 },
      { periodLabel: 'c', value: 0 },
      { periodLabel: 'd', value: 3 },
    ]);
    expect(growth[1].periodOnPeriodPercent).toBeNull();
    expect(growth[3].periodOnPeriodPercent).toBeNull();
  });

  it('supports a frequency other than quarterly', () => {
    const monthly = Array.from({ length: 13 }, (_, i) => ({
      periodLabel: `m${i}`,
      value: 100 * 1.01 ** i,
    }));
    const growth = subAnnualGrowth(monthly, 12);
    expect(growth[12].yearOnYearPercent).toBeCloseTo((1.01 ** 12 - 1) * 100, 8);
  });
});
