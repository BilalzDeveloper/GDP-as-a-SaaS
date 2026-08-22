import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { OrgShell, Panel } from '@/components/shell';
import { publishRun, reviewRun, runExecute, submitForReview } from '../actions';

export const dynamic = 'force-dynamic';

type ResultRow = {
  id: string;
  sector_code: string | null;
  sector_name: string | null;
  sector_item_id: string | null;
  period_label: string;
  approach: string;
  measure: string;
  price_basis: string;
  benchmarked: boolean;
  activity_code: string | null;
  activity_name: string | null;
  activity_item_id: string | null;
  value: string | null;
};

/** One annual constraint the quarterly figures were reconciled to. */
type ConstraintRow = {
  period_label: string;
  approach: string;
  measure: string;
  annual_total: string;
  indicator_total: string;
  benchmarked_total: string;
  residual: string;
};

type DiagnosticRow = {
  period_label: string | null;
  severity: string;
  code: string;
  message: string;
  subject: string | null;
};

/** Contributing source records for one drilled-into figure. */
type SourceRow = {
  transaction_code: string;
  activity_code: string | null;
  sector_code: string | null;
  value: string | null;
  source_row_number: number | null;
  raw: Record<string, string> | null;
  original_filename: string | null;
  sha256: string | null;
};

/** How each stored measure is named on the page. */
const MEASURE_LABEL: Record<string, string> = {
  gdp: 'GDP',
  total_gross_value_added: 'Σ gross value added',
  gross_value_added: 'Value added',
  sector_gross_value_added: 'Value added by sector',
  output: 'Output',
  intermediate_consumption: 'Intermediate consumption',
  taxes_on_products: 'Taxes on products',
  subsidies_on_products: 'Subsidies on products',
  final_consumption_expenditure: 'Final consumption expenditure',
  gross_capital_formation: 'Gross capital formation',
  net_exports: 'Net exports',
  total_factor_incomes: 'Factor incomes',
  net_taxes_on_production_and_imports: 'Net taxes on production and imports',
  population: 'Population',
};

/** Total-economy components, listed per period beneath the headline. */
const COMPONENT_MEASURES = [
  'total_gross_value_added',
  'taxes_on_products',
  'subsidies_on_products',
  'final_consumption_expenditure',
  'gross_capital_formation',
  'net_exports',
  'total_factor_incomes',
  'net_taxes_on_production_and_imports',
];

const fmt = (v: string | null) =>
  v === null ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 });

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; runId: string }>;
  searchParams: Promise<{ error?: string; drill?: string; period?: string }>;
}) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');
  const { slug, runId } = await params;
  const { error, drill, period } = await searchParams;

  const data = await withRls(claims, {}, async (tx) => {
    const orgs = (await tx.execute(
      sql`select id, name, slug from organization where slug = ${slug}`,
    )) as unknown as { id: string; name: string; slug: string }[];
    if (orgs.length === 0) return null;

    const runs = (await tx.execute(sql`
      select r.id, r.name, r.status, r.anchor_approach, r.executed_at,
             r.error_message, r.volume_reference_period_label,
             r.volume_index_formula, r.published_at, r.embargo_until,
             r.created_by, r.frequency::text as frequency,
             r.benchmark_source_run_id, r.benchmark_method,
             r.fisim_treatment, r.expenditure_includes_imputed_rent,
             b.name as benchmark_name,
             v.name as vintage_name, v.frozen_at,
             v.published as vintage_published, v.embargo_until as vintage_embargo,
             mv.engine_semver, mv.config
        from compilation_run r
        join data_vintage v on v.id = r.input_vintage_id
        left join compilation_run b on b.id = r.benchmark_source_run_id
        left join method_version mv on mv.id = r.method_version_id
       where r.id = ${runId}::uuid
    `)) as unknown as {
      id: string; name: string; status: string; anchor_approach: string;
      executed_at: string | null; error_message: string | null;
      volume_reference_period_label: string | null;
      volume_index_formula: string | null;
      published_at: string | null; embargo_until: string | null;
      created_by: string | null; frequency: string;
      benchmark_source_run_id: string | null; benchmark_method: string;
      fisim_treatment: string;
      expenditure_includes_imputed_rent: boolean | null;
      benchmark_name: string | null;
      vintage_name: string; frozen_at: string | null;
      vintage_published: boolean; vintage_embargo: string | null;
      engine_semver: string | null; config: Record<string, unknown> | null;
    }[];
    if (runs.length === 0) return null;

    const results = (await tx.execute(sql`
      select cr.id, p.label as period_label, cr.approach, cr.measure, cr.price_basis,
             cr.benchmarked,
             ci.code as activity_code, ci.name as activity_name,
             cr.activity_item_id,
             si.code as sector_code, si.name as sector_name,
             cr.sector_item_id, cr.value
        from compilation_result cr
        join reference_period p on p.id = cr.period_id
        left join classification_item ci on ci.id = cr.activity_item_id
        left join classification_item si on si.id = cr.sector_item_id
       where cr.run_id = ${runId}::uuid
       order by p.start_date, cr.approach, ci.sort_order nulls first, cr.measure
    `)) as unknown as ResultRow[];

    const diagnostics = (await tx.execute(sql`
      select p.label as period_label, d.severity, d.code, d.message, d.subject
        from compilation_diagnostic d
        left join reference_period p on p.id = d.period_id
       where d.run_id = ${runId}::uuid
       order by d.severity, d.id
    `)) as unknown as DiagnosticRow[];

    // Drill-down: from a per-industry aggregate back to the observations that
    // produced it, the staging rows those came from, and the source file.
    // Drill-down reads the provenance recorded when the run executed
    // (migration 0011) rather than working out which rows ought to have fed a
    // figure. The run pins its method version; this shows what that method
    // actually summed.
    let sources: SourceRow[] = [];
    if (drill) {
      sources = [
        ...((await tx.execute(sql`
          select ts.transaction_code, ci.code as activity_code,
                 si.code as sector_code, o.value,
                 sr.source_row_number, sr.raw,
                 d.original_filename, d.sha256
            from result_source rs
            join compilation_result cr on cr.id = rs.result_id
            join observation o on o.id = rs.observation_id
            join time_series ts on ts.id = o.series_id
            left join classification_item ci on ci.id = ts.activity_item_id
            left join classification_item si on si.id = ts.sector_item_id
            left join staging_row sr on sr.id = o.staging_row_id
            left join source_dataset d on d.id = o.source_dataset_id
           where rs.org_id = ${orgs[0].id}
             and cr.run_id = ${runId}::uuid
             and rs.result_id = ${drill}::bigint
           order by ts.transaction_code, ci.code nulls first
        `)) as unknown as SourceRow[]),
      ];
    }

    // Which figures have provenance to show, so a "sources" link is only
    // offered where there is something behind it. Derived measures — growth
    // rates, per-capita — are computed from other results and have none.
    const withSources = (await tx.execute(sql`
      select distinct rs.result_id
        from result_source rs
        join compilation_result cr on cr.id = rs.result_id
       where cr.run_id = ${runId}::uuid
    `)) as unknown as { result_id: string }[];

    const constraints = (await tx.execute(sql`
      select p.label as period_label, bc.approach::text as approach,
             bc.measure, bc.annual_total, bc.indicator_total,
             bc.benchmarked_total, bc.residual
        from benchmark_constraint bc
        join reference_period p on p.id = bc.annual_period_id
       where bc.run_id = ${runId}::uuid
         and bc.activity_item_id is null
       order by p.start_date, bc.approach, bc.measure
    `)) as unknown as ConstraintRow[];

    const reviews = (await tx.execute(sql`
      select rr.decision::text as decision, rr.note, rr.decided_at, u.email
        from run_review rr
        left join public.org_members(${orgs[0].id}::uuid) u on u.user_id = rr.reviewer_id
       where rr.run_id = ${runId}::uuid
       order by rr.decided_at desc
    `)) as unknown as {
      decision: string; note: string; decided_at: string; email: string | null;
    }[];

    // Whether the adjustment settings are worth showing at all: a run whose
    // vintage carries no FISIM or imputed-rent rows is not compiled under a
    // FISIM treatment in any meaningful sense, and a header row saying
    // "allocated" would suggest an adjustment that never happened.
    const adjustments = (await tx.execute(sql`
      select tc.kind, count(*)::int as n
        from observation o
        join time_series ts on ts.id = o.series_id
        join transaction_code tc on tc.code = ts.transaction_code
       where o.org_id = ${orgs[0].id}
         and o.vintage_id = (select input_vintage_id from compilation_run
                              where id = ${runId}::uuid)
         and tc.kind = 'adjustment'
       group by tc.kind
    `)) as unknown as { kind: string; n: number }[];

    const membership = (await tx.execute(sql`
      select role::text as role from membership
       where org_id = ${orgs[0].id} and user_id = ${claims.sub}::uuid
    `)) as unknown as { role: string }[];

    return {
      org: orgs[0],
      run: runs[0],
      results: [...results],
      diagnostics: [...diagnostics],
      constraints: [...constraints],
      sources,
      reviews: [...reviews],
      withSources: new Set([...withSources].map((r) => String(r.result_id))),
      hasAdjustments: (adjustments[0]?.n ?? 0) > 0,
      role: membership[0]?.role ?? 'viewer',
    };
  });

  if (!data) notFound();
  const { org, run, results, diagnostics, constraints, sources, reviews, role } =
    data;

  /** The figure being drilled into, if any: it names its own panel. */
  const drilled = drill ? results.find((r) => String(r.id) === drill) : undefined;

  /**
   * A link to the source records behind one figure, shown only where the run
   * recorded some. Derived measures have none and get no link rather than a
   * link to an empty table.
   */
  const Sources = ({ row }: { row: ResultRow }) =>
    data.withSources.has(String(row.id)) ? (
      <Link href={`/orgs/${org.slug}/runs/${run.id}?drill=${row.id}`}>sources</Link>
    ) : null;

  const canCompile = role === 'admin' || role === 'compiler';
  const canReview = role === 'admin' || role === 'reviewer';
  const isOwnWork = run.created_by === claims.sub;
  const embargo = [run.embargo_until, run.vintage_embargo]
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  const embargoActive = embargo ? new Date(embargo) > new Date() : false;

  const periods = [...new Set(results.map((r) => r.period_label))];

  /* A benchmarked run holds two figures for the same cell — the indicator as
     compiled and the figure after reconciliation. Every lookup therefore says
     which one it wants; defaulting would eventually publish the wrong one. */
  const value = (
    periodLabel: string,
    approach: string,
    measure: string,
    benchmarked = false,
  ) =>
    results.find(
      (r) =>
        r.period_label === periodLabel &&
        r.approach === approach &&
        r.measure === measure &&
        r.price_basis === 'current' &&
        r.benchmarked === benchmarked &&
        r.activity_item_id === null,
    )?.value ?? null;

  /** Chain-linked figures, which live under price_basis 'chain_linked'. */
  const volume = (
    periodLabel: string,
    measure: string,
    activityItemId: string | null = null,
  ) =>
    results.find(
      (r) =>
        r.period_label === periodLabel &&
        r.measure === measure &&
        r.price_basis === 'chain_linked' &&
        r.activity_item_id === activityItemId,
    )?.value ?? null;

  const isQuarterly = run.frequency === 'quarterly';
  const hasBenchmarked = results.some((r) => r.benchmarked);
  /* Headline GDP as published: the benchmarked figure where there is one. */
  const headline = (periodLabel: string) =>
    value(periodLabel, 'summary', 'headline_gdp', hasBenchmarked) ??
    value(periodLabel, 'summary', 'headline_gdp');

  /* Growth and per-capita are computed by the engine and stored with the run,
     not recomputed here: an export and a screen must not be able to disagree
     about a published rate. */
  const derived = (periodLabel: string, measure: string) =>
    value(periodLabel, 'summary', measure, hasBenchmarked) ??
    value(periodLabel, 'summary', measure);

  const pct = (v: string | null) => (v === null ? '—' : Number(v).toFixed(2));
  const hasPerCapita = periods.some((p) => derived(p, 'gdp_per_capita') !== null);

  const hasVolumes = results.some((r) => r.price_basis === 'chain_linked');
  const volumeIndustries = results.filter(
    (r) =>
      r.price_basis === 'chain_linked' &&
      r.measure === 'chain_linked_value' &&
      r.activity_item_id !== null &&
      r.period_label === periods[0],
  );

  const drilledName = drilled
    ? [
        MEASURE_LABEL[drilled.measure] ?? drilled.measure,
        drilled.activity_name ?? drilled.sector_name,
        drilled.period_label,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const STAGES = ['computed', 'under_review', 'approved', 'published'];
  const stageIndex = STAGES.indexOf(run.status);

  return (
    <>
      <OrgShell
        slug={org.slug}
        orgName={org.name}
        email={claims.email}
        current="runs"
      />
      <main>
        <Link className="backlink" href={`/orgs/${org.slug}/runs`}>
          ← Compilation runs
        </Link>
        <h1>{run.name}</h1>
        <ul className="meta">
          <li>
            <span className="k">Vintage</span>
            <span className="v">
              {run.vintage_name}
              {run.frozen_at ? ' (frozen)' : ''}
            </span>
          </li>
          <li>
            <span className="k">Frequency</span>
            <span className="v">{run.frequency}</span>
          </li>
          <li>
            <span className="k">Anchor</span>
            <span className="v">{run.anchor_approach}</span>
          </li>
          {isQuarterly && (
            <li>
              <span className="k">Benchmark</span>
              <span className="v">
                {run.benchmark_name
                  ? `${run.benchmark_name} · ${run.benchmark_method.replace('denton_', 'Denton ')}`
                  : 'none'}
              </span>
            </li>
          )}
          {data.hasAdjustments && (
            <>
              <li>
                <span className="k">FISIM</span>
                <span className="v">{run.fisim_treatment}</span>
              </li>
              <li>
                <span className="k">Imputed rent in P.31</span>
                <span className="v">
                  {run.expenditure_includes_imputed_rent === null
                    ? 'not stated'
                    : run.expenditure_includes_imputed_rent
                      ? 'yes'
                      : 'no'}
                </span>
              </li>
            </>
          )}
          {run.engine_semver && (
            <li>
              <span className="k">Engine</span>
              <span className="v mono">{run.engine_semver}</span>
            </li>
          )}
          {run.executed_at && (
            <li>
              <span className="k">Executed</span>
              <span className="v mono">
                {new Date(run.executed_at).toISOString().slice(0, 16).replace('T', ' ')}
              </span>
            </li>
          )}
        </ul>

        {/* The run really does pass through these states in order, so the
            numbering encodes the workflow rather than decorating it. */}
        <ol className="stepper">
          {[
            ['Computed', 'computed'],
            ['Under review', 'under_review'],
            ['Approved', 'approved'],
            ['Published', 'published'],
          ].map(([label, key], i) => (
            <li
              key={key}
              className={
                stageIndex > i ? 'is-done' : stageIndex === i ? 'is-current' : ''
              }
            >
              <span className="n">{i + 1}</span> {label}
            </li>
          ))}
        </ol>

        {error && (
          <div className="callout is-critical">
            <p className="error" style={{ margin: 0 }}>
              {error}
            </p>
          </div>
        )}
        {run.error_message && (
          <div className="callout is-critical">
            <p className="callout-title">Execution failed</p>
            <p className="muted" style={{ margin: 0 }}>
              {run.error_message}
            </p>
          </div>
        )}

        <div className="actions">
          <form action={runExecute}>
            <input type="hidden" name="slug" value={org.slug} />
            <input type="hidden" name="runId" value={run.id} />
            <button type="submit" className={results.length > 0 ? 'secondary' : undefined}>
              {run.status === 'computed' || results.length > 0 ? 'Re-execute' : 'Execute'}
            </button>
          </form>
          {results.length > 0 && (
            <>
              <a href={`/orgs/${org.slug}/runs/${run.id}/export/sdmx-csv`}>
                Export SDMX-CSV
              </a>
              <a href={`/orgs/${org.slug}/runs/${run.id}/export/xlsx`}>
                Export Excel
              </a>
            </>
          )}
        </div>

        {results.length === 0 ? (
          <p className="empty">
            No results yet. Executing reads the observations in the run&apos;s
            vintage and compiles every period they cover.
          </p>
        ) : (
          <>
            <Panel title="GDP at market prices, by approach" scroll>
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className="num">Production</th>
                    <th className="num">Expenditure</th>
                    <th className="num">Income</th>
                    <th className="num">Headline</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p}>
                      <td className="mono">{p}</td>
                      <td className="num">{fmt(value(p, 'production', 'gdp'))}</td>
                      <td className="num">{fmt(value(p, 'expenditure', 'gdp'))}</td>
                      <td className="num">{fmt(value(p, 'income', 'gdp'))}</td>
                      <td className="num strong">
                        {fmt(value(p, 'summary', 'headline_gdp'))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            {/* The components each approach was built from. They were always
                stored; until provenance was recorded there was nothing useful
                to do with them on the page, and a figure with no way back to
                its sources is the thing milestone 5 set out to avoid. */}
            {periods.map((p) => {
              const components = results.filter(
                (r) =>
                  r.period_label === p &&
                  r.price_basis === 'current' &&
                  r.activity_item_id === null &&
                  COMPONENT_MEASURES.includes(r.measure),
              );
              if (components.length === 0) return null;
              return (
                <Panel key={`components-${p}`} title={`Components · ${p}`} scroll>
                  <table>
                    <thead>
                      <tr>
                        <th>Approach</th>
                        <th>Component</th>
                        <th className="num">Value</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {components.map((r) => (
                        <tr key={r.id}>
                          <td>{r.approach}</td>
                          <td>{MEASURE_LABEL[r.measure] ?? r.measure}</td>
                          <td className="num">{fmt(r.value)}</td>
                          <td>
                            <Sources row={r} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
              );
            })}

            <Panel title="Statistical discrepancy" scroll>
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className="num">Production</th>
                    <th className="num">Expenditure</th>
                    <th className="num">Income</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p}>
                      <td className="mono">{p}</td>
                      {(['production', 'expenditure', 'income'] as const).map((a) => {
                        const v = value(p, 'summary', `statistical_discrepancy_${a}`);
                        return (
                          <td
                            key={a}
                            className={
                              v !== null && Number(v) < 0 ? 'num is-negative' : 'num'
                            }
                          >
                            {fmt(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <p className="muted">
              Anchor minus the approach, so a positive figure means that
              approach falls short of the headline. Discrepancies are reported,
              never removed by adjusting an estimate.
            </p>

            {/* Per-capita and growth, whatever the frequency. The brief asks
                for both; the quarterly panel below adds the year-on-year
                comparison, which only means something sub-annually. */}
            <Panel title="Per capita and growth" scroll>
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className="num">Headline GDP</th>
                    {hasPerCapita && <th className="num">Population</th>}
                    {hasPerCapita && <th className="num">GDP per capita</th>}
                    <th className="num">
                      {isQuarterly ? 'Q/Q %' : 'Growth %'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => {
                    const growth = derived(p, 'gdp_growth_percent');
                    return (
                      <tr key={p}>
                        <td className="mono">{p}</td>
                        <td className="num strong">{fmt(headline(p))}</td>
                        {hasPerCapita && (
                          <td className="num">{fmt(derived(p, 'population'))}</td>
                        )}
                        {hasPerCapita && (
                          <td className="num">{fmt(derived(p, 'gdp_per_capita'))}</td>
                        )}
                        <td
                          className={
                            growth !== null && Number(growth) < 0
                              ? 'num is-negative'
                              : 'num'
                          }
                        >
                          {pct(growth)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
            {hasPerCapita ? (
              <p className="muted">
                Population is a memorandum item, uploaded with the rest of the
                source data on transaction code{' '}
                <span className="mono">POP</span> and frozen with the same
                vintage — so a published per-capita figure is re-computable from
                exactly the inputs behind it. It must be the mid-year or
                period-average <em>resident</em> population: an end-of-period or
                de jure count against a resident-basis GDP is a common and
                quietly wrong comparison.
              </p>
            ) : (
              <p className="muted">
                No population figure in this vintage, so GDP per capita is not
                shown. Upload it as an observation on transaction code{' '}
                <span className="mono">POP</span> with a count unit (
                <span className="mono">PERSONS</span> or{' '}
                <span className="mono">PERSONS_TH</span>).
              </p>
            )}

            {isQuarterly && (
              <>
                <h2>Quarterly path</h2>
                <Panel
                  title={
                    hasBenchmarked
                      ? 'Headline GDP — indicator and benchmarked'
                      : 'Headline GDP — as compiled, not benchmarked'
                  }
                  scroll
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Quarter</th>
                        <th className="num">Indicator</th>
                        {hasBenchmarked && <th className="num">Benchmarked</th>}
                        {hasBenchmarked && <th className="num">Ratio</th>}
                        <th className="num">Q/Q %</th>
                        <th className="num">Y/Y %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periods.map((p) => {
                        const indicator = value(p, 'summary', 'headline_gdp');
                        const reconciled = value(p, 'summary', 'headline_gdp', true);
                        const ratio =
                          indicator !== null &&
                          reconciled !== null &&
                          Number(indicator) !== 0
                            ? Number(reconciled) / Number(indicator)
                            : null;
                        const qoq = derived(p, 'gdp_growth_percent');
                        const yoy = derived(p, 'gdp_growth_yoy_percent');
                        return (
                          <tr key={p}>
                            <td className="mono">{p}</td>
                            <td className="num">{fmt(indicator)}</td>
                            {hasBenchmarked && (
                              <td className="num strong">{fmt(reconciled)}</td>
                            )}
                            {hasBenchmarked && (
                              <td className="num">
                                {ratio === null ? '—' : ratio.toFixed(4)}
                              </td>
                            )}
                            <td
                              className={
                                qoq !== null && Number(qoq) < 0
                                  ? 'num is-negative'
                                  : 'num'
                              }
                            >
                              {pct(qoq)}
                            </td>
                            <td
                              className={
                                yoy !== null && Number(yoy) < 0
                                  ? 'num is-negative'
                                  : 'num'
                              }
                            >
                              {pct(yoy)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Panel>
                <p className="muted">
                  Growth rates are computed on the published figure — the
                  benchmarked one where the run is benchmarked. These series
                  are <strong>not seasonally adjusted</strong>: quarter-on-quarter
                  movements therefore carry the seasonal pattern as well as the
                  underlying change, which is why the year-on-year column is
                  the one usually quoted.
                </p>

                {constraints.length > 0 && (
                  <>
                    <Panel title="Reconciliation to the annual accounts" scroll>
                      <table>
                        <thead>
                          <tr>
                            <th>Year</th>
                            <th>Series</th>
                            <th className="num">Annual total</th>
                            <th className="num">Indicator sum</th>
                            <th className="num">Benchmarked sum</th>
                            <th className="num">Residual</th>
                          </tr>
                        </thead>
                        <tbody>
                          {constraints.map((c, i) => (
                            <tr key={i}>
                              <td className="mono">{c.period_label}</td>
                              <td className="muted">
                                {c.approach} · {c.measure.replace(/_/g, ' ')}
                              </td>
                              <td className="num">{fmt(c.annual_total)}</td>
                              <td className="num">{fmt(c.indicator_total)}</td>
                              <td className="num strong">{fmt(c.benchmarked_total)}</td>
                              <td className="num">{fmt(c.residual)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Panel>
                    <p className="muted">
                      The residual column is the check, not a finding: it is
                      zero because the constraint was imposed. It is stored and
                      shown so an auditor can confirm that rather than take the
                      method&apos;s word for it.
                    </p>
                  </>
                )}

                {hasBenchmarked ? (
                  <div className="callout is-note">
                    <p className="callout-title">
                      What benchmarking changed, and what it did not
                    </p>
                    <p>
                      The quarters now sum exactly to the annual accounts,
                      because the annual figures come from better sources —
                      censuses, audited government accounts, full-year tax
                      records — than any quarterly indicator does. What
                      survives from the indicator is its <em>movement</em>.
                    </p>
                    <p className="muted">
                      Denton finds the adjustment that meets every annual total
                      while changing as little as possible from one quarter to
                      the next. The naive alternative — prorating each year
                      separately — also meets the totals, but applies one
                      adjustment across a year and a different one across the
                      next, putting a step in the published growth rate at
                      every turn of the year that nothing in the economy caused.
                    </p>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      Quarters after the last benchmarked year carry the final
                      adjustment forward unchanged. They are estimates against
                      an annual total that does not exist yet, and will be
                      revised when it does — which is normal for quarterly
                      accounts, not a defect in these figures.
                    </p>
                  </div>
                ) : (
                  <div className="callout is-warning">
                    <p className="callout-title">Not benchmarked</p>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      These quarters are the compiled indicator. They are not
                      guaranteed to sum to the annual accounts for the same
                      years, so publishing both without reconciling them would
                      put two different figures for the same year into the
                      public record. Choose an executed annual run as the
                      benchmark when creating the run.
                    </p>
                  </div>
                )}
              </>
            )}

            <h2>Value added by industry</h2>
            {periods.map((p) => {
              const rows = results.filter(
                (r) =>
                  r.period_label === p &&
                  r.measure === 'gross_value_added' &&
                  r.price_basis === 'current' &&
                  r.activity_item_id !== null,
              );
              if (rows.length === 0) return null;
              return (
                <Panel key={p} title={`${p} · current prices`} scroll>
                  <table>
                    <thead>
                      <tr>
                        <th>Industry</th>
                        <th className="num">Output</th>
                        <th className="num">Intermediate</th>
                        <th className="num">Value added</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const other = (measure: string) =>
                          results.find(
                            (x) =>
                              x.period_label === p &&
                              x.measure === measure &&
                              x.price_basis === 'current' &&
                              x.activity_item_id === r.activity_item_id,
                          )?.value ?? null;
                        return (
                          <tr key={r.activity_item_id}>
                            <td>
                              <span className="mono">{r.activity_code}</span>{' '}
                              {r.activity_name}
                            </td>
                            <td className="num">{fmt(other('output'))}</td>
                            <td className="num">
                              {fmt(other('intermediate_consumption'))}
                            </td>
                            <td
                              className={
                                r.value !== null && Number(r.value) < 0
                                  ? 'num strong is-negative'
                                  : 'num strong'
                              }
                            >
                              {fmt(r.value)}
                            </td>
                            <td>
                              <Sources row={r} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Panel>
              );
            })}

            {/* The second cut of the same production account (D49). Value
                added only: taxes on products are levied on products, not on
                producers, so there is no sector GDP to show. */}
            {periods.some((p) =>
              results.some(
                (r) =>
                  r.period_label === p && r.measure === 'sector_gross_value_added',
              ),
            ) && <h2>Value added by institutional sector</h2>}
            {periods.map((p) => {
              const rows = results.filter(
                (r) =>
                  r.period_label === p &&
                  r.measure === 'sector_gross_value_added' &&
                  r.price_basis === 'current',
              );
              if (rows.length === 0) return null;
              const incomplete = diagnostics.find(
                (d) =>
                  d.code === 'sector_value_added_incomplete' &&
                  d.period_label === p,
              );
              return (
                <Panel key={`sectors-${p}`} title={`${p} · current prices`} scroll>
                  <table>
                    <thead>
                      <tr>
                        <th>Institutional sector</th>
                        <th className="num">Value added</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <span className="mono">{r.sector_code}</span>{' '}
                            {r.sector_name}
                          </td>
                          <td
                            className={
                              r.value !== null && Number(r.value) < 0
                                ? 'num strong is-negative'
                                : 'num strong'
                            }
                          >
                            {fmt(r.value)}
                          </td>
                          <td>
                            <Sources row={r} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {incomplete && (
                    <p className="muted" style={{ margin: '0.8rem 1rem 0' }}>
                      {incomplete.message}
                    </p>
                  )}
                </Panel>
              );
            })}

            {drill && (
              <>
                <h2>Source records — {drilledName ?? 'figure'}</h2>
                {sources.length === 0 ? (
                  <p className="empty">
                    No source records were recorded for that figure.
                  </p>
                ) : (
                  <Panel scroll>
                    <table>
                      <thead>
                        <tr>
                          <th>Transaction</th>
                          <th>Industry</th>
                          <th>Sector</th>
                          <th className="num">Value</th>
                          <th>Source file</th>
                          <th className="num">Row</th>
                          <th>As uploaded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sources.map((s, i) => (
                          <tr key={i}>
                            <td className="mono">{s.transaction_code}</td>
                            <td className="mono">{s.activity_code ?? '—'}</td>
                            <td className="mono">{s.sector_code ?? '—'}</td>
                            <td className="num">{fmt(s.value)}</td>
                            <td>
                              {s.original_filename ?? '—'}
                              {s.sha256 && (
                                <>
                                  <br />
                                  <span className="muted mono">
                                    {s.sha256.slice(0, 12)}…
                                  </span>
                                </>
                              )}
                            </td>
                            <td className="num">{s.source_row_number ?? '—'}</td>
                            <td className="muted mono">
                              {s.raw ? JSON.stringify(s.raw) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Panel>
                )}
                <p>
                  <Link href={`/orgs/${org.slug}/runs/${run.id}`}>
                    Close drill-down
                  </Link>
                </p>
              </>
            )}
          </>
        )}

        {hasVolumes && (
          <>
            <h2>Chain-linked volume measures</h2>
            <ul className="meta">
              <li>
                <span className="k">Reference period</span>
                <span className="v mono">{run.volume_reference_period_label}</span>
              </li>
              {run.volume_index_formula && (
                <li>
                  <span className="k">Index</span>
                  <span className="v">{run.volume_index_formula}</span>
                </li>
              )}
            </ul>
            <Panel scroll>
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className="num">Chain index</th>
                    <th className="num">Volume</th>
                    <th className="num">Growth %</th>
                    <th className="num">Sum of industries</th>
                    <th className="num">Residual</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => {
                    const aggregate = volume(p, 'chain_linked_value');
                    const residual = volume(p, 'non_additivity_residual');
                    const componentSum =
                      aggregate !== null && residual !== null
                        ? String(Number(aggregate) - Number(residual))
                        : null;
                    return (
                      <tr key={p}>
                        <td className="mono">{p}</td>
                        <td className="num">{fmt(volume(p, 'chain_index'))}</td>
                        <td className="num">{fmt(aggregate)}</td>
                        <td className="num">
                          {fmt(volume(p, 'volume_growth_percent'))}
                        </td>
                        <td className="num">{fmt(componentSum)}</td>
                        <td
                          className={
                            residual !== null && Number(residual) < 0
                              ? 'num is-negative'
                              : 'num'
                          }
                        >
                          {fmt(residual)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>

            {/* The brief is explicit that users report non-additivity as a bug.
                This is the message that stops the support ticket being written. */}
            <div className="callout is-note">
              <p className="callout-title">
                Why the industries do not add up to the total
              </p>
              <p>
                The <strong>Residual</strong> column is not an error and not a
                rounding artefact. Chain-linked volumes are{' '}
                <em>not additive</em>, and cannot be made additive without
                misstating the components.
              </p>
              <p className="muted">
                Each series is revalued at its own previous period&apos;s prices
                before being linked, so every series carries a different set of
                price weights. Adding series with different weights does not
                give the aggregate, which carries the weights of the whole
                economy. The parts do add up in the reference period, and in the
                period immediately after it, and then diverge — which is why the
                residual starts at zero and grows.
              </p>
              <p className="muted" style={{ marginBottom: 0 }}>
                SNA 2008 chapter 15 treats this as a property of the measure,
                and publishing the residual is standard practice among national
                statistical offices. Forcing the components to sum would change
                each industry&apos;s published volume to preserve an arithmetic
                property the measure does not have. Current-price figures{' '}
                <em>are</em> additive.
              </p>
            </div>

            {volumeIndustries.length > 0 && (
              <Panel title="Volume by industry" scroll>
                <table>
                  <thead>
                    <tr>
                      <th>Industry</th>
                      {periods.map((p) => (
                        <th key={p} className="num">
                          {p}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {volumeIndustries.map((industry) => (
                      <tr key={industry.activity_item_id}>
                        <td>
                          <span className="mono">{industry.activity_code}</span>{' '}
                          {industry.activity_name}
                        </td>
                        {periods.map((p) => (
                          <td key={p} className="num">
                            {fmt(
                              volume(p, 'chain_linked_value', industry.activity_item_id),
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}
          </>
        )}

        <h2>Review and publication</h2>
        {embargoActive && (
          <div className="callout is-critical">
            <p className="callout-title">
              Embargoed until{' '}
              {new Date(embargo!).toISOString().replace('T', ' ').slice(0, 16)}
            </p>
            <p className="muted" style={{ marginBottom: 0 }}>
              Members of this organization can see these figures — compiling
              them is the job. The embargo governs release to anyone else, and
              every export is stamped until it lifts.
            </p>
          </div>
        )}

        <Panel>
          <ul className="meta" style={{ marginBottom: '0.75rem' }}>
            <li>
              <span className="k">Status</span>
              <span className="v">{run.status.replace('_', ' ')}</span>
            </li>
            {run.frozen_at && (
              <li>
                <span className="k">Vintage frozen</span>
                <span className="v mono">
                  {new Date(run.frozen_at).toISOString().slice(0, 10)}
                </span>
              </li>
            )}
            {run.published_at && (
              <li>
                <span className="k">Published</span>
                <span className="v mono">
                  {new Date(run.published_at).toISOString().slice(0, 10)}
                </span>
              </li>
            )}
          </ul>

          {run.status === 'computed' && canCompile && (
            <form action={submitForReview}>
              <input type="hidden" name="slug" value={org.slug} />
              <input type="hidden" name="runId" value={run.id} />
              <button type="submit">Submit for review</button>
            </form>
          )}

          {run.status === 'under_review' && canReview && !isOwnWork && (
            <form className="stack" action={reviewRun}>
              <input type="hidden" name="slug" value={org.slug} />
              <input type="hidden" name="runId" value={run.id} />
              <label>
                Decision
                <select name="decision" defaultValue="approved">
                  <option value="approved">
                    Approve — freezes the input vintage
                  </option>
                  <option value="changes_requested">Request changes</option>
                </select>
              </label>
              <label>
                Note
                <input
                  name="note"
                  required
                  placeholder="What you checked, and what you concluded"
                />
              </label>
              <button type="submit">Record decision</button>
            </form>
          )}

          {run.status === 'under_review' && canReview && isOwnWork && (
            <p className="muted" style={{ marginBottom: 0 }}>
              You created this run, so you cannot review it. Separation of
              duties is the reason the reviewer role exists — ask another
              reviewer.
            </p>
          )}

          {run.status === 'under_review' && !canReview && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Awaiting a reviewer.
            </p>
          )}

          {run.status === 'approved' && role === 'admin' && (
            <form className="stack" action={publishRun}>
              <input type="hidden" name="slug" value={org.slug} />
              <input type="hidden" name="runId" value={run.id} />
              <label>
                Embargo until (optional)
                <input type="datetime-local" name="embargoUntil" />
              </label>
              <button type="submit">Publish</button>
            </form>
          )}

          {run.status === 'approved' && role !== 'admin' && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Approved. An admin can publish it.
            </p>
          )}
        </Panel>

        {reviews.length > 0 && (
          <Panel title="Review history" scroll>
            <table>
              <thead>
                <tr>
                  <th>Decision</th>
                  <th>Reviewer</th>
                  <th>When</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <span
                        className={
                          r.decision === 'approved'
                            ? 'pill is-positive'
                            : 'pill is-warning'
                        }
                      >
                        {r.decision === 'approved' ? 'approved' : 'changes requested'}
                      </span>
                    </td>
                    <td className="mono">{r.email ?? 'unknown'}</td>
                    <td className="mono muted">
                      {new Date(r.decided_at).toISOString().slice(0, 10)}
                    </td>
                    <td>{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        {results.length > 0 && (
          <p className="muted">
            Exports carry the run&apos;s provenance: input vintage, freeze time,
            pinned engine version and method configuration, and the SHA-256 of
            every source file behind the figures.
            {embargoActive &&
              ' Both formats are stamped EMBARGOED until the release time.'}
          </p>
        )}

        {diagnostics.length > 0 && (
          <>
            <h2>Diagnostics</h2>
            <Panel scroll>
              <table>
                <thead>
                  <tr>
                    <th>Finding</th>
                    <th>Period</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostics.map((d, i) => (
                    <tr key={i} className={`sev-${d.severity}`}>
                      <td>
                        <span className="mono">{d.code}</span>{' '}
                        <span
                          className={
                            d.severity === 'warning' ? 'pill is-warning' : 'pill'
                          }
                        >
                          {d.severity}
                        </span>
                        {d.subject && (
                          <span className="muted"> · {d.subject}</span>
                        )}
                        <br />
                        <span className="muted">{d.message}</span>
                      </td>
                      <td className="mono muted">{d.period_label ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </>
        )}
      </main>
    </>
  );
}
