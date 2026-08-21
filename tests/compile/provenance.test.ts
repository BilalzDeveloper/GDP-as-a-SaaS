// Which observations produced which figure, and whether the record of it
// survives a re-execution.
//
// This is the pure half: the definition of which rows fed which figure, which
// the assembler sums by and execution records. The stored half — that the
// record survives a re-execution and stays inside the run's own vintage —
// is in execute.test.ts, where a real run already exists.
import { describe, expect, it } from 'vitest';
import { contributingRows, contributingRowsForGdp } from '../../src/compile/sources';
import { MEASURE } from '../../src/compile/measures';
import type { ObservationRow } from '../../src/compile/assemble';

let seq = 0;
const row = (
  transactionCode: string,
  value: number,
  extra: Partial<ObservationRow> = {},
): ObservationRow => ({
  observationId: String(++seq),
  periodId: 'p1',
  periodLabel: '2023',
  transactionCode,
  activityItemId: null,
  activityCode: null,
  sectorItemId: null,
  sectorCode: null,
  value,
  unitCode: 'NC_MN',
  valuation: null,
  ...extra,
});

describe('the definition of what fed a figure', () => {
  const ROWS = [
    row('P.1', 1000, { activityItemId: 'item-C', activityCode: 'C' }),
    row('P.2', 400, { activityItemId: 'item-C', activityCode: 'C' }),
    row('P.1', 500, { activityItemId: 'item-K', activityCode: 'K' }),
    row('D.21', 100),
    row('D.31', 20),
    row('P.31', 700, { sectorItemId: 'item-S.14', sectorCode: 'S.14' }),
    row('P.3', 200, { sectorItemId: 'item-S.13', sectorCode: 'S.13' }),
    row('P.6', 100),
    row('P.7', 170),
    row('POP', 8000),
  ];

  const codes = (rows: ObservationRow[]) => rows.map((r) => r.transactionCode).sort();

  it('takes both sides of the account for one industry', () => {
    const found = contributingRows(ROWS, MEASURE.grossValueAdded, 'item-C');
    expect(codes(found)).toEqual(['P.1', 'P.2']);
    expect(found.every((r) => r.activityCode === 'C')).toBe(true);
  });

  it('keeps one industry out of another industry’s figure', () => {
    const found = contributingRows(ROWS, MEASURE.output, 'item-K');
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe(500);
  });

  it('gathers final consumption across sectors and codes', () => {
    // The point of recording provenance rather than looking it up: these two
    // rows share no transaction code and are told apart by sector alone.
    const found = contributingRows(ROWS, MEASURE.finalConsumptionExpenditure);
    expect(codes(found)).toEqual(['P.3', 'P.31']);
    expect(found.map((r) => r.sectorCode).sort()).toEqual(['S.13', 'S.14']);
  });

  it('does not sweep an industry row into a total-economy figure', () => {
    const withStray = [
      ...ROWS,
      row('P.31', 50, { activityItemId: 'item-C', activityCode: 'C' }),
    ];
    const found = contributingRows(withStray, MEASURE.finalConsumptionExpenditure);
    expect(found.every((r) => r.activityItemId === null)).toBe(true);
  });

  it('offers nothing for a measure computed from other results', () => {
    // Per-capita and the growth rates are derived from stored figures, not
    // from observations. An empty list is the honest answer; a link to an
    // empty table would not be.
    expect(contributingRows(ROWS, MEASURE.gdpPerCapita)).toEqual([]);
    expect(contributingRows(ROWS, MEASURE.gdpGrowthPercent)).toEqual([]);
  });

  it('finds the population behind the per-capita denominator', () => {
    expect(contributingRows(ROWS, MEASURE.population)).toHaveLength(1);
  });

  it('takes the whole of an approach for its GDP total', () => {
    const production = contributingRowsForGdp(ROWS, 'production');
    expect(codes(production)).toEqual(['D.21', 'D.31', 'P.1', 'P.1', 'P.2']);
    // The memorandum item is never part of an aggregate (D42).
    expect(production.some((r) => r.transactionCode === 'POP')).toBe(false);
  });

  it('counts the adjustment codes as part of the production figure', () => {
    // FISIM is not a component of GDP but it changes it, so a reviewer
    // drilling into the production total has to see it (D45).
    const withFisim = [...ROWS, row('FISIM.P1', 60), row('FISIM.P2', 40, {
      activityItemId: 'item-C', activityCode: 'C',
    })];
    const found = contributingRowsForGdp(withFisim, 'production');
    expect(codes(found).filter((c) => c.startsWith('FISIM'))).toEqual([
      'FISIM.P1', 'FISIM.P2',
    ]);
  });

  it('keeps the approaches apart', () => {
    const expenditure = contributingRowsForGdp(ROWS, 'expenditure');
    expect(expenditure.some((r) => r.transactionCode === 'P.1')).toBe(false);
    expect(codes(expenditure)).toEqual(['P.3', 'P.31', 'P.6', 'P.7']);
  });
});
