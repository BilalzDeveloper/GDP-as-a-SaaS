// The assembler turns stored observations into engine inputs. Its most
// important property is negative: it must never quietly produce a total from
// an incomplete account, because that total is wrong in a way that looks
// entirely plausible.
import { describe, expect, it } from 'vitest';
import { assemblePeriod, assembleRun, type ObservationRow } from '../../src/compile/assemble';

function obs(
  transactionCode: string,
  value: number,
  extra: Partial<ObservationRow> = {},
): ObservationRow {
  return {
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
  };
}

const industry = (code: string, txn: string, value: number) =>
  obs(txn, value, { activityItemId: `item-${code}`, activityCode: code, valuation: 'basic' });

/** Consumption filed against the sector that did it — the fuller form. */
const sector = (txn: string, code: string, value: number) =>
  obs(txn, value, { sectorItemId: `item-${code}`, sectorCode: code });

const fullExpenditure = [
  sector('P.31', 'S.14', 1700), sector('P.31', 'S.15', 60), sector('P.3', 'S.13', 550),
  obs('P.51g', 600), obs('P.52', 40), obs('P.53', 10),
  obs('P.6', 700), obs('P.7', 710),
];

/**
 * The same account from a compilation that keeps no sector dimension, which
 * is legitimate and common. Only the codes that name a sector unambiguously
 * can be read this way: P.31 individual consumption for households, P.32
 * collective consumption for government.
 */
const sectorlessExpenditure = [
  obs('P.31', 1700), obs('P.32', 550),
  obs('P.51g', 600), obs('P.52', 40), obs('P.53', 10),
  obs('P.6', 700), obs('P.7', 710),
];

const fullIncome = [
  obs('D.1', 1500), obs('B.2g', 800), obs('B.3g', 300),
  obs('D.2', 420), obs('D.3', 70),
];

describe('production approach', () => {
  it('builds industries from P.1 and P.2 and adds the product taxes', () => {
    const result = assemblePeriod('p1', '2023', [
      industry('A', 'P.1', 500),
      industry('A', 'P.2', 200),
      industry('C', 'P.1', 2000),
      industry('C', 'P.2', 1200),
      obs('D.21', 320),
      obs('D.31', 70),
    ]);
    expect(result.production?.industries).toHaveLength(2);
    expect(result.production?.taxesOnProducts).toBe(320);
    expect(result.production?.subsidiesOnProducts).toBe(70);
    expect(result.problems).toEqual([]);
  });

  it('withholds production when taxes on products are absent', () => {
    // GDP at market prices cannot be derived from basic-price value added
    // without D.21, so no total is produced.
    const result = assemblePeriod('p1', '2023', [
      industry('A', 'P.1', 500),
      industry('A', 'P.2', 200),
    ]);
    expect(result.production).toBeUndefined();
    expect(result.problems[0].code).toBe('missing_component');
    expect(result.problems[0].message).toContain('D.21');
  });

  it('treats absent subsidies as zero but says so', () => {
    const result = assemblePeriod('p1', '2023', [
      industry('A', 'P.1', 500),
      industry('A', 'P.2', 200),
      obs('D.21', 320),
    ]);
    expect(result.production?.subsidiesOnProducts).toBe(0);
    expect(result.problems.map((p) => p.message.includes('D.31'))).toContain(true);
  });

  it('refuses producers-price output rather than converting it', () => {
    const result = assemblePeriod('p1', '2023', [
      obs('P.1', 500, {
        activityItemId: 'item-A', activityCode: 'A', valuation: 'producers',
      }),
      obs('D.21', 320),
    ]);
    expect(result.production).toBeUndefined();
    expect(result.problems[0].code).toBe('wrong_valuation');
  });

  it('flags observations denominated in different units', () => {
    const result = assemblePeriod('p1', '2023', [
      industry('A', 'P.1', 500),
      obs('P.2', 200, {
        activityItemId: 'item-A', activityCode: 'A', unitCode: 'NC_TH', valuation: 'basic',
      }),
      obs('D.21', 320),
    ]);
    expect(result.problems.map((p) => p.code)).toContain('mixed_units');
  });

  it('sums repeated rows for the same industry and transaction', () => {
    const result = assemblePeriod('p1', '2023', [
      industry('A', 'P.1', 300),
      industry('A', 'P.1', 200),
      industry('A', 'P.2', 200),
      obs('D.21', 0),
    ]);
    expect(result.production?.industries[0].output).toBe(500);
  });

  it('is silent when there is no production data at all', () => {
    const result = assemblePeriod('p1', '2023', fullIncome);
    expect(result.production).toBeUndefined();
    expect(result.problems.filter((p) => p.approach === 'production')).toEqual([]);
  });
});

describe('expenditure approach', () => {
  it('assembles a complete account', () => {
    const result = assemblePeriod('p1', '2023', fullExpenditure);
    expect(result.expenditure?.householdFinalConsumption).toBe(1700);
    expect(result.expenditure?.imports).toBe(710);
    expect(result.problems).toEqual([]);
  });

  it('withholds the approach when a required component is missing', () => {
    const result = assemblePeriod(
      'p1', '2023',
      fullExpenditure.filter((o) => o.transactionCode !== 'P.7'),
    );
    expect(result.expenditure).toBeUndefined();
    const problem = result.problems.find((p) => p.approach === 'expenditure');
    expect(problem?.message).toContain('P.7');
    expect(problem?.message).toContain('looks plausible');
  });

  it('treats the genuinely optional components as zero', () => {
    // Several countries fold NPISH into households and report no valuables.
    const result = assemblePeriod(
      'p1', '2023',
      fullExpenditure.filter(
        (o) => o.sectorCode !== 'S.15' && !['P.52', 'P.53'].includes(o.transactionCode),
      ),
    );
    expect(result.expenditure?.npishFinalConsumption).toBe(0);
    expect(result.expenditure?.changesInInventories).toBe(0);
    expect(result.expenditure?.acquisitionsLessDisposalsOfValuables).toBe(0);
    expect(result.expenditure).toBeDefined();
  });

  it('reads a compilation that keeps no sector dimension', () => {
    const result = assemblePeriod('p1', '2023', sectorlessExpenditure);
    expect(result.expenditure?.householdFinalConsumption).toBe(1700);
    expect(result.expenditure?.governmentFinalConsumption).toBe(550);
  });

  it('says that P.32 alone understates government consumption', () => {
    // P.32 is collective consumption. Government also provides individual
    // services — health and education above all — and those are in P.31 of
    // S.13. Taking P.32 for the whole is often out by more than half, so the
    // figure is used and the shortfall said rather than assumed away.
    const result = assemblePeriod('p1', '2023', sectorlessExpenditure);
    const problem = result.problems.find((p) => p.code === 'sector_coverage');
    expect(problem?.message).toContain('collective consumption only');
    expect(problem?.message).toContain('S.13');
  });

  it('will not read an unqualified P.3 as any one sector', () => {
    // P.3 with no sector is the whole economy's final consumption:
    // households, NPISH and government together. Reading it as government's —
    // which this did until the sector dimension worked — double-counts it
    // against the household figure sitting beside it.
    const rows = sectorlessExpenditure.map((o) =>
      o.transactionCode === 'P.32' ? obs('P.3', 550) : o,
    );
    const result = assemblePeriod('p1', '2023', rows);
    expect(result.expenditure).toBeUndefined();
    expect(
      result.problems.find((p) => p.approach === 'expenditure')?.message,
    ).toContain('S.13');
  });

  it('refuses a sector split and a total-economy figure for the same sector', () => {
    const result = assemblePeriod('p1', '2023', [
      ...fullExpenditure,
      obs('P.31', 1760),
    ]);
    expect(result.expenditure).toBeUndefined();
    const problem = result.problems.find((p) => p.code === 'sector_coverage');
    expect(problem?.message).toContain('double count');
  });

  it('rolls sub-sectors up to the sector that owns them', () => {
    // A compilation keeping central, state and local government separately
    // still has one government final consumption figure. S.1311 and the rest
    // are within S.13 by construction of the SNA numbering.
    const rows = [
      ...fullExpenditure.filter((o) => o.sectorCode !== 'S.13'),
      sector('P.3', 'S.1311', 400),
      sector('P.3', 'S.1313', 150),
    ];
    const result = assemblePeriod('p1', '2023', rows);
    expect(result.expenditure?.governmentFinalConsumption).toBe(550);
  });

  it('does not read the total economy as a sector', () => {
    // S.1 is every sector at once. It is not households, and prefix matching
    // would say it was if it were applied naively.
    const result = assemblePeriod('p1', '2023', [
      ...fullExpenditure.filter((o) => o.sectorCode === null),
      sector('P.31', 'S.1', 2310),
    ]);
    expect(result.expenditure).toBeUndefined();
    expect(
      result.problems.find((p) => p.approach === 'expenditure')?.message,
    ).toContain('S.14');
  });
});

describe('income approach', () => {
  it('assembles a complete account', () => {
    const result = assemblePeriod('p1', '2023', fullIncome);
    expect(result.income?.compensationOfEmployees).toBe(1500);
    expect(result.income?.subsidies).toBe(70);
  });

  it('withholds the approach when a component is missing', () => {
    const result = assemblePeriod(
      'p1', '2023',
      fullIncome.filter((o) => o.transactionCode !== 'B.3g'),
    );
    expect(result.income).toBeUndefined();
    expect(result.problems.find((p) => p.approach === 'income')?.message).toContain('B.3g');
  });
});

describe('assembling a whole run', () => {
  it('groups by period and orders them', () => {
    const rows: ObservationRow[] = [
      ...fullIncome.map((o) => ({ ...o, periodId: 'p2', periodLabel: '2024' })),
      ...fullIncome,
    ];
    const periods = assembleRun(rows);
    expect(periods.map((p) => p.periodLabel)).toEqual(['2023', '2024']);
    expect(periods.every((p) => p.income !== undefined)).toBe(true);
  });

  it('keeps each period independent', () => {
    const rows: ObservationRow[] = [
      ...fullIncome,
      ...fullIncome
        .filter((o) => o.transactionCode !== 'D.2')
        .map((o) => ({ ...o, periodId: 'p2', periodLabel: '2024' })),
    ];
    const periods = assembleRun(rows);
    expect(periods[0].income).toBeDefined();
    expect(periods[1].income).toBeUndefined();
  });

  it('ignores observations whose value is missing', () => {
    const result = assemblePeriod('p1', '2023', [
      industry('A', 'P.1', 500),
      obs('P.1', 0, { activityItemId: 'item-C', activityCode: 'C', valuation: 'basic', value: null }),
      obs('D.21', 100),
    ]);
    // The blank row contributes no output rather than a zero-valued industry.
    const c = result.production?.industries.find((i) => i.code === 'C');
    expect(c?.output).toBe(0);
  });
});
