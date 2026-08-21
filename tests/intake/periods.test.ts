// Reference periods for a fiscal year. Small surface, but it is the one
// place the product does calendar arithmetic, and getting a fiscal year wrong
// silently misdates every figure an organization ever publishes.
import { describe, expect, it } from 'vitest';
import { fiscalYearLabel, generatePeriods } from '@/intake/periods';

describe('a calendar year', () => {
  const periods = generatePeriods(2024, 1);

  it('runs January to December', () => {
    const annual = periods.find((p) => p.frequency === 'annual')!;
    expect(annual.startDate).toBe('2024-01-01');
    expect(annual.endDate).toBe('2024-12-31');
    expect(annual.label).toBe('2024');
  });

  it('is labelled by the year alone, with no FY prefix', () => {
    expect(fiscalYearLabel(2024, 1)).toBe('2024');
    expect(periods.map((p) => p.label)).toEqual([
      '2024', '2024-Q1', '2024-Q2', '2024-Q3', '2024-Q4',
    ]);
  });

  it('splits into the four calendar quarters', () => {
    const quarters = periods.filter((p) => p.frequency === 'quarterly');
    expect(quarters.map((q) => [q.startDate, q.endDate])).toEqual([
      ['2024-01-01', '2024-03-31'],
      ['2024-04-01', '2024-06-30'],
      ['2024-07-01', '2024-09-30'],
      ['2024-10-01', '2024-12-31'],
    ]);
  });

  it('handles a leap year', () => {
    // 2024 is a leap year: Q1 ends on the 31st either way, but February's
    // length has to come from the calendar rather than a fixed table.
    const q1 = generatePeriods(2024, 2).find((p) => p.frequency === 'quarterly')!;
    expect(q1.startDate).toBe('2024-02-01');
    expect(q1.endDate).toBe('2024-04-30');
    const nonLeap = generatePeriods(2023, 2).find((p) => p.frequency === 'quarterly')!;
    expect(nonLeap.endDate).toBe('2023-04-30');
    // The February-starting annual year: 2024-02-01 to 2025-01-31.
    const annual = generatePeriods(2024, 2).find((p) => p.frequency === 'annual')!;
    expect([annual.startDate, annual.endDate]).toEqual(['2024-02-01', '2025-01-31']);
  });
});

describe('a July-to-June fiscal year (Australia)', () => {
  const periods = generatePeriods(2024, 7);

  it('runs from July to the following June', () => {
    const annual = periods.find((p) => p.frequency === 'annual')!;
    expect([annual.startDate, annual.endDate]).toEqual(['2024-07-01', '2025-06-30']);
  });

  it('is labelled by the year it begins in', () => {
    expect(fiscalYearLabel(2024, 7)).toBe('FY2024/25');
  });

  it('numbers quarters from the start of the fiscal year, not the calendar', () => {
    // Q1 of a July year is July–September. Numbering by the calendar would
    // put "Q1" in the middle of the fiscal year, which is what an office
    // running a non-calendar year does NOT mean.
    const quarters = periods.filter((p) => p.frequency === 'quarterly');
    expect(quarters.map((q) => [q.label, q.startDate, q.endDate])).toEqual([
      ['FY2024/25-Q1', '2024-07-01', '2024-09-30'],
      ['FY2024/25-Q2', '2024-10-01', '2024-12-31'],
      ['FY2024/25-Q3', '2025-01-01', '2025-03-31'],
      ['FY2024/25-Q4', '2025-04-01', '2025-06-30'],
    ]);
  });
});

describe('an April-to-March fiscal year (India, UK government)', () => {
  it('crosses the calendar year boundary correctly', () => {
    const periods = generatePeriods(2024, 4);
    const annual = periods.find((p) => p.frequency === 'annual')!;
    expect([annual.startDate, annual.endDate]).toEqual(['2024-04-01', '2025-03-31']);
    expect(annual.label).toBe('FY2024/25');
  });
});

describe('an October-to-September fiscal year (US federal)', () => {
  it('runs October to September', () => {
    const annual = generatePeriods(2024, 10).find((p) => p.frequency === 'annual')!;
    expect([annual.startDate, annual.endDate]).toEqual(['2024-10-01', '2025-09-30']);
  });

  it('labels the turn of the century without losing the zero', () => {
    expect(fiscalYearLabel(2099, 10)).toBe('FY2099/00');
    expect(fiscalYearLabel(2009, 10)).toBe('FY2009/10');
  });
});

describe('invariants that must hold for every start month', () => {
  it('has quarters that tile the year with no gap and no overlap', () => {
    for (let month = 1; month <= 12; month++) {
      const periods = generatePeriods(2024, month);
      const annual = periods.find((p) => p.frequency === 'annual')!;
      const quarters = periods.filter((p) => p.frequency === 'quarterly');

      expect(quarters).toHaveLength(4);
      expect(quarters[0].startDate).toBe(annual.startDate);
      expect(quarters[3].endDate).toBe(annual.endDate);

      for (let i = 1; i < 4; i++) {
        const previousEnd = Date.parse(quarters[i - 1].endDate + 'T00:00:00Z');
        const thisStart = Date.parse(quarters[i].startDate + 'T00:00:00Z');
        expect(
          thisStart - previousEnd,
          `gap between Q${i} and Q${i + 1} for start month ${month}`,
        ).toBe(24 * 60 * 60 * 1000);
      }
    }
  });

  it('ends the day before the next fiscal year begins', () => {
    for (let month = 1; month <= 12; month++) {
      const thisYear = generatePeriods(2024, month).find((p) => p.frequency === 'annual')!;
      const nextYear = generatePeriods(2025, month).find((p) => p.frequency === 'annual')!;
      const end = Date.parse(thisYear.endDate + 'T00:00:00Z');
      const start = Date.parse(nextYear.startDate + 'T00:00:00Z');
      expect(start - end, `start month ${month}`).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('carries the fiscal year on every period it generates', () => {
    for (const period of generatePeriods(2024, 7)) {
      // The fiscal year is what groups quarters into their annual benchmark
      // (docs/quarterly-accounts.md); a quarter falling in calendar 2025 must
      // still carry 2024.
      expect(period.fiscalYear).toBe(2024);
    }
  });
});

describe('what it refuses and what it can skip', () => {
  it('generates only what was asked for', () => {
    expect(generatePeriods(2024, 1, { quarterly: false })).toHaveLength(1);
    expect(generatePeriods(2024, 1, { annual: false })).toHaveLength(4);
    expect(generatePeriods(2024, 1, { annual: false, quarterly: false })).toEqual([]);
  });

  it('rejects a month that is not a month', () => {
    expect(() => generatePeriods(2024, 0)).toThrow(/month number/);
    expect(() => generatePeriods(2024, 13)).toThrow(/month number/);
    expect(() => generatePeriods(2024, 1.5)).toThrow(/month number/);
  });

  it('rejects a year outside anything a compilation would use', () => {
    expect(() => generatePeriods(1800, 1)).toThrow(/supported range/);
    expect(() => generatePeriods(2.024, 1)).toThrow(/supported range/);
  });
});
