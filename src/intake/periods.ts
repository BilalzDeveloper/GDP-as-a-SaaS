// Generating an organization's reference periods for a fiscal year.
//
// Pure: dates in, dates out, no database and no `new Date()` for "now". A
// reference period is a fact about a calendar, and this is the one place the
// product does calendar arithmetic — the calculation engine deliberately does
// none, because a fiscal year is a national convention rather than a
// statistical one.
//
// SNA 2008 ch.2 treats the accounting period as given; the manual does not
// prescribe a January start, and most of the world does not use one.
// Australia runs July to June, India April to March, Japan and the United
// Kingdom April to March for government, the United States federal year
// October to September.

export type PeriodFrequency = 'annual' | 'quarterly';

export interface GeneratedPeriod {
  frequency: PeriodFrequency;
  /** ISO date, inclusive. */
  startDate: string;
  /** ISO date, inclusive — the day before the next period begins. */
  endDate: string;
  label: string;
  fiscalYear: number;
}

const iso = (utcMs: number): string => new Date(utcMs).toISOString().slice(0, 10);

/** First of the month, `months` after the start of `year`'s month `month`. */
const monthStart = (year: number, month: number, months: number): number =>
  Date.UTC(year, month - 1 + months, 1);

/** The day before a given instant — how an inclusive end date is expressed. */
const dayBefore = (utcMs: number): number => utcMs - 24 * 60 * 60 * 1000;

/**
 * The label an organization's fiscal year carries.
 *
 * A January start is a calendar year and is labelled as one: `2024`. Anything
 * else is labelled `FY2024/25`, naming the year the period *begins* in — the
 * Australian and US federal convention.
 *
 * The alternative convention names the year it ends in (the UK's 2024/25 is
 * often written "2025"), which would make the same twelve months carry a
 * different name. Rather than guess, the label is stored on the period, so an
 * organization that wants the other convention can define its periods with
 * whatever labels its publications already use — nothing downstream parses
 * these strings (see `docs/quarterly-accounts.md`).
 */
export function fiscalYearLabel(fiscalYear: number, startMonth: number): string {
  if (startMonth === 1) return String(fiscalYear);
  const next = String((fiscalYear + 1) % 100).padStart(2, '0');
  return `FY${fiscalYear}/${next}`;
}

export interface GeneratePeriodsOptions {
  annual?: boolean;
  quarterly?: boolean;
}

/**
 * The periods covering one fiscal year.
 *
 * Quarters are three-month blocks from the fiscal year's start, so Q1 of a
 * July-to-June year is July–September. That is what every office running a
 * non-calendar year means by "Q1", and numbering quarters by the calendar
 * instead would put the year's first quarter in the middle of its label.
 */
export function generatePeriods(
  fiscalYear: number,
  fiscalYearStartMonth: number,
  options: GeneratePeriodsOptions = {},
): GeneratedPeriod[] {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) {
    throw new RangeError(`Fiscal year ${fiscalYear} is outside the supported range`);
  }
  if (
    !Number.isInteger(fiscalYearStartMonth) ||
    fiscalYearStartMonth < 1 ||
    fiscalYearStartMonth > 12
  ) {
    throw new RangeError('Fiscal year start month must be a month number, 1 to 12');
  }
  const { annual = true, quarterly = true } = options;

  const label = fiscalYearLabel(fiscalYear, fiscalYearStartMonth);
  const periods: GeneratedPeriod[] = [];

  if (annual) {
    periods.push({
      frequency: 'annual',
      startDate: iso(monthStart(fiscalYear, fiscalYearStartMonth, 0)),
      endDate: iso(dayBefore(monthStart(fiscalYear, fiscalYearStartMonth, 12))),
      label,
      fiscalYear,
    });
  }

  if (quarterly) {
    for (let q = 0; q < 4; q++) {
      periods.push({
        frequency: 'quarterly',
        startDate: iso(monthStart(fiscalYear, fiscalYearStartMonth, q * 3)),
        endDate: iso(dayBefore(monthStart(fiscalYear, fiscalYearStartMonth, (q + 1) * 3))),
        label: `${label}-Q${q + 1}`,
        fiscalYear,
      });
    }
  }

  return periods;
}
