// Executing a compilation run: read the observations its vintage holds,
// assemble them, run the engine, persist what came out.
//
// Reproducibility (non-negotiable 1) rests on two pins recorded here: the
// input vintage, fixed when the run is created, and the method_version —
// engine semver plus the full config — fixed at execution. Those two plus the
// stored observations are sufficient to re-derive every figure.
import { sql } from 'drizzle-orm';
import { withRls, type RlsClaims, type Tx } from '@/db/rls';
import { compileGdp, ENGINE_VERSION, type BalancingAnchor } from '@/engine';
import { assembleRun, type ObservationRow } from './assemble';
import { benchmarkRun, BenchmarkingError, variantFor } from './benchmark';
import { computeDerived } from './derived';
import { MEASURE } from './measures';
import { computeVolumes, VolumeError } from './volumes';

export class ExecutionError extends Error {}

/**
 * Find or create the method_version for this engine build and config.
 *
 * Goes through the pin_method_version RPC because app roles hold no INSERT
 * grant on the table: method versions are a shared, system-wide registry, and
 * a tenant writing rows into it directly would be able to pollute it for
 * everyone (DECISIONS.md D23).
 */
async function pinMethodVersion(
  tx: Tx,
  config: Record<string, unknown>,
): Promise<string> {
  const gitSha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const rows = (await tx.execute(sql`
    select public.pin_method_version(
      ${ENGINE_VERSION}, ${gitSha}, ${JSON.stringify(config)}::jsonb
    ) as id
  `)) as unknown as { id: string | null }[];
  const id = rows[0]?.id;
  if (!id) throw new ExecutionError('Could not pin a method version for this run.');
  return id;
}

async function loadObservations(
  tx: Tx,
  orgId: string,
  vintageId: string,
): Promise<ObservationRow[]> {
  const rows = (await tx.execute(sql`
    select p.id            as period_id,
           p.label         as period_label,
           ts.transaction_code,
           ts.activity_item_id,
           ci.code         as activity_code,
           o.value,
           ts.unit_code,
           ts.valuation
      from observation o
      join time_series ts on ts.id = o.series_id
      join reference_period p on p.id = o.period_id
      left join classification_item ci on ci.id = ts.activity_item_id
     where o.org_id = ${orgId}::uuid and o.vintage_id = ${vintageId}::uuid
     order by p.start_date, ts.transaction_code
  `)) as unknown as {
    period_id: string;
    period_label: string;
    transaction_code: string;
    activity_item_id: string | null;
    activity_code: string | null;
    value: string | null;
    unit_code: string;
    valuation: 'basic' | 'producers' | 'purchasers' | null;
  }[];

  return [...rows].map((r) => ({
    periodId: r.period_id,
    periodLabel: r.period_label,
    transactionCode: r.transaction_code,
    activityItemId: r.activity_item_id,
    activityCode: r.activity_code,
    // NUMERIC arrives as text from the driver; the engine works in doubles
    // (DECISIONS.md D3).
    value: r.value === null ? null : Number(r.value),
    unitCode: r.unit_code,
    valuation: r.valuation,
  }));
}

export interface ExecutionSummary {
  periodsCompiled: number;
  resultsWritten: number;
  diagnostics: number;
  problems: number;
  /** Null when volumes were not requested, or no deflators were available. */
  volumes: {
    seriesLinked: number;
    maxResidualPercent: number;
    referencePeriodLabel: string;
  } | null;
  /** Periods that got a per-capita figure, and periods that got a growth rate. */
  derived: { perCapitaPeriods: number; growthPeriods: number };
  /** Null when the run is annual, or no annual benchmark was chosen. */
  benchmarking: {
    variant: string;
    seriesBenchmarked: number;
    constraintsApplied: number;
    maxAdjustmentPercent: number;
    extrapolatedPeriods: string[];
  } | null;
}

/**
 * Execute a run. Status moves draft → computing → computed|failed, so moving
 * execution to a background worker later (PLAN.md, stack challenge 3: Vercel
 * caps function time and a 400-industry run may not fit a request) is a
 * change of caller, not of schema.
 */
export async function executeRun(
  claims: RlsClaims,
  orgId: string,
  runId: string,
): Promise<ExecutionSummary> {
  const run = await withRls(claims, {}, async (tx) => {
    const rows = (await tx.execute(sql`
      select id, name, input_vintage_id, anchor_approach, status, frequency::text,
             volume_reference_period_label, benchmark_source_run_id,
             benchmark_method
        from compilation_run where id = ${runId}::uuid
    `)) as unknown as {
      id: string;
      name: string;
      input_vintage_id: string;
      anchor_approach: BalancingAnchor;
      status: string;
      frequency: 'annual' | 'quarterly';
      volume_reference_period_label: string | null;
      benchmark_source_run_id: string | null;
      benchmark_method: string;
    }[];
    return rows[0];
  });
  if (!run) throw new ExecutionError('No such compilation run.');

  // Names, not ids: the reason is read by people (see the audit page).
  await withRls(claims, { reason: `execute run "${run.name}"` }, (tx) =>
    tx.execute(sql`
      update compilation_run set status = 'computing', error_message = null
       where id = ${runId}::uuid
    `),
  );

  try {
    return await withRls(
      claims,
      { reason: `store results for run "${run.name}"` },
      async (tx) => {
        const observations = await loadObservations(tx, orgId, run.input_vintage_id);
        if (observations.length === 0) {
          throw new ExecutionError(
            'The vintage this run reads holds no observations. Commit source data first.',
          );
        }

        // Everything that changes a computed figure goes into the pinned
        // method version, so re-executing with a different benchmark source
        // or variant is visibly a different method (non-negotiable 1).
        const config = {
          anchor: run.anchor_approach,
          discrepancyWarningThreshold: 0.01,
          frequency: run.frequency,
          benchmarkMethod: run.benchmark_source_run_id ? run.benchmark_method : 'none',
          benchmarkSourceRunId: run.benchmark_source_run_id,
        };
        const methodVersionId = await pinMethodVersion(tx, config);

        // Results are replaced wholesale: a re-execution supersedes the
        // previous output rather than accumulating alongside it.
        await tx.execute(sql`delete from compilation_result where run_id = ${runId}::uuid`);
        await tx.execute(sql`delete from compilation_diagnostic where run_id = ${runId}::uuid`);

        const periods = assembleRun(observations);
        let resultsWritten = 0;
        let diagnosticCount = 0;
        let problemCount = 0;
        let periodsCompiled = 0;

        const writeResult = async (
          periodId: string,
          approach: string,
          measure: string,
          value: number | null,
          activityItemId: string | null = null,
        ) => {
          // price_basis is part of a result's identity (migration 0005), so it
          // belongs in the conflict target as well as the row.
          await tx.execute(sql`
            insert into compilation_result
              (org_id, run_id, period_id, approach, measure, activity_item_id,
               price_basis, value)
            values (${orgId}::uuid, ${runId}::uuid, ${periodId}::uuid,
                    ${approach}::compilation_approach, ${measure},
                    ${activityItemId}::uuid, 'current'::price_basis, ${value})
            on conflict (run_id, period_id, approach, measure, activity_item_id,
                         price_basis, benchmarked)
            do update set value = excluded.value
          `);
          resultsWritten++;
        };

        const writeDiagnostic = async (
          periodId: string | null,
          severity: string,
          code: string,
          message: string,
          subject: string | null,
        ) => {
          await tx.execute(sql`
            insert into compilation_diagnostic
              (org_id, run_id, period_id, severity, code, message, subject)
            values (${orgId}::uuid, ${runId}::uuid, ${periodId}::uuid,
                    ${severity}, ${code}, ${message}, ${subject})
          `);
          diagnosticCount++;
        };

        // Activity code → item id, so per-industry results keep the link the
        // drill-down walks back along.
        const activityIdByCode = new Map<string, string>();
        for (const row of observations) {
          if (row.activityCode && row.activityItemId) {
            activityIdByCode.set(row.activityCode, row.activityItemId);
          }
        }

        for (const period of periods) {
          for (const problem of period.problems) {
            await writeDiagnostic(
              period.periodId,
              'warning',
              problem.code,
              problem.message,
              problem.approach,
            );
            problemCount++;
          }

          if (!period.production && !period.expenditure && !period.income) continue;

          const result = compileGdp(
            {
              production: period.production,
              expenditure: period.expenditure,
              income: period.income,
            },
            { anchor: run.anchor_approach, discrepancyWarningThreshold: 0.01 },
          );
          periodsCompiled++;

          if (result.production) {
            await writeResult(period.periodId, 'production', MEASURE.gdp, result.production.gdp);
            await writeResult(
              period.periodId, 'production', MEASURE.totalGrossValueAdded,
              result.production.totalGrossValueAdded,
            );
            await writeResult(
              period.periodId, 'production', MEASURE.taxesOnProducts,
              result.production.taxesOnProducts,
            );
            await writeResult(
              period.periodId, 'production', MEASURE.subsidiesOnProducts,
              result.production.subsidiesOnProducts,
            );
            for (const industry of result.production.industries) {
              const activityId = activityIdByCode.get(industry.code) ?? null;
              await writeResult(
                period.periodId, 'production', MEASURE.grossValueAdded,
                industry.grossValueAdded, activityId,
              );
              await writeResult(
                period.periodId, 'production', MEASURE.output,
                industry.output, activityId,
              );
              await writeResult(
                period.periodId, 'production', MEASURE.intermediateConsumption,
                industry.intermediateConsumption, activityId,
              );
            }
          }

          if (result.expenditure) {
            await writeResult(period.periodId, 'expenditure', MEASURE.gdp, result.expenditure.gdp);
            await writeResult(
              period.periodId, 'expenditure', MEASURE.finalConsumptionExpenditure,
              result.expenditure.finalConsumptionExpenditure,
            );
            await writeResult(
              period.periodId, 'expenditure', MEASURE.grossCapitalFormation,
              result.expenditure.grossCapitalFormation,
            );
            await writeResult(
              period.periodId, 'expenditure', MEASURE.netExports,
              result.expenditure.netExports,
            );
          }

          if (result.income) {
            await writeResult(period.periodId, 'income', MEASURE.gdp, result.income.gdp);
            await writeResult(
              period.periodId, 'income', MEASURE.totalFactorIncomes,
              result.income.totalFactorIncomes,
            );
            await writeResult(
              period.periodId, 'income', MEASURE.netTaxesOnProductionAndImports,
              result.income.netTaxesOnProductionAndImports,
            );
          }

          await writeResult(period.periodId, 'summary', MEASURE.headlineGdp, result.gdp);
          for (const approach of result.approaches) {
            await writeResult(
              period.periodId, 'summary',
              `${MEASURE.statisticalDiscrepancy}_${approach.approach}`,
              approach.discrepancy,
            );
          }

          for (const diagnostic of result.diagnostics) {
            await writeDiagnostic(
              period.periodId, diagnostic.severity, diagnostic.code,
              diagnostic.message, diagnostic.subject ?? null,
            );
          }
        }

        // Volume measures, when the run asked for them and deflators exist.
        let volumes: ExecutionSummary['volumes'] = null;
        if (run.volume_reference_period_label) {
          try {
            const summary = await computeVolumes(
              tx, orgId, runId, run.input_vintage_id,
              run.volume_reference_period_label,
            );
            if (summary) {
              volumes = {
                seriesLinked: summary.seriesLinked,
                maxResidualPercent: summary.maxResidualPercent,
                referencePeriodLabel: summary.referencePeriodLabel,
              };
            } else {
              await writeDiagnostic(
                null, 'info', 'no_deflators',
                'Volume measures were requested but no usable deflators were ' +
                  'found in this vintage. A deflator is an observation on an ' +
                  'index-valued series sharing the dimensions of the series it ' +
                  'deflates.',
                'volumes',
              );
            }
          } catch (e) {
            if (e instanceof VolumeError) {
              await writeDiagnostic(null, 'warning', 'volume_error', e.message, 'volumes');
            } else throw e;
          }
        }

        // Benchmarking, once the current-price results it reconciles exist.
        let benchmarking: ExecutionSummary['benchmarking'] = null;
        const variant = variantFor(run.benchmark_method);
        if (run.frequency === 'quarterly' && run.benchmark_source_run_id && variant) {
          try {
            const summary = await benchmarkRun(
              tx, orgId, runId, run.benchmark_source_run_id, variant,
            );
            if (summary) {
              for (const d of summary.diagnostics) {
                await writeDiagnostic(
                  d.periodId, d.severity, d.code, d.message, d.subject,
                );
              }
              benchmarking = {
                variant: summary.variant,
                seriesBenchmarked: summary.seriesBenchmarked,
                constraintsApplied: summary.constraintsApplied,
                maxAdjustmentPercent: summary.maxAdjustmentPercent,
                extrapolatedPeriods: summary.extrapolatedPeriods,
              };
            }
          } catch (e) {
            if (e instanceof BenchmarkingError) {
              await writeDiagnostic(
                null, 'warning', 'benchmark_unavailable', e.message, 'benchmarking',
              );
            } else throw e;
          }
        } else if (run.frequency === 'quarterly' && !run.benchmark_source_run_id) {
          await writeDiagnostic(
            null, 'info', 'not_benchmarked',
            'These quarterly figures are not benchmarked to annual totals. ' +
              'Until an annual run is chosen as the benchmark, the four ' +
              'quarters of a year are not guaranteed to sum to the annual ' +
              'accounts for that year.',
            'benchmarking',
          );
        }

        // Per-capita and growth, last: they read the headline figures, and on a
        // benchmarked run they must read the benchmarked ones, so this has to
        // come after benchmarking rather than inside the period loop.
        const derived = { perCapitaPeriods: 0, growthPeriods: 0 };
        for (const onBenchmarked of benchmarking ? [false, true] : [false]) {
          const summary = await computeDerived(
            tx, orgId, runId, run.input_vintage_id, run.frequency, onBenchmarked,
          );
          // Diagnostics are reported once, against the published figures.
          const isPublished = onBenchmarked || !benchmarking;
          if (isPublished) {
            derived.perCapitaPeriods = summary.perCapitaPeriods;
            derived.growthPeriods = summary.growthPeriods;
            for (const d of summary.diagnostics) {
              await writeDiagnostic(null, d.severity, d.code, d.message, 'derived measures');
            }
          }
        }

        await tx.execute(sql`
          update compilation_run
             set status = 'computed',
                 method_version_id = ${methodVersionId}::uuid,
                 executed_at = now(),
                 error_message = null
           where id = ${runId}::uuid
        `);

        return {
          periodsCompiled,
          resultsWritten,
          diagnostics: diagnosticCount,
          problems: problemCount,
          volumes,
          benchmarking,
          derived,
        };
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await withRls(claims, { reason: `run "${run.name}" failed` }, (tx) =>
      tx.execute(sql`
        update compilation_run set status = 'failed', error_message = ${message}
         where id = ${runId}::uuid
      `),
    );
    throw e instanceof ExecutionError ? e : new ExecutionError(message);
  }
}
