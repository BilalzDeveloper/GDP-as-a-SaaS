// Assembling an export from a run. Reads through withRls(), so an export can
// only ever contain data the requesting user is entitled to see.
import { sql } from 'drizzle-orm';
import { withRls, type RlsClaims } from '@/db/rls';
import { toSdmxCsv, type SdmxObservation } from './sdmx';
import { toExcelWorkbook, type ExcelRow, type ExcelRunMeta } from './excel';

export class ExportError extends Error {}

interface RunMetaRow {
  name: string;
  status: string;
  anchor_approach: string;
  frequency: string;
  executed_at: string | null;
  published_at: string | null;
  run_embargo: string | null;
  org_name: string;
  org_slug: string;
  vintage_name: string;
  frozen_at: string | null;
  vintage_embargo: string | null;
  engine_semver: string | null;
  config: Record<string, unknown> | null;
}

interface ResultRow {
  period_label: string;
  approach: string;
  measure: string;
  price_basis: string;
  benchmarked: boolean;
  activity_code: string | null;
  activity_name: string | null;
  transaction_code: string | null;
  unit_code: string | null;
  value: string | null;
}

async function load(claims: RlsClaims, runId: string) {
  return withRls(claims, {}, async (tx) => {
    const meta = (await tx.execute(sql`
      select r.name, r.status, r.anchor_approach, r.frequency::text as frequency,
             r.executed_at, r.published_at, r.embargo_until as run_embargo,
             o.name as org_name, o.slug as org_slug,
             v.name as vintage_name, v.frozen_at,
             v.embargo_until as vintage_embargo,
             mv.engine_semver, mv.config
        from compilation_run r
        join organization o on o.id = r.org_id
        join data_vintage v on v.id = r.input_vintage_id
        left join method_version mv on mv.id = r.method_version_id
       where r.id = ${runId}::uuid
    `)) as unknown as RunMetaRow[];
    if (meta.length === 0) return null;

    const results = (await tx.execute(sql`
      select p.label as period_label, cr.approach::text as approach, cr.measure,
             cr.price_basis::text as price_basis, cr.benchmarked,
             ci.code as activity_code, ci.name as activity_name,
             null::text as transaction_code, null::text as unit_code,
             cr.value
        from compilation_result cr
        join reference_period p on p.id = cr.period_id
        left join classification_item ci on ci.id = cr.activity_item_id
       where cr.run_id = ${runId}::uuid
       order by p.start_date, cr.price_basis, cr.benchmarked, cr.approach,
                ci.sort_order nulls first, cr.measure
    `)) as unknown as ResultRow[];

    // The currency scale the run's figures are stated in. Needed because the
    // measures do not all share a unit: GDP is in the compilation's currency
    // scale (usually millions), per-capita GDP in units of that currency,
    // population in people, growth in per cent. Exporting them all with a
    // blank UNIT_MEASURE would leave a consumer to guess.
    const units = (await tx.execute(sql`
      select distinct ts.unit_code
        from observation o
        join time_series ts on ts.id = o.series_id
        join unit u on u.code = ts.unit_code
       where o.vintage_id = (select input_vintage_id from compilation_run
                              where id = ${runId}::uuid)
         and u.unit_type = 'currency'
    `)) as unknown as { unit_code: string }[];

    const sources = (await tx.execute(sql`
      select distinct d.original_filename, d.sha256
        from observation o
        join source_dataset d on d.id = o.source_dataset_id
       where o.vintage_id = (select input_vintage_id from compilation_run
                              where id = ${runId}::uuid)
       order by d.original_filename
    `)) as unknown as { original_filename: string; sha256: string }[];

    return {
      meta: meta[0],
      results: [...results],
      sources: [...sources],
      // Only when the run is unambiguously on one scale; a mixed vintage is
      // already reported as a warning by the compilation (see
      // src/compile/derived.ts) and must not be papered over here.
      currencyUnit: units.length === 1 ? units[0].unit_code : null,
    };
  });
}

/**
 * The unit a measure is stated in.
 *
 * Most results carry the compilation's currency scale. Three do not, and
 * saying so is the difference between a usable extract and a misleading one:
 * per-capita GDP is in UNITS of the currency rather than the millions the
 * accounts use, population is a count of people, and a growth rate is a
 * percentage.
 */
function unitFor(measure: string, currencyUnit: string | null): string {
  if (measure === 'population') return 'PERSONS';
  if (measure.startsWith('gdp_growth')) return 'PERCENT';
  if (measure === 'gdp_per_capita') return 'NC_UNITS';
  if (measure.startsWith('statistical_discrepancy')) return currencyUnit ?? '';
  if (measure === 'chain_index' || measure === 'volume_growth_percent') {
    return measure === 'chain_index' ? 'INDEX' : 'PERCENT';
  }
  return currencyUnit ?? '';
}

/** The effective embargo: whichever of the run's or the vintage's applies. */
function effectiveEmbargo(meta: RunMetaRow): string | null {
  const candidates = [meta.run_embargo, meta.vintage_embargo].filter(
    (t): t is string => !!t,
  );
  if (candidates.length === 0) return null;
  const latest = candidates.sort().pop()!;
  return new Date(latest) > new Date() ? latest : null;
}

export async function exportSdmxCsv(
  claims: RlsClaims,
  runId: string,
): Promise<{ filename: string; body: string }> {
  const data = await load(claims, runId);
  if (!data) throw new ExportError('No such compilation run.');
  const { meta, results, currencyUnit } = data;

  const observations: SdmxObservation[] = results.map((r) => ({
    timePeriod: r.period_label,
    transaction: r.transaction_code ?? '',
    activity: r.activity_code ?? '',
    priceBasis: r.price_basis,
    benchmarked: r.benchmarked,
    unit: r.unit_code ?? unitFor(r.measure, currencyUnit),
    measure: r.measure,
    value: r.value === null ? null : Number(r.value),
  }));

  const body = toSdmxCsv(
    {
      agency: meta.org_slug.toUpperCase().replace(/[^A-Z0-9]/g, '_'),
      dataflow: 'NATIONAL_ACCOUNTS',
      version: '1.0',
      embargoUntil: effectiveEmbargo(meta),
    },
    meta.frequency === 'quarterly' ? 'Q' : 'A',
    observations,
  );

  return {
    filename: `${meta.org_slug}-${meta.name.replace(/[^\w-]+/g, '-')}.csv`,
    body,
  };
}

export async function exportExcel(
  claims: RlsClaims,
  runId: string,
): Promise<{ filename: string; body: Buffer }> {
  const data = await load(claims, runId);
  if (!data) throw new ExportError('No such compilation run.');
  const { meta, results, sources } = data;

  const excelMeta: ExcelRunMeta = {
    organisation: meta.org_name,
    runName: meta.name,
    vintageName: meta.vintage_name,
    frozenAt: meta.frozen_at,
    status: meta.status,
    anchorApproach: meta.anchor_approach,
    engineVersion: meta.engine_semver,
    methodConfig: meta.config ? JSON.stringify(meta.config) : null,
    executedAt: meta.executed_at,
    publishedAt: meta.published_at,
    embargoUntil: effectiveEmbargo(meta),
    sourceFiles: sources.map((s) => ({
      filename: s.original_filename,
      sha256: s.sha256,
    })),
  };

  const rows: ExcelRow[] = results.map((r) => ({
    periodLabel: r.period_label,
    approach: r.approach,
    measure: r.measure,
    unit: unitFor(r.measure, data.currencyUnit),
    activityCode: r.activity_code,
    activityName: r.activity_name,
    priceBasis: r.price_basis,
    benchmarked: r.benchmarked,
    value: r.value === null ? null : Number(r.value),
  }));

  return {
    filename: `${meta.org_slug}-${meta.name.replace(/[^\w-]+/g, '-')}.xlsx`,
    body: await toExcelWorkbook(excelMeta, rows),
  };
}
