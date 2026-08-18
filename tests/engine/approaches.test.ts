// The three approaches, their identities, and the methodological handling
// that a statistician will look for first: FISIM, imputed rent, valuation
// conversion and sign conventions.
import { describe, expect, it } from 'vitest';
import {
  basicPricesFromProducers,
  computeExpenditureApproach,
  computeIncomeApproach,
  computeProductionApproach,
  grossValueAdded,
  netTaxesOnProductionAndImports,
  totalFactorIncomes,
} from '../../src/engine';
import type { ProductionInput } from '../../src/engine';

const baseIndustries = [
  { code: 'A', output: 500, intermediateConsumption: 200 },
  { code: 'C', output: 2000, intermediateConsumption: 1200 },
  { code: 'K', output: 400, intermediateConsumption: 150 },
];

function production(overrides: Partial<ProductionInput> = {}): ProductionInput {
  return {
    outputValuation: 'basic',
    industries: baseIndustries,
    taxesOnProducts: 320,
    subsidiesOnProducts: 70,
    ...overrides,
  };
}

describe('production approach', () => {
  it('computes value added as output less intermediate consumption', () => {
    expect(grossValueAdded(500, 200)).toBe(300);
  });

  it('sums value added and applies taxes less subsidies on products', () => {
    const result = computeProductionApproach(production());
    // 300 + 800 + 250 = 1350; 1350 + 320 − 70 = 1600
    expect(result.totalGrossValueAdded).toBe(1350);
    expect(result.gdp).toBe(1600);
  });

  it('reports value added for every industry', () => {
    const result = computeProductionApproach(production());
    expect(result.industries.map((i) => [i.code, i.grossValueAdded])).toEqual([
      ['A', 300],
      ['C', 800],
      ['K', 250],
    ]);
  });

  it('refuses producers-price output rather than guessing the conversion', () => {
    expect(() =>
      computeProductionApproach(production({ outputValuation: 'producers' })),
    ).toThrow(/basic prices/);
  });

  it('converts producers prices to basic prices explicitly', () => {
    // Basic price excludes taxes on products and includes subsidies.
    expect(basicPricesFromProducers(1000, 120, 30)).toBe(910);
  });

  it('flags negative value added without refusing to compute', () => {
    const result = computeProductionApproach(
      production({
        industries: [{ code: 'X', output: 100, intermediateConsumption: 150 }],
      }),
    );
    expect(result.industries[0].grossValueAdded).toBe(-50);
    expect(result.diagnostics.map((d) => d.code)).toContain('negative_value_added');
  });

  it('is invariant to the order industries are supplied in', () => {
    const forward = computeProductionApproach(production());
    const reversed = computeProductionApproach(
      production({ industries: [...baseIndustries].reverse() }),
    );
    expect(reversed.gdp).toBe(forward.gdp);
  });
});

describe('production approach — FISIM (SNA 2008 ch.6, ch.17)', () => {
  const withoutFisim = computeProductionApproach(production());

  // Financial corporations' output rises by the FISIM total; the allocation
  // splits it between intermediate use and final use.
  const fisimIndustries = [
    { code: 'A', output: 500, intermediateConsumption: 200 },
    { code: 'C', output: 2000, intermediateConsumption: 1200 },
    { code: 'K', output: 520, intermediateConsumption: 150 }, // +120 FISIM
  ];
  const fisim = {
    totalOutput: 120,
    intermediateByIndustry: { A: 25, C: 60 }, // 85 intermediate
    householdFinalConsumption: 25,
    governmentFinalConsumption: 5,
    exports: 5, // 35 final
  };

  it('allocated: the intermediate portion is GDP-neutral, final use raises GDP', () => {
    const result = computeProductionApproach(
      production({ industries: fisimIndustries, fisim }),
    );
    // Output +120, intermediate consumption +85 ⇒ value added +35, exactly
    // the portion consumed by households, government and non-residents.
    expect(result.gdp - withoutFisim.gdp).toBeCloseTo(35, 9);
    expect(result.diagnostics).toEqual([]);
  });

  it('allocated: charges the allocation to the right industries', () => {
    const result = computeProductionApproach(
      production({ industries: fisimIndustries, fisim }),
    );
    const byCode = Object.fromEntries(result.industries.map((i) => [i.code, i]));
    expect(byCode.A.intermediateConsumption).toBe(225);
    expect(byCode.C.intermediateConsumption).toBe(1260);
    expect(byCode.K.intermediateConsumption).toBe(150);
  });

  it('unallocated: contributes nothing to GDP (the SNA 1993 convention)', () => {
    const result = computeProductionApproach(
      production({
        industries: fisimIndustries,
        fisim: { ...fisim, treatment: 'unallocated' as const },
      }),
    );
    expect(result.gdp).toBeCloseTo(withoutFisim.gdp, 9);
  });

  it('warns when the allocation does not exhaust FISIM output', () => {
    const result = computeProductionApproach(
      production({
        industries: fisimIndustries,
        fisim: { ...fisim, exports: 20 }, // allocations now total 135, not 120
      }),
    );
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'fisim_allocation_mismatch',
    );
  });

  it('warns when FISIM is allocated to an industry that was not supplied', () => {
    const result = computeProductionApproach(
      production({
        industries: fisimIndustries,
        fisim: { ...fisim, intermediateByIndustry: { A: 25, ZZ: 60 } },
      }),
    );
    const missing = result.diagnostics.find((d) => d.code === 'component_missing');
    expect(missing?.subject).toBe('ZZ');
  });
});

describe('production approach — imputed rent (SNA 2008 ch.6)', () => {
  const imputedRent = {
    industryCode: 'L',
    output: 300,
    intermediateConsumption: 50,
  };

  it('adds the net imputed services to GDP', () => {
    const withRent = computeProductionApproach(production({ imputedRent }));
    const withoutRent = computeProductionApproach(production());
    expect(withRent.gdp - withoutRent.gdp).toBe(250);
  });

  it('creates the housing industry when it is not already present', () => {
    const result = computeProductionApproach(production({ imputedRent }));
    const housing = result.industries.find((i) => i.code === 'L');
    expect(housing?.grossValueAdded).toBe(250);
  });

  it('folds into an existing housing industry rather than duplicating it', () => {
    const result = computeProductionApproach(
      production({
        industries: [
          ...baseIndustries,
          { code: 'L', output: 100, intermediateConsumption: 20 },
        ],
        imputedRent,
      }),
    );
    const housing = result.industries.filter((i) => i.code === 'L');
    expect(housing).toHaveLength(1);
    expect(housing[0].output).toBe(400);
    expect(housing[0].grossValueAdded).toBe(330);
  });
});

describe('expenditure approach', () => {
  const base = {
    householdFinalConsumption: 1700,
    npishFinalConsumption: 60,
    governmentFinalConsumption: 550,
    grossFixedCapitalFormation: 600,
    changesInInventories: 40,
    acquisitionsLessDisposalsOfValuables: 10,
    exports: 700,
    imports: 710,
  };

  it('sums the components and deducts imports', () => {
    const result = computeExpenditureApproach(base);
    expect(result.finalConsumptionExpenditure).toBe(2310);
    expect(result.grossCapitalFormation).toBe(650);
    expect(result.netExports).toBe(-10);
    expect(result.gdp).toBe(2950);
  });

  it('treats a drawdown of inventories as a reduction in GDP', () => {
    const result = computeExpenditureApproach({
      ...base,
      changesInInventories: -40,
    });
    expect(result.gdp).toBe(2870);
  });

  it('accepts negative net acquisitions of valuables', () => {
    const result = computeExpenditureApproach({
      ...base,
      acquisitionsLessDisposalsOfValuables: -10,
    });
    expect(result.gdp).toBe(2930);
  });

  it('raising imports lowers GDP one for one', () => {
    const result = computeExpenditureApproach({ ...base, imports: 810 });
    expect(result.gdp).toBe(2850);
  });

  it('warns when imports arrive already negated', () => {
    const result = computeExpenditureApproach({ ...base, imports: -710 });
    expect(result.diagnostics.map((d) => d.subject)).toContain('imports');
  });
});

describe('income approach', () => {
  const base = {
    compensationOfEmployees: 1500,
    grossOperatingSurplus: 800,
    grossMixedIncome: 300,
    taxesOnProductionAndImports: 420,
    subsidies: 70,
  };

  it('sums factor incomes and net taxes on production and imports', () => {
    const result = computeIncomeApproach(base);
    expect(result.totalFactorIncomes).toBe(2600);
    expect(result.netTaxesOnProductionAndImports).toBe(350);
    expect(result.gdp).toBe(2950);
  });

  it('exposes the component identities directly', () => {
    expect(totalFactorIncomes(1500, 800, 300)).toBe(2600);
    expect(netTaxesOnProductionAndImports(420, 70)).toBe(350);
  });

  it('raising subsidies lowers GDP one for one', () => {
    expect(computeIncomeApproach({ ...base, subsidies: 170 }).gdp).toBe(2850);
  });

  it('warns when subsidies arrive already negated', () => {
    const result = computeIncomeApproach({ ...base, subsidies: -70 });
    expect(result.diagnostics.map((d) => d.subject)).toContain('subsidies');
  });
});

describe('input validation', () => {
  it('rejects non-finite figures rather than propagating NaN', () => {
    expect(() =>
      computeProductionApproach(
        production({
          industries: [{ code: 'A', output: Number.NaN, intermediateConsumption: 0 }],
        }),
      ),
    ).toThrow(/finite number/);
  });
});
