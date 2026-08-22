// Computing volume measures for a run. The arithmetic lives in the pure
// engine (`src/engine/volume.ts`); this module only finds the deflators,
// pairs them with the current-price results, and stores what comes back.
//
// Deflator convention: a deflator is an observation on a series whose unit
// has unit_type 'index' (the `deflator_series` view), sharing the transaction
// code and activity of the series it deflates. So the deflator for industry
// C's value added is a B.1g series for activity C denominated in INDEX.
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/rls';
import {
  chainLink,
  chainLinkAggregate,
  nonAdditivityResidual,
  type SeriesPoint,
} from '@/engine';
import { MEASURE } from './measures';

/** Measures written with price_basis 'chain_linked'. */
export const VOLUME_MEASURE = {
  chainLinkedValue: 'chain_linked_value',
  chainIndex: 'chain_index',
  volumeGrowthPercent: 'volume_growth_percent',
  previousYearPrices: 'previous_year_prices_value',
  /** Aggregate − Σ components. Non-zero away from the reference period. */
  nonAdditivityResidual: 'non_additivity_residual',
} as const;

export interface VolumeSummary {
  seriesLinked: number;
  periodsCovered: number;
  /** Largest absolute residual across periods, for the UI to lead with. */
  maxResidualPercent: number;
  referencePeriodLabel: string;
}

export class VolumeError extends Error {}

interface DeflatorRow {
  period_label: string;
  activity_item_id: string | null;
  transaction_code: string;
  value: string | null;
}

interface CurrentValueRow {
  period_label: string;
  period_id: string;
  activity_item_id: string | null;
  value: string | null;
}

/**
 * Chain-link a run's value added by industry, and its GDP as an aggregate of
 * those industries.
 *
 * Returns null when the run has no deflators to work with — volume measures
 * are opt-in and many first compilations have none.
 */
export async function computeVolumes(
  tx: Tx,
  orgId: string,
  runId: string,
  vintageId: string,
  referencePeriodLabel: string,
): Promise<VolumeSummary | null> {
  const deflators = (await tx.execute(sql`
    select p.label as period_label, ds.activity_item_id, ds.transaction_code, o.value
      from observation o
      join deflator_series ds on ds.id = o.series_id
      join reference_period p on p.id = o.period_id
     where o.org_id = ${orgId}::uuid and o.vintage_id = ${vintageId}::uuid
     order by p.start_date
  `)) as unknown as DeflatorRow[];

  const deflatorList = [...deflators];
  if (deflatorList.length === 0) return null;

  // Deflator lookup keyed by activity and period. Value-added deflators are
  // recognised by transaction code B.1g or P.1; anything else is ignored
  // rather than guessed at.
  const byActivityPeriod = new Map<string, number>();
  for (const d of deflatorList) {
    if (!['B.1g', 'P.1'].includes(d.transaction_code)) continue;
    if (d.value === null) continue;
    byActivityPeriod.set(`${d.activity_item_id ?? ''}|${d.period_label}`, Number(d.value));
  }
  if (byActivityPeriod.size === 0) return null;

  const currentValues = (await tx.execute(sql`
    select p.label as period_label, p.id as period_id,
           cr.activity_item_id, cr.value
      from compilation_result cr
      join reference_period p on p.id = cr.period_id
     where cr.run_id = ${runId}::uuid
       and cr.measure = ${MEASURE.grossValueAdded}
       and cr.price_basis = 'current'
       and cr.activity_item_id is not null
     order by p.start_date
  `)) as unknown as CurrentValueRow[];

  const valueList = [...currentValues];
  if (valueList.length === 0) return null;

  const periodIdByLabel = new Map<string, string>();
  for (const row of valueList) periodIdByLabel.set(row.period_label, row.period_id);

  // Order periods by their appearance, which the query already sorted by date.
  const periodLabels: string[] = [];
  for (const row of valueList) {
    if (!periodLabels.includes(row.period_label)) periodLabels.push(row.period_label);
  }
  if (!periodLabels.includes(referencePeriodLabel)) {
    throw new VolumeError(
      `The volume reference period "${referencePeriodLabel}" is not among the ` +
        `periods this run compiled (${periodLabels.join(', ')}).`,
    );
  }

  // Build one SeriesPoint list per activity, keeping only activities with a
  // complete value-and-deflator pair in every period: a gap would silently
  // break the chain.
  const byActivity = new Map<string, Map<string, number>>();
  for (const row of valueList) {
    if (row.value === null || row.activity_item_id === null) continue;
    const series = byActivity.get(row.activity_item_id) ?? new Map<string, number>();
    series.set(row.period_label, Number(row.value));
    byActivity.set(row.activity_item_id, series);
  }

  const components: { activityId: string; points: SeriesPoint[] }[] = [];
  for (const [activityId, values] of byActivity) {
    const points: SeriesPoint[] = [];
    let complete = true;
    for (const label of periodLabels) {
      const value = values.get(label);
      const deflator = byActivityPeriod.get(`${activityId}|${label}`);
      if (value === undefined || deflator === undefined || deflator <= 0) {
        complete = false;
        break;
      }
      points.push({ periodLabel: label, value, deflator });
    }
    if (complete) components.push({ activityId, points });
  }

  if (components.length === 0) return null;

  const writeResult = async (
    periodLabel: string,
    measure: string,
    value: number | null,
    activityItemId: string | null,
  ) => {
    const periodId = periodIdByLabel.get(periodLabel);
    if (!periodId) return;
    await tx.execute(sql`
      insert into compilation_result
        (org_id, run_id, period_id, approach, measure, activity_item_id,
         price_basis, value)
      values (${orgId}::uuid, ${runId}::uuid, ${periodId}::uuid,
              'production'::compilation_approach, ${measure},
              ${activityItemId}::uuid, 'chain_linked'::price_basis, ${value})
      on conflict (run_id, period_id, approach, measure, activity_item_id,
                   sector_item_id, price_basis, benchmarked)
      do update set value = excluded.value
    `);
  };

  // Per-industry chain-linked volumes.
  const linkedComponents = components.map((c) => ({
    activityId: c.activityId,
    linked: chainLink(c.points, { referencePeriodLabel }),
  }));

  for (const { activityId, linked } of linkedComponents) {
    for (const point of linked) {
      await writeResult(
        point.periodLabel, VOLUME_MEASURE.chainLinkedValue,
        point.chainLinkedValue, activityId,
      );
      await writeResult(
        point.periodLabel, VOLUME_MEASURE.chainIndex, point.chainIndex, activityId,
      );
      await writeResult(
        point.periodLabel, VOLUME_MEASURE.volumeGrowthPercent,
        point.volumeGrowthPercent, activityId,
      );
      await writeResult(
        point.periodLabel, VOLUME_MEASURE.previousYearPrices,
        point.previousYearPricesValue, activityId,
      );
    }
  }

  // The aggregate is linked from the components, not from an aggregate
  // deflator — that difference is what makes the result non-additive, and
  // getting it right is the point of the exercise.
  const aggregate = chainLinkAggregate(
    components.map((c) => c.points),
    { referencePeriodLabel },
  );
  for (const point of aggregate) {
    await writeResult(point.periodLabel, VOLUME_MEASURE.chainLinkedValue, point.chainLinkedValue, null);
    await writeResult(point.periodLabel, VOLUME_MEASURE.chainIndex, point.chainIndex, null);
    await writeResult(
      point.periodLabel, VOLUME_MEASURE.volumeGrowthPercent,
      point.volumeGrowthPercent, null,
    );
  }

  // Store the residual rather than hiding it. SNA 2008 ch.15: chained volumes
  // are not additive, and publishing the gap is standard practice.
  const residuals = nonAdditivityResidual(
    aggregate,
    linkedComponents.map((c) => c.linked),
  );
  let maxResidualPercent = 0;
  for (const r of residuals) {
    await writeResult(
      r.periodLabel, VOLUME_MEASURE.nonAdditivityResidual, r.residual, null,
    );
    maxResidualPercent = Math.max(maxResidualPercent, Math.abs(r.residualPercent));
  }

  return {
    seriesLinked: components.length,
    periodsCovered: periodLabels.length,
    maxResidualPercent,
    referencePeriodLabel,
  };
}
