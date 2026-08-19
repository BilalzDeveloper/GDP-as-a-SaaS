// Volume measures. Index-number formulas have well-known algebraic
// properties, and those properties are the strongest available check that an
// implementation is correct — stronger than any single worked example,
// because they must hold for every input.
import { describe, expect, it } from 'vitest';
import {
  chainLink,
  deflate,
  fisherIndex,
  implicitPriceDeflator,
  laspeyresPriceIndex,
  laspeyresVolumeIndex,
  chainLinkAggregate,
  nonAdditivityResidual,
  paaschePriceIndex,
  paascheVolumeIndex,
  previousYearPricesValue,
  priceIndex,
  volumeIndex,
  sum,
  type PriceQuantity,
} from '../../src/engine';

// A small economy where prices and quantities move differently by product —
// which is what makes Laspeyres and Paasche diverge at all.
const base: PriceQuantity[] = [
  { code: 'wheat', price: 10, quantity: 100 },
  { code: 'steel', price: 50, quantity: 20 },
  { code: 'cloth', price: 5, quantity: 200 },
];
const current: PriceQuantity[] = [
  { code: 'wheat', price: 12, quantity: 110 }, // price +20%, volume +10%
  { code: 'steel', price: 55, quantity: 18 }, // price +10%, volume −10%
  { code: 'cloth', price: 4, quantity: 260 }, // price −20%, volume +30%
];

const baseValue = sum(base.map((x) => x.price * x.quantity));
const currentValue = sum(current.map((x) => x.price * x.quantity));

describe('index formulas', () => {
  it('computes Laspeyres price with base-period quantity weights', () => {
    // (12·100 + 55·20 + 4·200) / (10·100 + 50·20 + 5·200) = 3100/3000
    expect(laspeyresPriceIndex(base, current)).toBeCloseTo((3100 / 3000) * 100, 9);
  });

  it('computes Paasche price with current-period quantity weights', () => {
    // (12·110 + 55·18 + 4·260) / (10·110 + 50·18 + 5·260) = 3350/3300
    expect(paaschePriceIndex(base, current)).toBeCloseTo((3350 / 3300) * 100, 9);
  });

  it('computes Laspeyres volume at base-period prices', () => {
    // (110·10 + 18·50 + 260·5) / 3000 = 3300/3000
    expect(laspeyresVolumeIndex(base, current)).toBeCloseTo((3300 / 3000) * 100, 9);
  });

  it('computes Paasche volume at current-period prices', () => {
    // (110·12 + 18·55 + 260·4) / (100·12 + 20·55 + 200·4) = 3350/3100
    expect(paascheVolumeIndex(base, current)).toBeCloseTo((3350 / 3100) * 100, 9);
  });

  it('takes Fisher as the geometric mean of the two', () => {
    const l = laspeyresPriceIndex(base, current);
    const p = paaschePriceIndex(base, current);
    expect(fisherIndex(l, p)).toBeCloseTo(Math.sqrt(l * p), 9);
    expect(priceIndex(base, current, 'fisher')).toBeCloseTo(Math.sqrt(l * p), 9);
  });
});

describe('index-number properties', () => {
  it('Fisher satisfies factor reversal: price × volume = value change', () => {
    // The property that makes Fisher "superlative", and the single best test
    // that both formulas are implemented correctly.
    const fp = priceIndex(base, current, 'fisher');
    const fq = volumeIndex(base, current, 'fisher');
    const valueChange = (currentValue / baseValue) * 100;
    expect((fp * fq) / 100).toBeCloseTo(valueChange, 9);
  });

  it('Laspeyres price × Paasche volume = value change', () => {
    // The other exact decomposition of a value change, and the reason a
    // Laspeyres volume series implies a Paasche deflator.
    const lp = laspeyresPriceIndex(base, current);
    const pq = paascheVolumeIndex(base, current);
    expect((lp * pq) / 100).toBeCloseTo((currentValue / baseValue) * 100, 9);
  });

  it('Paasche price × Laspeyres volume = value change', () => {
    const pp = paaschePriceIndex(base, current);
    const lq = laspeyresVolumeIndex(base, current);
    expect((pp * lq) / 100).toBeCloseTo((currentValue / baseValue) * 100, 9);
  });

  it('Fisher satisfies time reversal: forward × backward = 1', () => {
    const forward = priceIndex(base, current, 'fisher');
    const backward = priceIndex(current, base, 'fisher');
    expect((forward * backward) / (100 * 100)).toBeCloseTo(1, 9);
  });

  it('Laspeyres does NOT satisfy time reversal — a real property, not a bug', () => {
    const forward = laspeyresPriceIndex(base, current);
    const backward = laspeyresPriceIndex(current, base);
    expect((forward * backward) / (100 * 100)).not.toBeCloseTo(1, 6);
  });

  it('returns 100 when nothing changes', () => {
    for (const formula of ['laspeyres', 'paasche', 'fisher'] as const) {
      expect(priceIndex(base, base, formula)).toBeCloseTo(100, 9);
      expect(volumeIndex(base, base, formula)).toBeCloseTo(100, 9);
    }
  });

  it('ignores items absent from one period rather than treating them as zero', () => {
    // A new product has no price relative; counting it as a zero-price base
    // item would send the index to nonsense.
    const withNew = [...current, { code: 'chips', price: 3, quantity: 500 }];
    expect(laspeyresPriceIndex(base, withNew)).toBeCloseTo(
      laspeyresPriceIndex(base, current),
      9,
    );
  });
});

describe('deflation', () => {
  it('divides value by the index to give a volume measure', () => {
    expect(deflate(1100, 110)).toBeCloseTo(1000, 9);
    expect(deflate(1000, 100)).toBeCloseTo(1000, 9);
  });

  it('refuses a zero deflator', () => {
    expect(() => deflate(100, 0)).toThrow(/zero price index/);
  });

  it('revalues a period at the previous period’s prices', () => {
    // Value 1210 with the deflator up from 100 to 110: at last year's prices
    // that is 1100, so the volume rose 10% against a 1000 base.
    expect(previousYearPricesValue(1210, 110, 100)).toBeCloseTo(1100, 9);
  });

  it('computes an implicit deflator as value over volume', () => {
    expect(implicitPriceDeflator(1210, 1100)).toBeCloseTo(110, 9);
  });
});

describe('chain-linking by annual overlap', () => {
  // Volume grows 10%, then 5%; prices rise 4% then 3%.
  const series = [
    { periodLabel: '2021', value: 1000, deflator: 100 },
    { periodLabel: '2022', value: 1144, deflator: 104 }, // 1000·1.10·1.04
    { periodLabel: '2023', value: 1237.236, deflator: 107.12 }, // 1144·1.05·1.03
  ];

  it('sets the chain index to 100 in the reference period', () => {
    const linked = chainLink(series, { referencePeriodLabel: '2021' });
    expect(linked[0].chainIndex).toBeCloseTo(100, 9);
    expect(linked[0].chainLinkedValue).toBeCloseTo(1000, 9);
  });

  it('recovers the underlying volume growth', () => {
    const linked = chainLink(series, { referencePeriodLabel: '2021' });
    expect(linked[1].volumeGrowthPercent).toBeCloseTo(10, 6);
    expect(linked[2].volumeGrowthPercent).toBeCloseTo(5, 6);
  });

  it('compounds the links into the chain index', () => {
    const linked = chainLink(series, { referencePeriodLabel: '2021' });
    expect(linked[1].chainIndex).toBeCloseTo(110, 6);
    expect(linked[2].chainIndex).toBeCloseTo(115.5, 6); // 110 × 1.05
  });

  it('expresses chain-linked values in the reference period’s price level', () => {
    const linked = chainLink(series, { referencePeriodLabel: '2021' });
    expect(linked[2].chainLinkedValue).toBeCloseTo(1155, 6);
  });

  it('computes each period at the previous period’s prices', () => {
    const linked = chainLink(series, { referencePeriodLabel: '2021' });
    // 2022 at 2021 prices = 1144 × 100/104 = 1100
    expect(linked[1].previousYearPricesValue).toBeCloseTo(1100, 6);
  });

  it('re-references without changing growth rates', () => {
    // Which period carries the price level is a presentational choice; the
    // volume path must not depend on it.
    const onFirst = chainLink(series, { referencePeriodLabel: '2021' });
    const onLast = chainLink(series, { referencePeriodLabel: '2023' });
    expect(onLast[2].chainIndex).toBeCloseTo(100, 9);
    for (let i = 1; i < series.length; i++) {
      expect(onLast[i].volumeGrowthPercent).toBeCloseTo(
        onFirst[i].volumeGrowthPercent!,
        9,
      );
    }
  });

  it('leaves the first period without a link', () => {
    const linked = chainLink(series);
    expect(linked[0].link).toBeNull();
    expect(linked[0].previousYearPricesValue).toBeNull();
    expect(linked[0].volumeGrowthPercent).toBeNull();
  });

  it('handles a flat series', () => {
    const flat = [
      { periodLabel: '2021', value: 500, deflator: 100 },
      { periodLabel: '2022', value: 500, deflator: 100 },
    ];
    const linked = chainLink(flat);
    expect(linked[1].volumeGrowthPercent).toBeCloseTo(0, 9);
    expect(linked[1].chainLinkedValue).toBeCloseTo(500, 9);
  });

  it('rejects a non-positive deflator rather than producing nonsense', () => {
    expect(() =>
      chainLink([
        { periodLabel: '2021', value: 100, deflator: 100 },
        { periodLabel: '2022', value: 100, deflator: 0 },
      ]),
    ).toThrow(/must be positive/);
  });

  it('rejects a reference period that is not in the series', () => {
    expect(() => chainLink(series, { referencePeriodLabel: '1999' })).toThrow(
      /not in the series/,
    );
  });

  it('returns nothing for an empty series', () => {
    expect(chainLink([])).toEqual([]);
  });
});

describe('non-additivity — the thing users report as a bug', () => {
  // Two industries whose prices move in opposite directions. Chain-linking
  // each with its own weights, and the aggregate with each year's actual
  // composition, means the parts cannot sum to the whole.
  const industryA = [
    { periodLabel: '2021', value: 600, deflator: 100 },
    { periodLabel: '2022', value: 700, deflator: 120 },
    { periodLabel: '2023', value: 800, deflator: 140 },
  ];
  const industryB = [
    { periodLabel: '2021', value: 400, deflator: 100 },
    { periodLabel: '2022', value: 420, deflator: 90 },
    { periodLabel: '2023', value: 430, deflator: 80 },
  ];

  const linkedA = chainLink(industryA, { referencePeriodLabel: '2021' });
  const linkedB = chainLink(industryB, { referencePeriodLabel: '2021' });
  const linkedTotal = chainLinkAggregate([industryA, industryB], {
    referencePeriodLabel: '2021',
  });
  const residuals = nonAdditivityResidual(linkedTotal, [linkedA, linkedB]);

  it('aggregates from component values, not from an aggregate deflator', () => {
    // 2022 at 2021 prices: A 700/1.2 = 583.33, B 420/0.9 = 466.67 ⇒ 1050
    // against a 2021 total of 1000, so the aggregate volume rose 5%.
    expect(linkedTotal[1].previousYearPricesValue).toBeCloseTo(1050, 6);
    expect(linkedTotal[1].volumeGrowthPercent).toBeCloseTo(5, 6);
  });

  it('is additive in the reference period and the one straight after it', () => {
    // A real property of annual overlap, worth pinning down: the first link
    // values every component at the SAME reference-year prices, so the parts
    // still add up one period on. Divergence starts with the second link.
    expect(residuals[0].isAdditive).toBe(true);
    expect(residuals[0].residual).toBeCloseTo(0, 6);
    expect(residuals[1].isAdditive).toBe(true);
    expect(residuals[1].residual).toBeCloseTo(0, 6);
  });

  it('is NOT additive from the second link onwards — and that is correct', () => {
    expect(residuals[2].isAdditive).toBe(false);
    // Around −12.6 on an aggregate near 1096: over 1% of the total, far too
    // large to be rounding, and exactly what a user would report as a bug.
    expect(Math.abs(residuals[2].residual)).toBeGreaterThan(1);
    expect(Math.abs(residuals[2].residualPercent)).toBeGreaterThan(0.5);
  });

  it('reports the residual rather than forcing the components to add up', () => {
    for (const r of residuals) {
      expect(r.residual).toBeCloseTo(r.aggregate - r.sumOfComponents, 9);
      expect(Number.isFinite(r.residualPercent)).toBe(true);
    }
  });

  it('keeps each component’s own growth intact', () => {
    // Forcing additivity would have to distort these; publishing the residual
    // leaves every component saying what its own data says.
    expect(linkedA[1].volumeGrowthPercent).toBeCloseTo(
      ((700 / 1.2 - 600) / 600) * 100,
      6,
    );
    expect(linkedB[1].volumeGrowthPercent).toBeCloseTo(
      ((420 / 0.9 - 400) / 400) * 100,
      6,
    );
  });

  it('IS additive when every series shares one fixed-base deflator', () => {
    // The contrast that explains the whole phenomenon: with a common
    // fixed-base index, chaining collapses to fixed-base deflation, and
    // fixed-base constant prices do add up.
    const commonA = industryA.map((p, i) => ({ ...p, deflator: [100, 110, 120][i] }));
    const commonB = industryB.map((p, i) => ({ ...p, deflator: [100, 110, 120][i] }));
    const a = chainLink(commonA, { referencePeriodLabel: '2021' });
    const b = chainLink(commonB, { referencePeriodLabel: '2021' });
    const total = chainLinkAggregate([commonA, commonB], {
      referencePeriodLabel: '2021',
    });
    for (const r of nonAdditivityResidual(total, [a, b])) {
      expect(r.isAdditive).toBe(true);
    }
  });
});
