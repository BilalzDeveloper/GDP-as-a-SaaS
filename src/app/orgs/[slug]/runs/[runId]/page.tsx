import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { publishRun, reviewRun, runExecute, submitForReview } from '../actions';

export const dynamic = 'force-dynamic';

type ResultRow = {
  period_label: string;
  approach: string;
  measure: string;
  price_basis: string;
  activity_code: string | null;
  activity_name: string | null;
  activity_item_id: string | null;
  value: string | null;
};

type DiagnosticRow = {
  period_label: string | null;
  severity: string;
  code: string;
  message: string;
  subject: string | null;
};

/** Contributing source records for one drilled-into industry and period. */
type SourceRow = {
  transaction_code: string;
  value: string | null;
  source_row_number: number | null;
  raw: Record<string, string> | null;
  original_filename: string | null;
  sha256: string | null;
};

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
             r.created_by, v.name as vintage_name, v.frozen_at,
             v.published as vintage_published, v.embargo_until as vintage_embargo,
             mv.engine_semver, mv.config
        from compilation_run r
        join data_vintage v on v.id = r.input_vintage_id
        left join method_version mv on mv.id = r.method_version_id
       where r.id = ${runId}::uuid
    `)) as unknown as {
      id: string; name: string; status: string; anchor_approach: string;
      executed_at: string | null; error_message: string | null;
      volume_reference_period_label: string | null;
      volume_index_formula: string | null;
      published_at: string | null; embargo_until: string | null;
      created_by: string | null;
      vintage_name: string; frozen_at: string | null;
      vintage_published: boolean; vintage_embargo: string | null;
      engine_semver: string | null; config: Record<string, unknown> | null;
    }[];
    if (runs.length === 0) return null;

    const results = (await tx.execute(sql`
      select p.label as period_label, cr.approach, cr.measure, cr.price_basis,
             ci.code as activity_code, ci.name as activity_name,
             cr.activity_item_id, cr.value
        from compilation_result cr
        join reference_period p on p.id = cr.period_id
        left join classification_item ci on ci.id = cr.activity_item_id
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
    let sources: SourceRow[] = [];
    if (drill && period) {
      sources = [
        ...((await tx.execute(sql`
          select ts.transaction_code, o.value, sr.source_row_number, sr.raw,
                 d.original_filename, d.sha256
            from observation o
            join time_series ts on ts.id = o.series_id
            join reference_period p on p.id = o.period_id
            left join staging_row sr on sr.id = o.staging_row_id
            left join source_dataset d on d.id = o.source_dataset_id
           where o.org_id = ${orgs[0].id}
             and o.vintage_id = (select input_vintage_id from compilation_run
                                  where id = ${runId}::uuid)
             and ts.activity_item_id = ${drill}::uuid
             and p.label = ${period}
           order by ts.transaction_code
        `)) as unknown as SourceRow[]),
      ];
    }

    const reviews = (await tx.execute(sql`
      select rr.decision::text as decision, rr.note, rr.decided_at, u.email
        from run_review rr
        left join public.org_members(${orgs[0].id}::uuid) u on u.user_id = rr.reviewer_id
       where rr.run_id = ${runId}::uuid
       order by rr.decided_at desc
    `)) as unknown as {
      decision: string; note: string; decided_at: string; email: string | null;
    }[];

    const membership = (await tx.execute(sql`
      select role::text as role from membership
       where org_id = ${orgs[0].id} and user_id = ${claims.sub}::uuid
    `)) as unknown as { role: string }[];

    return {
      org: orgs[0],
      run: runs[0],
      results: [...results],
      diagnostics: [...diagnostics],
      sources,
      reviews: [...reviews],
      role: membership[0]?.role ?? 'viewer',
    };
  });

  if (!data) notFound();
  const { org, run, results, diagnostics, sources, reviews, role } = data;

  const canCompile = role === 'admin' || role === 'compiler';
  const canReview = role === 'admin' || role === 'reviewer';
  const isOwnWork = run.created_by === claims.sub;
  const embargo = [run.embargo_until, run.vintage_embargo]
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  const embargoActive = embargo ? new Date(embargo) > new Date() : false;

  const periods = [...new Set(results.map((r) => r.period_label))];
  const value = (periodLabel: string, approach: string, measure: string) =>
    results.find(
      (r) =>
        r.period_label === periodLabel &&
        r.approach === approach &&
        r.measure === measure &&
        r.price_basis === 'current' &&
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

  const hasVolumes = results.some((r) => r.price_basis === 'chain_linked');
  const volumeIndustries = results.filter(
    (r) =>
      r.price_basis === 'chain_linked' &&
      r.measure === 'chain_linked_value' &&
      r.activity_item_id !== null &&
      r.period_label === periods[0],
  );

  const drilledName = sources.length
    ? results.find((r) => r.activity_item_id === drill)?.activity_name
    : null;

  return (
    <main>
      <p>
        <Link href={`/orgs/${org.slug}/runs`}>← Compilation runs</Link>
      </p>
      <h1>{run.name}</h1>
      <p className="muted">
        Vintage: {run.vintage_name}
        {run.frozen_at && ' (frozen)'} · Anchor: {run.anchor_approach} · Status:{' '}
        {run.status}
        {run.engine_semver && (
          <>
            <br />
            Method pinned: engine {run.engine_semver}
            {run.config ? ` · ${JSON.stringify(run.config)}` : ''}
          </>
        )}
      </p>
      {error && <p className="error">{error}</p>}
      {run.error_message && <p className="error">{run.error_message}</p>}

      <form action={runExecute} style={{ margin: '1rem 0' }}>
        <input type="hidden" name="slug" value={org.slug} />
        <input type="hidden" name="runId" value={run.id} />
        <button type="submit">
          {run.status === 'computed' ? 'Re-execute' : 'Execute'}
        </button>
      </form>

      {results.length === 0 ? (
        <p className="muted">
          No results yet. Executing reads the observations in the run&apos;s
          vintage and compiles every period they cover.
        </p>
      ) : (
        <>
          <h2>GDP by approach</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Production</th>
                  <th>Expenditure</th>
                  <th>Income</th>
                  <th>Headline</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p}>
                    <td>{p}</td>
                    <td>{fmt(value(p, 'production', 'gdp'))}</td>
                    <td>{fmt(value(p, 'expenditure', 'gdp'))}</td>
                    <td>{fmt(value(p, 'income', 'gdp'))}</td>
                    <td>
                      <strong>{fmt(value(p, 'summary', 'headline_gdp'))}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Statistical discrepancy</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Production</th>
                  <th>Expenditure</th>
                  <th>Income</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p}>
                    <td>{p}</td>
                    {(['production', 'expenditure', 'income'] as const).map((a) => (
                      <td key={a}>
                        {fmt(value(p, 'summary', `statistical_discrepancy_${a}`))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            Anchor minus the approach, so a positive figure means that approach
            falls short of the headline. Discrepancies are reported, never
            removed by adjusting an estimate.
          </p>

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
              <div key={p}>
                <h3>{p}</h3>
                <div className="card">
                  <table>
                    <thead>
                      <tr>
                        <th>Industry</th>
                        <th>Output</th>
                        <th>Intermediate</th>
                        <th>Value added</th>
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
                              {r.activity_code} {r.activity_name}
                            </td>
                            <td>{fmt(other('output'))}</td>
                            <td>{fmt(other('intermediate_consumption'))}</td>
                            <td>{fmt(r.value)}</td>
                            <td>
                              <Link
                                href={`/orgs/${org.slug}/runs/${run.id}?drill=${r.activity_item_id}&period=${encodeURIComponent(p)}`}
                              >
                                sources
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

          {drill && period && (
            <>
              <h2>
                Contributing source records — {drilledName ?? 'industry'}, {period}
              </h2>
              {sources.length === 0 ? (
                <p className="muted">No source records found for that cell.</p>
              ) : (
                <div className="card">
                  <table>
                    <thead>
                      <tr>
                        <th>Transaction</th>
                        <th>Value</th>
                        <th>Source file</th>
                        <th>Row</th>
                        <th>As uploaded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources.map((s, i) => (
                        <tr key={i}>
                          <td>{s.transaction_code}</td>
                          <td>{fmt(s.value)}</td>
                          <td>
                            {s.original_filename ?? '—'}
                            {s.sha256 && (
                              <>
                                <br />
                                <span className="muted">{s.sha256.slice(0, 12)}…</span>
                              </>
                            )}
                          </td>
                          <td>{s.source_row_number ?? '—'}</td>
                          <td>
                            <span className="muted">
                              {s.raw ? JSON.stringify(s.raw) : '—'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p>
                <Link href={`/orgs/${org.slug}/runs/${run.id}`}>Close drill-down</Link>
              </p>
            </>
          )}
        </>
      )}

      {hasVolumes && (
        <>
          <h2>Chain-linked volume measures</h2>
          <p className="muted">
            Reference period {run.volume_reference_period_label}
            {run.volume_index_formula && <> · {run.volume_index_formula} index</>}
            . Volumes are expressed in that period&apos;s price level, and the
            chain index is 100 there.
          </p>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Chain index</th>
                  <th>Volume</th>
                  <th>Growth %</th>
                  <th>Sum of industries</th>
                  <th>Residual</th>
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
                      <td>{p}</td>
                      <td>{fmt(volume(p, 'chain_index'))}</td>
                      <td>{fmt(aggregate)}</td>
                      <td>{fmt(volume(p, 'volume_growth_percent'))}</td>
                      <td>{fmt(componentSum)}</td>
                      <td>{fmt(residual)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/*
            The brief is explicit that users report non-additivity as a bug.
            This is the message that stops the support ticket being written.
          */}
          <div className="card">
            <h3 style={{ marginTop: 0 }}>
              Why the industries do not add up to the total
            </h3>
            <p>
              The <strong>Residual</strong> column above is not an error and not
              a rounding artefact. Chain-linked volumes are <em>not additive</em>
              , and cannot be made additive without misstating the components.
            </p>
            <p className="muted">
              Each series is revalued at its own previous period&apos;s prices
              before being linked, so every series carries a different set of
              price weights. Adding series with different weights does not give
              the aggregate, which carries the weights of the whole economy. The
              parts do add up in the reference period, and in the period
              immediately after it, and then diverge — which is why the residual
              starts at zero and grows.
            </p>
            <p className="muted">
              SNA 2008 chapter 15 treats this as a property of the measure, and
              publishing the residual is standard practice among national
              statistical offices. The alternative — forcing the components to
              sum — would change each industry&apos;s published volume to
              preserve an arithmetic property the measure does not have.
              Current-price figures, shown above, <em>are</em> additive.
            </p>
          </div>

          {volumeIndustries.length > 0 && (
            <>
              <h3>Volume by industry</h3>
              <div className="card">
                <table>
                  <thead>
                    <tr>
                      <th>Industry</th>
                      {periods.map((p) => (
                        <th key={p}>{p}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {volumeIndustries.map((industry) => (
                      <tr key={industry.activity_item_id}>
                        <td>
                          {industry.activity_code} {industry.activity_name}
                        </td>
                        {periods.map((p) => (
                          <td key={p}>
                            {fmt(
                              volume(p, 'chain_linked_value', industry.activity_item_id),
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      <h2>Review and publication</h2>
      {embargoActive && (
        <div className="card">
          <p className="error" style={{ margin: 0, fontWeight: 600 }}>
            Embargoed until {new Date(embargo!).toISOString().replace('T', ' ').slice(0, 16)}
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Members of this organization can see these figures — compiling them
            is the job. The embargo governs release to anyone else, and every
            export is stamped until it lifts.
          </p>
        </div>
      )}

      <div className="card">
        <p style={{ marginTop: 0 }}>
          Status: <strong>{run.status}</strong>
          {run.frozen_at && (
            <>
              {' · '}vintage frozen{' '}
              {new Date(run.frozen_at).toISOString().slice(0, 10)}
            </>
          )}
          {run.published_at && (
            <>
              {' · '}published{' '}
              {new Date(run.published_at).toISOString().slice(0, 10)}
            </>
          )}
        </p>

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
                <option value="approved">Approve — freezes the input vintage</option>
                <option value="changes_requested">Request changes</option>
              </select>
            </label>
            <label>
              Note (required)
              <input name="note" required placeholder="What you checked, and what you concluded" />
            </label>
            <button type="submit">Record decision</button>
          </form>
        )}

        {run.status === 'under_review' && canReview && isOwnWork && (
          <p className="muted">
            You created this run, so you cannot review it. Separation of duties
            is the reason the reviewer role exists — ask another reviewer.
          </p>
        )}

        {run.status === 'under_review' && !canReview && (
          <p className="muted">Awaiting a reviewer.</p>
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
          <p className="muted">Approved. An admin can publish it.</p>
        )}
      </div>

      {reviews.length > 0 && (
        <div className="card">
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
                  <td className={r.decision === 'approved' ? undefined : 'error'}>
                    {r.decision === 'approved' ? 'approved' : 'changes requested'}
                  </td>
                  <td>{r.email ?? 'unknown'}</td>
                  <td>{new Date(r.decided_at).toISOString().slice(0, 10)}</td>
                  <td>{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results.length > 0 && (
        <>
          <h3>Export</h3>
          <p>
            <a href={`/orgs/${org.slug}/runs/${run.id}/export/sdmx-csv`}>
              SDMX-CSV
            </a>
            {' · '}
            <a href={`/orgs/${org.slug}/runs/${run.id}/export/xlsx`}>Excel</a>
          </p>
          <p className="muted">
            Exports carry the run&apos;s provenance: input vintage, freeze time,
            pinned engine version and method configuration, and the SHA-256 of
            every source file behind the figures.
            {embargoActive && ' Both formats are stamped EMBARGOED until the release time.'}
          </p>
        </>
      )}

      {diagnostics.length > 0 && (
        <>
          <h2>Diagnostics</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Severity</th>
                  <th>Finding</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.map((d, i) => (
                  <tr key={i}>
                    <td>{d.period_label ?? '—'}</td>
                    <td>{d.severity}</td>
                    <td>
                      <strong>{d.code}</strong>
                      {d.subject && <span className="muted"> · {d.subject}</span>}
                      <br />
                      <span className="muted">{d.message}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
