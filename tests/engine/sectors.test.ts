// Value added by institutional sector.
//
// SNA 2008 ch.4: every producer belongs both to an industry and to an
// institutional sector, so the production account can be summed either way
// from the same records. This is the second cut.
//
// The coverage check is the part that matters. A sector breakdown covering
// only some producers, published as though it were the whole economy, would
// understate whichever sectors the uncovered producers belong to — and
// nothing on the face of the table would show it.
import { describe, expect, it } from 'vitest';
import { computeProductionApproach } from '../../src/engine/production';
import type { ProductionInput } from '../../src/engine/types';

/** Σ GVA = (1000−400) + (500−200) = 900; GDP = 900 + 100 − 20 = 980. */
const BASE: ProductionInput = {
  outputValuation: 'basic',
  industries: [
    { code: 'C', output: 1000, intermediateConsumption: 400 },
    { code: 'K', output: 500, intermediateConsumption: 200 },
  ],
  taxesOnProducts: 100,
  subsidiesOnProducts: 20,
};

/** The same producers, grouped by what kind of unit they are. */
const SECTORS = [
  { code: 'S.11', output: 1100, intermediateConsumption: 450 },
  { code: 'S.12', output: 400, intermediateConsumption: 150 },
];

describe('value added by institutional sector', () => {
  it('is absent unless the compilation supplies the dimension', () => {
    const result = computeProductionApproach(BASE);
    expect(result.bySector).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it('computes B.1g for each sector', () => {
    const result = computeProductionApproach({
      ...BASE,
      institutionalSectors: SECTORS,
    });
    expect(result.bySector).toEqual([
      { code: 'S.11', output: 1100, intermediateConsumption: 450, grossValueAdded: 650 },
      { code: 'S.12', output: 400, intermediateConsumption: 150, grossValueAdded: 250 },
    ]);
  });

  it('leaves GDP untouched — it is a second view, not a second total', () => {
    const without = computeProductionApproach(BASE);
    const withSectors = computeProductionApproach({
      ...BASE,
      institutionalSectors: SECTORS,
    });
    expect(withSectors.gdp).toBe(without.gdp);
    expect(withSectors.totalGrossValueAdded).toBe(without.totalGrossValueAdded);
  });

  it('says nothing when the two cuts agree', () => {
    // 650 + 250 = 900 = (1000−400) + (500−200).
    const result = computeProductionApproach({
      ...BASE,
      institutionalSectors: SECTORS,
    });
    expect(
      result.diagnostics.map((d) => d.code),
    ).not.toContain('sector_value_added_incomplete');
  });

  it('reports a sector breakdown that covers only part of the economy', () => {
    // Only the financial sector carries a sector code: 250 against 900.
    const result = computeProductionApproach({
      ...BASE,
      institutionalSectors: [SECTORS[1]],
    });
    const diagnostic = result.diagnostics.find(
      (d) => d.code === 'sector_value_added_incomplete',
    );
    expect(diagnostic?.severity).toBe('warning');
    expect(diagnostic?.message).toContain('250');
    expect(diagnostic?.message).toContain('900');
    // And it still returns the partial figures rather than withholding them —
    // a partial breakdown is useful once it is labelled as one.
    expect(result.bySector).toHaveLength(1);
  });

  it('compares against the industries as supplied, not as adjusted', () => {
    // FISIM raises industry C's intermediate consumption by 40, lowering the
    // industry total to 860. The sector rows are unadjusted and still sum to
    // 900, which matches what was supplied — so there is no coverage gap and
    // no diagnostic. Comparing against the adjusted total would invent one.
    const result = computeProductionApproach({
      ...BASE,
      institutionalSectors: SECTORS,
      fisim: {
        totalOutput: 60,
        intermediateByIndustry: { C: 40 },
        householdFinalConsumption: 15,
        governmentFinalConsumption: 0,
        exports: 5,
      },
    });
    expect(result.totalGrossValueAdded).toBe(860);
    expect(
      result.diagnostics.map((d) => d.code),
    ).not.toContain('sector_value_added_incomplete');
  });

  it('flags a sector with negative value added', () => {
    const result = computeProductionApproach({
      ...BASE,
      institutionalSectors: [
        { code: 'S.11', output: 1100, intermediateConsumption: 450 },
        { code: 'S.12', output: 100, intermediateConsumption: 500 },
      ],
    });
    const negative = result.diagnostics.filter(
      (d) => d.code === 'negative_value_added' && d.subject === 'S.12',
    );
    expect(negative).toHaveLength(1);
  });

  it('tolerates a rounding-sized difference between the cuts', () => {
    const result = computeProductionApproach({
      ...BASE,
      institutionalSectors: [
        { code: 'S.11', output: 1100.0000001, intermediateConsumption: 450 },
        { code: 'S.12', output: 400, intermediateConsumption: 150 },
      ],
    });
    expect(
      result.diagnostics.map((d) => d.code),
    ).not.toContain('sector_value_added_incomplete');
  });

  it('refuses a non-finite figure like every other input', () => {
    expect(() =>
      computeProductionApproach({
        ...BASE,
        institutionalSectors: [
          { code: 'S.11', output: Number.NaN, intermediateConsumption: 0 },
        ],
      }),
    ).toThrow(/S\.11/);
  });
});
