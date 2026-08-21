// Per-capita GDP and growth rates, from a run's own headline figures.
//
// The brief's cross-cutting list asks for "per-capita GDP and growth rates,
// both period-on-period and year-on-year". The arithmetic is in the engine
// (`gdpPerCapita`, `growthRate`); this module is the part that has to touch
// the database — finding the population figure for a period, and knowing what
// "a year earlier" means at this run's frequency.
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/rls';
import { gdpPerCapita, growthRate } from '@/engine';
import { MEASURE } from './measures';

/** The memorandum code a population figure is filed under (migration 0009). */
export const POPULATION_CODE = 'POP';

/** How far back "the same period a year earlier" is, by frequency. */
const PERIODS_PER_YEAR: Record<string, number> = { annual: 1, quarterly: 4 };

export interface DerivedDiagnostic {
  severity: 'warning' | 'info';
  code: string;
  message: string;
}

export interface DerivedSummary {
  perCapitaPeriods: number;
  growthPeriods: number;
  diagnostics: DerivedDiagnostic[];
}

interface PeriodRow {
  period_id: string;
  period_label: string;
  gdp: string | null;
}

interface PopulationRow {
  period_id: string;
  value: string | null;
  unit_code: string;
  multiplier: string;
}

/**
 * The currency scale the run's figures are stated in.
 *
 * Per-capita GDP is published in UNITS of the currency — "GDP per head was
 * 47,300" — not in the millions the accounts are compiled in. Dividing a
 * figure in millions by a population in people gives a number around 0.0002,
 * which `numeric(20,6)` then rounds away entirely: the precision loss is
 * total, and the surviving figure looks like a plausible small number rather
 * than an obviously broken one.
 *
 * More than one currency scale in a run is not a per-capita problem but an
 * aggregate one — adding millions to thousands is wrong before anything is
 * divided — so it is reported as a warning rather than quietly resolved.
 */
async function currencyScale(
  tx: Tx,
  orgId: string,
  vintageId: string,
): Promise<{ multiplier: number; unitCode: string } | { conflict: string[] }> {
  const rows = [
    ...((await tx.execute(sql`
      select distinct ts.unit_code, u.multiplier
        from observation o
        join time_series ts on ts.id = o.series_id
        join unit u on u.code = ts.unit_code
       where o.org_id = ${orgId}::uuid
         and o.vintage_id = ${vintageId}::uuid
         and u.unit_type = 'currency'
       order by ts.unit_code
    `)) as unknown as { unit_code: string; multiplier: string }[]),
  ];
  if (rows.length === 1) {
    return { multiplier: Number(rows[0].multiplier), unitCode: rows[0].unit_code };
  }
  return { conflict: rows.map((r) => r.unit_code) };
}

/**
 * Write per-capita GDP and growth rates for a run's headline series.
 *
 * Runs after the headline figures exist, and after benchmarking, so that on a
 * benchmarked quarterly run the growth rates are computed on the figures that
 * will actually be published rather than on the raw indicator.
 */
export async function computeDerived(
  tx: Tx,
  orgId: string,
  runId: string,
  vintageId: string,
  frequency: string,
  benchmarked: boolean,
): Promise<DerivedSummary> {
  const diagnostics: DerivedDiagnostic[] = [];

  const periods = [
    ...((await tx.execute(sql`
      select p.id as period_id, p.label as period_label, cr.value as gdp
        from compilation_result cr
        join reference_period p on p.id = cr.period_id
       where cr.run_id = ${runId}::uuid
         and cr.approach = 'summary'::compilation_approach
         and cr.measure = ${MEASURE.headlineGdp}
         and cr.price_basis = 'current'
         and cr.benchmarked = ${benchmarked}
       order by p.start_date
    `)) as unknown as PeriodRow[]),
  ];
  if (periods.length === 0) {
    return { perCapitaPeriods: 0, growthPeriods: 0, diagnostics };
  }

  // Population comes from the run's own vintage, so a published per-capita
  // figure is pinned to the same frozen inputs as the GDP above it. The unit's
  // multiplier is applied here: a figure filed as PERSONS_TH is thousands of
  // people, and dividing by it unconverted would overstate GDP per head by a
  // factor of a thousand.
  const population = new Map<string, number>();
  const populationRows = [
    ...((await tx.execute(sql`
      select o.period_id, o.value, ts.unit_code, u.multiplier
        from observation o
        join time_series ts on ts.id = o.series_id
        join unit u on u.code = ts.unit_code
       where o.org_id = ${orgId}::uuid
         and o.vintage_id = ${vintageId}::uuid
         and ts.transaction_code = ${POPULATION_CODE}
    `)) as unknown as PopulationRow[]),
  ];
  for (const row of populationRows) {
    if (row.value === null) continue;
    const people = Number(row.value) * Number(row.multiplier);
    if (!(people > 0)) continue;
    population.set(row.period_id, people);
  }

  const write = async (
    periodId: string,
    measure: string,
    value: number,
  ): Promise<void> => {
    await tx.execute(sql`
      insert into compilation_result
        (org_id, run_id, period_id, approach, measure, activity_item_id,
         price_basis, benchmarked, value)
      values (${orgId}::uuid, ${runId}::uuid, ${periodId}::uuid,
              'summary'::compilation_approach, ${measure}, null,
              'current'::price_basis, ${benchmarked}, ${value})
      on conflict (run_id, period_id, approach, measure, activity_item_id,
                   price_basis, benchmarked)
      do update set value = excluded.value
    `);
  };

  const scale = await currencyScale(tx, orgId, vintageId);
  if ('conflict' in scale && population.size > 0) {
    diagnostics.push({
      severity: 'warning',
      code: scale.conflict.length === 0 ? 'no_currency_unit' : 'mixed_currency_units',
      message:
        scale.conflict.length === 0
          ? 'No currency-valued observations in this vintage, so no scale could ' +
            'be established and GDP per capita was not computed.'
          : `This vintage mixes currency scales (${scale.conflict.join(', ')}). ` +
            'GDP per capita was not computed — but the aggregates themselves are ' +
            'the larger worry, since figures on different scales cannot be added.',
    });
  }

  let perCapitaPeriods = 0;
  let growthPeriods = 0;
  const lag = PERIODS_PER_YEAR[frequency] ?? 1;

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    if (period.gdp === null) continue;
    const gdp = Number(period.gdp);

    const people = population.get(period.period_id);
    if (people !== undefined) {
      await write(period.period_id, MEASURE.population, people);
      if (!('conflict' in scale)) {
        // GDP restated in currency units before dividing, so the result is
        // the figure an office publishes rather than a rounded-away fraction.
        await write(
          period.period_id,
          MEASURE.gdpPerCapita,
          gdpPerCapita(gdp * scale.multiplier, people),
        );
        perCapitaPeriods++;
      }
    }

    // Growth against the immediately preceding period the run covers. A gap
    // in the run's periods would make this compare across a hole, so it is
    // computed only where the previous period is genuinely adjacent in the
    // ordered set the run compiled.
    const previous = periods[i - 1];
    if (previous?.gdp !== null && previous !== undefined) {
      const before = Number(previous.gdp);
      if (before > 0) {
        await write(
          period.period_id,
          MEASURE.gdpGrowthPercent,
          growthRate(gdp, before),
        );
        growthPeriods++;
      }
    }

    // Year on year. For an annual run this is the same comparison as above,
    // so it is written only where it says something different — a quarterly
    // run, where it is the rate usually quoted because it is not disturbed by
    // the seasonal pattern this engine does not remove (D36).
    if (lag > 1) {
      const yearAgo = periods[i - lag];
      if (yearAgo?.gdp != null && Number(yearAgo.gdp) > 0) {
        await write(
          period.period_id,
          MEASURE.gdpGrowthYearOnYearPercent,
          growthRate(gdp, Number(yearAgo.gdp)),
        );
      }
    }
  }

  if (population.size === 0) {
    diagnostics.push({
      severity: 'info',
      code: 'no_population',
      message:
        'No population figures in this vintage, so GDP per capita was not ' +
        `computed. Upload population as an observation on transaction code ` +
        `${POPULATION_CODE} with a count unit (PERSONS or PERSONS_TH) — it is ` +
        'a memorandum item and never enters an aggregate.',
    });
  } else if (perCapitaPeriods < periods.length) {
    diagnostics.push({
      severity: 'info',
      code: 'partial_population',
      message:
        `GDP per capita was computed for ${perCapitaPeriods} of ` +
        `${periods.length} periods; the rest have no population figure in ` +
        'this vintage.',
    });
  }

  return { perCapitaPeriods, growthPeriods, diagnostics };
}
