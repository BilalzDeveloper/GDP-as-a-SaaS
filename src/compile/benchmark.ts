// Benchmarking a quarterly run to the annual accounts.
//
// The engine does the arithmetic (src/engine/benchmark.ts). This module does
// the part the engine deliberately refuses to do: decide which quarterly
// series is the counterpart of which annual one, and which quarter belongs to
// which year.
//
// That second question is why the grouping is read from the database rather
// than parsed out of a period label. Reference periods carry `fiscal_year`,
// set when the period was defined, and a fiscal year does not start in
// January everywhere — Australia runs July to June, India April to March,
// the United States federal year October to September. Deriving a year from
// the string '2024-Q3' would give the right answer for some tenants and a
// quietly wrong one for others, which is exactly the class of bug this
// product cannot ship (non-negotiable 4).
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/rls';
import {
  BenchmarkError,
  dentonBenchmark,
  type BenchmarkVariant,
  type IndicatorPoint,
} from '@/engine';
import { MEASURE } from './measures';

export class BenchmarkingError extends Error {}

/** The run setting, mapped onto the engine's variant. */
export function variantFor(method: string): BenchmarkVariant | null {
  if (method === 'denton_proportional') return 'proportional';
  if (method === 'denton_additive') return 'additive';
  return null;
}

interface ResultRow {
  approach: string;
  measure: string;
  activity_item_id: string | null;
  value: string | null;
  period_id: string;
  period_label: string;
  fiscal_year: number;
}

interface AnnualRow {
  approach: string;
  measure: string;
  activity_item_id: string | null;
  value: string | null;
  period_id: string;
  fiscal_year: number;
}

/** (approach, measure, industry) — the identity of a series across periods. */
function seriesKey(
  approach: string,
  measure: string,
  activityItemId: string | null,
): string {
  return `${approach}|${measure}|${activityItemId ?? ''}`;
}

/**
 * Measures that must never be benchmarked.
 *
 * A statistical discrepancy is the difference between two estimates, not a
 * flow with an annual total of its own. Forcing quarterly discrepancies to
 * sum to the annual discrepancy would be meaningless arithmetic on a residual
 * — and, being a series that hovers around zero and changes sign, it is also
 * the worst possible input to proportional Denton. It is recomputed from the
 * benchmarked approach totals instead.
 */
function isBenchmarkable(measure: string): boolean {
  return !measure.startsWith(MEASURE.statisticalDiscrepancy);
}

export interface BenchmarkDiagnostic {
  periodId: string | null;
  severity: 'warning' | 'info';
  code: string;
  message: string;
  subject: string | null;
}

export interface BenchmarkSummary {
  variant: BenchmarkVariant;
  /** Series that were reconciled to at least one annual total. */
  seriesBenchmarked: number;
  /** Series with no annual counterpart, left as the indicator. */
  seriesWithoutTotals: number;
  /** Annual constraints applied across all series. */
  constraintsApplied: number;
  /** Largest |ratio − 1| (proportional) or |difference| share seen. */
  maxAdjustmentPercent: number;
  /** Quarters after the last benchmarked year, carried forward. */
  extrapolatedPeriods: string[];
  diagnostics: BenchmarkDiagnostic[];
}

/**
 * Reconcile a quarterly run's current-price results to an annual run's.
 *
 * Every series is benchmarked on its own. That is the univariate Denton the
 * QNA manual describes, and it has a consequence worth stating plainly:
 * benchmarked components no longer add exactly to their benchmarked
 * aggregate, because each was smoothed against its own annual constraint. The
 * multivariate extensions that would preserve the cross-sectional identities
 * as well (Di Fonzo–Marini; the Cholette–Dagum family) are not implemented —
 * so the residual is measured and reported rather than hidden. Same posture
 * as the non-additivity of chained volumes: publish the number, explain it.
 */
export async function benchmarkRun(
  tx: Tx,
  orgId: string,
  runId: string,
  sourceRunId: string,
  variant: BenchmarkVariant,
): Promise<BenchmarkSummary | null> {
  const quarterly = [
    ...((await tx.execute(sql`
      select cr.approach::text as approach, cr.measure, cr.activity_item_id,
             cr.value, p.id as period_id, p.label as period_label,
             p.fiscal_year
        from compilation_result cr
        join reference_period p on p.id = cr.period_id
       where cr.run_id = ${runId}::uuid
         and cr.price_basis = 'current'
         and cr.benchmarked = false
       order by p.start_date, cr.approach, cr.measure
    `)) as unknown as ResultRow[]),
  ];
  if (quarterly.length === 0) return null;

  const annual = [
    ...((await tx.execute(sql`
      select cr.approach::text as approach, cr.measure, cr.activity_item_id,
             cr.value, p.id as period_id, p.fiscal_year
        from compilation_result cr
        join reference_period p on p.id = cr.period_id
       where cr.run_id = ${sourceRunId}::uuid
         and cr.price_basis = 'current'
         and cr.benchmarked = false
         and p.frequency = 'annual'
    `)) as unknown as AnnualRow[]),
  ];
  if (annual.length === 0) {
    throw new BenchmarkingError(
      'The annual run chosen as the benchmark has no current-price results. ' +
        'Execute it before benchmarking a quarterly run against it.',
    );
  }

  // Annual totals, and the annual period each one came from, by series and
  // fiscal year. The fiscal year is the join: it is what makes the grouping
  // work for a July-to-June year as well as a calendar one.
  const annualByKey = new Map<
    string,
    Map<string, { total: number; periodId: string }>
  >();
  for (const row of annual) {
    if (row.value === null) continue;
    const key = seriesKey(row.approach, row.measure, row.activity_item_id);
    if (!annualByKey.has(key)) annualByKey.set(key, new Map());
    annualByKey
      .get(key)!
      .set(String(row.fiscal_year), {
        total: Number(row.value),
        periodId: row.period_id,
      });
  }

  // Quarterly series, in period order.
  const quarterlyByKey = new Map<string, ResultRow[]>();
  for (const row of quarterly) {
    if (!isBenchmarkable(row.measure)) continue;
    if (row.value === null) continue;
    const key = seriesKey(row.approach, row.measure, row.activity_item_id);
    if (!quarterlyByKey.has(key)) quarterlyByKey.set(key, []);
    quarterlyByKey.get(key)!.push(row);
  }

  const diagnostics: BenchmarkDiagnostic[] = [];
  const extrapolated = new Set<string>();
  let seriesBenchmarked = 0;
  let seriesWithoutTotals = 0;
  let constraintsApplied = 0;
  let maxAdjustmentPercent = 0;

  await tx.execute(sql`delete from benchmark_constraint where run_id = ${runId}::uuid`);

  for (const [key, rows] of quarterlyByKey) {
    const { approach, measure, activity_item_id: activityItemId } = rows[0];
    const label = `${approach} ${measure}`;
    const annualForSeries = annualByKey.get(key);

    if (!annualForSeries || annualForSeries.size === 0) {
      seriesWithoutTotals++;
      continue;
    }

    const indicator: IndicatorPoint[] = rows.map((row) => ({
      periodLabel: row.period_label,
      value: Number(row.value),
      benchmarkKey: String(row.fiscal_year),
    }));

    // Only totals whose year actually has quarters in this run. A benchmark
    // for a year the run does not cover cannot be satisfied and is not an
    // error — the annual run simply reaches further back.
    const yearsPresent = new Set(indicator.map((p) => p.benchmarkKey));
    const totals = [...annualForSeries.entries()]
      .filter(([year]) => yearsPresent.has(year))
      .map(([year, entry]) => ({ key: year, total: entry.total }));

    if (totals.length === 0) {
      seriesWithoutTotals++;
      continue;
    }

    if (
      variant === 'proportional' &&
      indicator.some((p) => p.value < 0) &&
      indicator.some((p) => p.value > 0)
    ) {
      diagnostics.push({
        periodId: null,
        severity: 'warning',
        code: 'benchmark_sign_change',
        message:
          `${label} changes sign across the quarters, and proportional Denton ` +
          'adjusts by a ratio — which inverts where the series is negative and ' +
          'is unstable where it is near zero. Re-run with the additive variant ' +
          'if this series matters.',
        subject: label,
      });
    }

    let result;
    try {
      result = dentonBenchmark(indicator, totals, { variant });
    } catch (e) {
      if (e instanceof BenchmarkError) {
        diagnostics.push({
          periodId: null,
          severity: 'warning',
          code: 'benchmark_failed',
          message: `${label} could not be benchmarked: ${e.message}`,
          subject: label,
        });
        continue;
      }
      throw e;
    }

    seriesBenchmarked++;
    const periodIdByLabel = new Map(rows.map((r) => [r.period_label, r.period_id]));

    for (const point of result.points) {
      const periodId = periodIdByLabel.get(point.periodLabel)!;
      await tx.execute(sql`
        insert into compilation_result
          (org_id, run_id, period_id, approach, measure, activity_item_id,
           price_basis, benchmarked, value)
        values (${orgId}::uuid, ${runId}::uuid, ${periodId}::uuid,
                ${approach}::compilation_approach, ${measure},
                ${activityItemId}::uuid, 'current'::price_basis, true,
                ${point.benchmarked})
        on conflict (run_id, period_id, approach, measure, activity_item_id,
                     price_basis, benchmarked)
        do update set value = excluded.value
      `);
      if (point.extrapolated) extrapolated.add(point.periodLabel);

      const adjustmentPercent =
        variant === 'proportional'
          ? Math.abs(point.adjustment - 1) * 100
          : point.indicator === 0
            ? 0
            : Math.abs(point.adjustment / point.indicator) * 100;
      maxAdjustmentPercent = Math.max(maxAdjustmentPercent, adjustmentPercent);
    }

    for (const check of result.constraints) {
      const entry = annualForSeries.get(check.key)!;
      const indicatorTotal = indicator
        .filter((p) => p.benchmarkKey === check.key)
        .reduce((total, p) => total + p.value, 0);
      await tx.execute(sql`
        insert into benchmark_constraint
          (org_id, run_id, annual_period_id, approach, measure,
           activity_item_id, annual_total, indicator_total,
           benchmarked_total, residual)
        values (${orgId}::uuid, ${runId}::uuid, ${entry.periodId}::uuid,
                ${approach}::compilation_approach, ${measure},
                ${activityItemId}::uuid, ${check.total}, ${indicatorTotal},
                ${check.benchmarkedSum}, ${check.residual})
      `);
      constraintsApplied++;
    }
  }

  if (seriesBenchmarked === 0) {
    diagnostics.push({
      periodId: null,
      severity: 'warning',
      code: 'benchmark_no_match',
      message:
        'No quarterly series had a counterpart in the annual run, so nothing ' +
        'was benchmarked. The two runs must compile the same measures — most ' +
        'often this means the annual run breaks industries down differently, ' +
        'or covers different years.',
      subject: 'benchmarking',
    });
  }

  if (seriesWithoutTotals > 0) {
    diagnostics.push({
      periodId: null,
      severity: 'info',
      code: 'benchmark_partial',
      message:
        `${seriesWithoutTotals} quarterly series had no annual counterpart and ` +
        'were left as compiled. They are published unbenchmarked and are ' +
        'flagged as such in the results.',
      subject: 'benchmarking',
    });
  }

  if (extrapolated.size > 0) {
    const labels = [...extrapolated].sort();
    diagnostics.push({
      periodId: null,
      severity: 'info',
      code: 'benchmark_extrapolated',
      message:
        `${labels.join(', ')} fall after the last benchmarked year. Their ` +
        'figures carry the final benchmark-to-indicator adjustment forward ' +
        'unchanged, so they will be revised when the annual accounts for ' +
        'those years are compiled.',
      subject: 'benchmarking',
    });
  }

  // A large adjustment is not an error — the annual accounts are the better
  // source and the whole point is to defer to them — but an indicator that
  // has to move 10% to meet the annual figure is not tracking what it claims
  // to track, and the compiler should know before publishing on it.
  if (maxAdjustmentPercent > 10) {
    diagnostics.push({
      periodId: null,
      severity: 'warning',
      code: 'benchmark_large_adjustment',
      message:
        `The largest adjustment applied was ${maxAdjustmentPercent.toFixed(1)}% ` +
        'of the indicator. An adjustment this size means the quarterly source ' +
        'is a poor indicator of the annual movement, not that benchmarking ' +
        'went wrong.',
      subject: 'benchmarking',
    });
  }

  await checkComponentAdditivity(tx, runId, diagnostics);

  return {
    variant,
    seriesBenchmarked,
    seriesWithoutTotals,
    constraintsApplied,
    maxAdjustmentPercent,
    extrapolatedPeriods: [...extrapolated].sort(),
    diagnostics,
  };
}

/**
 * Report where benchmarked industries stop adding to the benchmarked total.
 *
 * Univariate Denton smooths every series against its own annual constraint,
 * with nothing tying the components to the aggregate within a quarter. The
 * quarters still add correctly down the year — that is what was imposed — but
 * across industries within a quarter they need not, and typically do not.
 *
 * Reported rather than removed, for the same reason as the chained-volume
 * residual: forcing the components to sum would mean changing published
 * industry figures to preserve an identity the method does not deliver.
 */
async function checkComponentAdditivity(
  tx: Tx,
  runId: string,
  diagnostics: BenchmarkDiagnostic[],
): Promise<void> {
  const rows = [
    ...((await tx.execute(sql`
      select p.id as period_id, p.label as period_label,
             sum(case when cr.activity_item_id is not null
                      then cr.value else 0 end) as components,
             max(case when cr.measure = ${MEASURE.totalGrossValueAdded}
                      then cr.value end) as total
        from compilation_result cr
        join reference_period p on p.id = cr.period_id
       where cr.run_id = ${runId}::uuid
         and cr.benchmarked = true
         and cr.price_basis = 'current'
         and cr.approach = 'production'
         and cr.measure in (${MEASURE.grossValueAdded}, ${MEASURE.totalGrossValueAdded})
       group by p.id, p.label, p.start_date
       order by p.start_date
    `)) as unknown as {
      period_id: string;
      period_label: string;
      components: string | null;
      total: string | null;
    }[]),
  ];

  const offending = rows
    .filter((r) => r.total !== null && r.components !== null)
    .map((r) => ({
      label: r.period_label,
      residual: Number(r.total) - Number(r.components),
      total: Number(r.total),
    }))
    .filter((r) => r.total !== 0 && Math.abs(r.residual / r.total) > 1e-9);

  if (offending.length === 0) return;

  const worst = offending.reduce((a, b) =>
    Math.abs(b.residual / b.total) > Math.abs(a.residual / a.total) ? b : a,
  );
  diagnostics.push({
    periodId: null,
    severity: 'info',
    code: 'benchmark_components_not_additive',
    message:
      'Benchmarked industries do not sum exactly to benchmarked total value ' +
      `added — the largest gap is ${worst.residual.toFixed(2)} in ` +
      `${worst.label}, ${((worst.residual / worst.total) * 100).toFixed(3)}% of ` +
      'the total. Each series was smoothed against its own annual constraint, ' +
      'so the quarters add correctly down the year but the industries need ' +
      'not add across a quarter. Forcing them to would mean altering ' +
      'published industry figures.',
    subject: 'benchmarking',
  });
}
