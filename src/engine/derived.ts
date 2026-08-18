// Measures derived from a GDP level. Standard national-accounts practice
// rather than a specific SNA identity; SNA 2008 ch.20 covers population and
// per-capita presentation.
import { assertFinite } from './numeric';
import type { Money } from './types';

/**
 * GDP per capita. The population figure must be the mid-year (or period
 * average) resident population matching the GDP's coverage — using an
 * end-of-period or de jure count against a resident-basis GDP is a common
 * and quietly wrong comparison.
 */
export function gdpPerCapita(gdp: Money, population: number): number {
  assertFinite(gdp, 'gdp');
  assertFinite(population, 'population');
  if (population <= 0) {
    throw new RangeError('population must be greater than zero');
  }
  return gdp / population;
}

/**
 * Growth rate between two periods, as a percentage.
 *
 * Period-on-period (quarter on the previous quarter, year on the previous
 * year) and year-on-year (a quarter against the same quarter a year earlier)
 * are the same arithmetic applied to differently chosen periods, so one
 * function serves both — the caller decides which comparison it is making.
 *
 * Undefined when the previous value is zero, and meaningless when it is
 * negative, so both are rejected rather than returned as a number that looks
 * usable.
 */
export function growthRate(current: Money, previous: Money): number {
  assertFinite(current, 'current');
  assertFinite(previous, 'previous');
  if (previous === 0) {
    throw new RangeError('growth rate is undefined when the previous value is zero');
  }
  if (previous < 0) {
    throw new RangeError(
      'growth rate against a negative base is not meaningful; compare levels instead',
    );
  }
  return ((current - previous) / previous) * 100;
}

/**
 * Annualised growth implied by a period-on-period rate. Standard practice for
 * presenting quarterly movements at an annual rate: compound the period rate
 * over the number of periods in a year.
 */
export function annualisedGrowthRate(
  periodGrowthPercent: number,
  periodsPerYear: number,
): number {
  assertFinite(periodGrowthPercent, 'periodGrowthPercent');
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
    throw new RangeError('periodsPerYear must be a positive integer');
  }
  return ((1 + periodGrowthPercent / 100) ** periodsPerYear - 1) * 100;
}

/**
 * Contribution of a component to the growth of an aggregate, in percentage
 * points of the aggregate's growth. Standard practice: the change in the
 * component, expressed against the previous period's aggregate. Contributions
 * computed this way sum to the aggregate's growth rate, which is what makes
 * them worth publishing.
 */
export function growthContribution(
  componentCurrent: Money,
  componentPrevious: Money,
  aggregatePrevious: Money,
): number {
  assertFinite(componentCurrent, 'componentCurrent');
  assertFinite(componentPrevious, 'componentPrevious');
  assertFinite(aggregatePrevious, 'aggregatePrevious');
  if (aggregatePrevious === 0) {
    throw new RangeError(
      'contribution is undefined when the previous aggregate is zero',
    );
  }
  return ((componentCurrent - componentPrevious) / aggregatePrevious) * 100;
}
