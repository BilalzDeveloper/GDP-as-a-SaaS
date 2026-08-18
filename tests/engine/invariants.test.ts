// Invariants that must hold for any input, and the classification-scale
// requirement: a 10-industry aggregate and a 400-industry compilation are the
// same code path (non-negotiable 4).
//
// These catch a class of error that example-based tests miss — a change that
// happens to preserve one worked example while breaking the arithmetic in
// general.
import { describe, expect, it } from 'vitest';
import {
  annualisedGrowthRate,
  compileGdp,
  computeProductionApproach,
  gdpPerCapita,
  growthContribution,
  growthRate,
  roundForPublication,
  sum,
} from '../../src/engine';
import type { IndustryInput, ProductionInput } from '../../src/engine';

function makeIndustries(count: number, seed = 1): IndustryInput[] {
  // Deterministic pseudo-random magnitudes; a fixed seed keeps failures
  // reproducible, which matters when the suite runs in CI.
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return Array.from({ length: count }, (_, i) => {
    const output = Math.round(next() * 100000) / 100;
    return {
      code: `IND${String(i + 1).padStart(4, '0')}`,
      output,
      intermediateConsumption: Math.round(output * (0.3 + next() * 0.4) * 100) / 100,
    };
  });
}

function production(industries: IndustryInput[]): ProductionInput {
  return {
    outputValuation: 'basic',
    industries,
    taxesOnProducts: 320,
    subsidiesOnProducts: 70,
  };
}

describe('scale: the engine is classification-agnostic', () => {
  it.each([1, 10, 88, 400, 1200])(
    'compiles a %i-industry economy',
    (count) => {
      const industries = makeIndustries(count);
      const result = computeProductionApproach(production(industries));
      expect(result.industries).toHaveLength(count);
      const expected = sum(
        industries.map((i) => i.output - i.intermediateConsumption),
      );
      expect(result.totalGrossValueAdded).toBeCloseTo(expected, 6);
      expect(result.gdp).toBeCloseTo(expected + 250, 6);
    },
  );

  it('gives the same total whether an economy is reported in 10 or 400 parts', () => {
    // Split each of 10 industries into 40 equal pieces: the same economy at a
    // different level of detail must produce the same GDP.
    const coarse = makeIndustries(10);
    const fine = coarse.flatMap((industry, idx) =>
      Array.from({ length: 40 }, (_, k) => ({
        code: `${industry.code}-${k}`,
        output: industry.output / 40,
        intermediateConsumption: industry.intermediateConsumption / 40,
      })),
    );
    const coarseGdp = computeProductionApproach(production(coarse)).gdp;
    const fineGdp = computeProductionApproach(production(fine)).gdp;
    expect(fineGdp).toBeCloseTo(coarseGdp, 6);
  });

  it('sums hundreds of disparate magnitudes without drift', () => {
    // Naive summation of very large and very small figures accumulates error
    // that would surface as a phantom statistical discrepancy.
    const values = [1e9, ...Array.from({ length: 1000 }, () => 0.001), -1e9];
    expect(sum(values)).toBeCloseTo(1, 9);
  });
});

describe('algebraic invariants of the production approach', () => {
  const industries = makeIndustries(50);

  it('is homogeneous: scaling every input by k scales GDP by k', () => {
    const k = 2.5;
    const base = computeProductionApproach(production(industries));
    const scaled = computeProductionApproach({
      outputValuation: 'basic',
      industries: industries.map((i) => ({
        ...i,
        output: i.output * k,
        intermediateConsumption: i.intermediateConsumption * k,
      })),
      taxesOnProducts: 320 * k,
      subsidiesOnProducts: 70 * k,
    });
    expect(scaled.gdp).toBeCloseTo(base.gdp * k, 6);
  });

  it('is additive: adding an industry adds exactly its value added', () => {
    const base = computeProductionApproach(production(industries));
    const extra = { code: 'NEW', output: 1234.56, intermediateConsumption: 456.78 };
    const augmented = computeProductionApproach(
      production([...industries, extra]),
    );
    expect(augmented.gdp - base.gdp).toBeCloseTo(
      extra.output - extra.intermediateConsumption,
      6,
    );
  });

  it('an industry with output equal to its inputs contributes nothing', () => {
    const base = computeProductionApproach(production(industries));
    const augmented = computeProductionApproach(
      production([
        ...industries,
        { code: 'ZERO', output: 999, intermediateConsumption: 999 },
      ]),
    );
    expect(augmented.gdp).toBeCloseTo(base.gdp, 6);
  });

  it('taxes raise and subsidies lower GDP one for one', () => {
    const base = computeProductionApproach(production(industries));
    const taxed = computeProductionApproach({
      ...production(industries),
      taxesOnProducts: 420,
    });
    const subsidised = computeProductionApproach({
      ...production(industries),
      subsidiesOnProducts: 170,
    });
    expect(taxed.gdp - base.gdp).toBeCloseTo(100, 6);
    expect(subsidised.gdp - base.gdp).toBeCloseTo(-100, 6);
  });
});

describe('publication rounding', () => {
  it('rounds half away from zero, symmetrically', () => {
    expect(roundForPublication(0.5)).toBe(1);
    expect(roundForPublication(-0.5)).toBe(-1);
    expect(roundForPublication(2.5)).toBe(3);
    expect(roundForPublication(-2.5)).toBe(-3);
  });

  it('never publishes a negative zero', () => {
    expect(Object.is(roundForPublication(-0.4), 0)).toBe(true);
  });

  it('respects the requested precision', () => {
    expect(roundForPublication(1234.5678, 2)).toBe(1234.57);
    expect(roundForPublication(1234.5678, 0)).toBe(1235);
  });
});

describe('derived measures', () => {
  it('divides GDP by population', () => {
    expect(gdpPerCapita(2_950_000, 1000)).toBe(2950);
  });

  it('refuses a non-positive population', () => {
    expect(() => gdpPerCapita(100, 0)).toThrow(/greater than zero/);
    expect(() => gdpPerCapita(100, -5)).toThrow(/greater than zero/);
  });

  it('computes growth as a percentage', () => {
    expect(growthRate(1050, 1000)).toBeCloseTo(5, 9);
    expect(growthRate(950, 1000)).toBeCloseTo(-5, 9);
  });

  it('refuses a zero or negative base rather than returning a usable-looking number', () => {
    expect(() => growthRate(100, 0)).toThrow(/undefined/);
    expect(() => growthRate(100, -50)).toThrow(/not meaningful/);
  });

  it('annualises a period rate by compounding', () => {
    // 1% a quarter compounds to slightly more than 4% a year.
    expect(annualisedGrowthRate(1, 4)).toBeCloseTo(4.060401, 6);
  });

  it('growth contributions sum to the aggregate growth rate', () => {
    // The property that makes contributions publishable at all.
    const previous = { a: 400, b: 350, c: 250 };
    const current = { a: 430, b: 340, c: 265 };
    const aggPrev = previous.a + previous.b + previous.c;
    const aggCurr = current.a + current.b + current.c;
    const contributions = (['a', 'b', 'c'] as const).map((k) =>
      growthContribution(current[k], previous[k], aggPrev),
    );
    expect(sum(contributions)).toBeCloseTo(growthRate(aggCurr, aggPrev), 9);
  });
});

describe('compilation invariants', () => {
  it('the headline always equals the anchored approach', () => {
    const input = {
      production: production(makeIndustries(20)),
      expenditure: {
        householdFinalConsumption: 900,
        npishFinalConsumption: 60,
        governmentFinalConsumption: 300,
        grossFixedCapitalFormation: 300,
        changesInInventories: 40,
        acquisitionsLessDisposalsOfValuables: 10,
        exports: 700,
        imports: 710,
      },
      income: {
        compensationOfEmployees: 800,
        grossOperatingSurplus: 350,
        grossMixedIncome: 100,
        taxesOnProductionAndImports: 420,
        subsidies: 70,
      },
    };
    for (const anchor of ['production', 'expenditure', 'income'] as const) {
      const result = compileGdp(input, { anchor });
      const anchored = result.approaches.find((a) => a.approach === anchor)!;
      expect(result.gdp).toBe(anchored.gdp);
      expect(anchored.discrepancy).toBe(0);
    }
  });

  it('discrepancies are antisymmetric between any two anchors', () => {
    const input = {
      production: production(makeIndustries(20)),
      income: {
        compensationOfEmployees: 800,
        grossOperatingSurplus: 350,
        grossMixedIncome: 100,
        taxesOnProductionAndImports: 420,
        subsidies: 70,
      },
    };
    const onProduction = compileGdp(input, { anchor: 'production' }).approaches.find(
      (a) => a.approach === 'income',
    )!.discrepancy!;
    const onIncome = compileGdp(input, { anchor: 'income' }).approaches.find(
      (a) => a.approach === 'production',
    )!.discrepancy!;
    expect(onProduction).toBeCloseTo(-onIncome, 6);
  });
});
