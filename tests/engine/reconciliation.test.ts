// Reconciliation: the statistical discrepancy, the configurable anchor, and
// the diagnostics a compiler relies on to notice something is wrong.
import { describe, expect, it } from 'vitest';
import { compileGdp, statisticalDiscrepancy } from '../../src/engine';
import type { CompilationInput } from '../../src/engine';

const consistent: CompilationInput = {
  production: {
    outputValuation: 'basic',
    industries: [
      { code: 'A', output: 500, intermediateConsumption: 200 },
      { code: 'C', output: 2000, intermediateConsumption: 1200 },
      { code: 'K', output: 400, intermediateConsumption: 150 },
    ],
    taxesOnProducts: 320,
    subsidiesOnProducts: 70,
  },
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

describe('statistical discrepancy', () => {
  it('is anchor minus the other approach', () => {
    expect(statisticalDiscrepancy(1000, 980)).toBe(20);
    expect(statisticalDiscrepancy(1000, 1020)).toBe(-20);
  });

  it('is exactly zero for mutually consistent accounts', () => {
    const result = compileGdp(consistent);
    expect(result.gdp).toBe(1600);
    for (const a of result.approaches) {
      expect(a.gdp).toBe(1600);
      expect(a.discrepancy).toBe(0);
    }
  });

  it('reports the gap without adjusting either estimate', () => {
    const diverging: CompilationInput = {
      ...consistent,
      expenditure: { ...consistent.expenditure!, exports: 750 },
    };
    const result = compileGdp(diverging, { anchor: 'production' });
    const expenditure = result.approaches.find((a) => a.approach === 'expenditure')!;
    expect(result.gdp).toBe(1600); // headline untouched
    expect(expenditure.gdp).toBe(1650); // estimate untouched
    expect(expenditure.discrepancy).toBe(-50);
    expect(expenditure.discrepancyPercent).toBeCloseTo(-3.125, 6);
  });
});

describe('balancing anchor', () => {
  const diverging: CompilationInput = {
    ...consistent,
    expenditure: { ...consistent.expenditure!, exports: 750 },
    income: { ...consistent.income!, grossOperatingSurplus: 330 },
  };

  it('defaults to the production approach', () => {
    expect(compileGdp(diverging).anchor).toBe('production');
    expect(compileGdp(diverging).gdp).toBe(1600);
  });

  it('publishes whichever approach is nominated', () => {
    expect(compileGdp(diverging, { anchor: 'expenditure' }).gdp).toBe(1650);
    expect(compileGdp(diverging, { anchor: 'income' }).gdp).toBe(1580);
  });

  it('measures every discrepancy against the nominated anchor', () => {
    const result = compileGdp(diverging, { anchor: 'expenditure' });
    const byApproach = Object.fromEntries(
      result.approaches.map((a) => [a.approach, a.discrepancy]),
    );
    expect(byApproach.expenditure).toBe(0);
    expect(byApproach.production).toBe(50);
    expect(byApproach.income).toBe(70);
  });

  it("publishes no headline when the anchor is 'none'", () => {
    const result = compileGdp(diverging, { anchor: 'none' });
    expect(result.gdp).toBeNull();
    expect(result.approaches).toHaveLength(3);
    for (const a of result.approaches) {
      expect(a.discrepancy).toBeNull();
      expect(a.gdp).toBeGreaterThan(0);
    }
  });

  it('refuses an anchor with no corresponding input', () => {
    expect(() =>
      compileGdp({ production: consistent.production }, { anchor: 'income' }),
    ).toThrow(/no income input/);
  });

  it('compiles from a single approach, anchoring on it by default', () => {
    const result = compileGdp({ income: consistent.income });
    expect(result.approaches).toHaveLength(1);
    expect(result.anchor).toBe('income');
    expect(result.gdp).toBe(1600);
  });

  it('still prefers production by default when it is available', () => {
    const result = compileGdp({
      production: consistent.production,
      income: consistent.income,
    });
    expect(result.anchor).toBe('production');
  });

  it('requires an explicit anchor when two approaches exclude production', () => {
    expect(() =>
      compileGdp({ expenditure: consistent.expenditure, income: consistent.income }),
    ).toThrow(/no production input/);
  });

  it('requires at least one approach', () => {
    expect(() => compileGdp({})).toThrow(/at least one approach/);
  });
});

describe('divergence diagnostics', () => {
  it('warns once a discrepancy exceeds the threshold', () => {
    const diverging: CompilationInput = {
      ...consistent,
      expenditure: { ...consistent.expenditure!, exports: 750 },
    };
    const result = compileGdp(diverging, { anchor: 'production' });
    const warning = result.diagnostics.find((d) => d.code === 'approaches_diverge');
    expect(warning?.subject).toBe('expenditure');
    expect(warning?.message).toContain('3.13%');
  });

  it('stays quiet for a discrepancy within the threshold', () => {
    const barelyOff: CompilationInput = {
      ...consistent,
      expenditure: { ...consistent.expenditure!, exports: 705 },
    };
    const result = compileGdp(barelyOff, { anchor: 'production' });
    expect(result.diagnostics.filter((d) => d.code === 'approaches_diverge')).toEqual([]);
  });

  it('honours a stricter threshold', () => {
    const barelyOff: CompilationInput = {
      ...consistent,
      expenditure: { ...consistent.expenditure!, exports: 705 },
    };
    const result = compileGdp(barelyOff, {
      anchor: 'production',
      discrepancyWarningThreshold: 0.001,
    });
    expect(result.diagnostics.filter((d) => d.code === 'approaches_diverge')).toHaveLength(1);
  });

  it('collects diagnostics raised inside the individual approaches', () => {
    const result = compileGdp({
      ...consistent,
      production: {
        ...consistent.production!,
        industries: [{ code: 'X', output: 10, intermediateConsumption: 90 }],
      },
    });
    expect(result.diagnostics.map((d) => d.code)).toContain('negative_value_added');
  });
});

describe('imputed rent consistency across the two sides of the account', () => {
  const withRent: CompilationInput = {
    production: {
      ...consistent.production!,
      imputedRent: { industryCode: 'L', output: 300, intermediateConsumption: 50 },
    },
    expenditure: consistent.expenditure,
  };

  it('warns when expenditure explicitly excludes it', () => {
    const result = compileGdp({
      ...withRent,
      expenditure: { ...withRent.expenditure!, includesImputedRent: false },
    });
    const d = result.diagnostics.find((x) => x.code === 'imputed_rent_not_in_expenditure');
    expect(d?.severity).toBe('warning');
  });

  it('asks for confirmation when the caller has not said either way', () => {
    const result = compileGdp(withRent);
    const d = result.diagnostics.find((x) => x.code === 'imputed_rent_not_in_expenditure');
    expect(d?.severity).toBe('info');
  });

  it('says nothing once the caller confirms it is included', () => {
    const result = compileGdp({
      ...withRent,
      expenditure: { ...withRent.expenditure!, includesImputedRent: true },
    });
    expect(
      result.diagnostics.filter((x) => x.code === 'imputed_rent_not_in_expenditure'),
    ).toEqual([]);
  });
});
