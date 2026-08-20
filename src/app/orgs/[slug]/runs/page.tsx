import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { OrgShell, Panel } from '@/components/shell';
import { createRun } from './actions';

export const dynamic = 'force-dynamic';

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');
  const { slug } = await params;
  const { error } = await searchParams;

  const data = await withRls(claims, {}, async (tx) => {
    const orgs = (await tx.execute(
      sql`select id, name, slug from organization where slug = ${slug}`,
    )) as unknown as { id: string; name: string; slug: string }[];
    if (orgs.length === 0) return null;
    const runs = (await tx.execute(sql`
      select r.id, r.name, r.status, r.anchor_approach, r.executed_at,
             v.name as vintage_name, v.frozen_at
        from compilation_run r
        join data_vintage v on v.id = r.input_vintage_id
       where r.org_id = ${orgs[0].id} order by r.created_at desc
    `)) as unknown as {
      id: string; name: string; status: string; anchor_approach: string;
      executed_at: string | null; vintage_name: string; frozen_at: string | null;
    }[];
    const vintages = (await tx.execute(sql`
      select v.id, v.name, v.frozen_at,
             (select count(*)::int from observation o where o.vintage_id = v.id) as n
        from data_vintage v where v.org_id = ${orgs[0].id} order by v.created_at desc
    `)) as unknown as { id: string; name: string; frozen_at: string | null; n: number }[];
    return { org: orgs[0], runs: [...runs], vintages: [...vintages] };
  });

  if (!data) notFound();

  const STATUS: Record<string, string> = {
    draft: 'pill',
    computing: 'pill is-accent',
    computed: 'pill is-accent',
    failed: 'pill is-critical',
    under_review: 'pill is-warning',
    approved: 'pill is-positive',
    published: 'pill is-positive',
    superseded: 'pill',
  };

  return (
    <>
      <OrgShell
        slug={data.org.slug}
        orgName={data.org.name}
        email={claims.email}
        current="runs"
      />
      <main>
        <h1>Compilation runs</h1>
        <p className="lede">
          A run is a named exercise — &ldquo;2024 Annual Estimates, first
          release&rdquo;. It pins the vintage it reads and the engine version
          that computed it, so every figure it produces can be re-derived.
        </p>

        {error && (
          <div className="callout is-critical">
            <p className="error" style={{ margin: 0 }}>
              {error}
            </p>
          </div>
        )}

        <h2>Runs</h2>
        {data.runs.length === 0 ? (
          <p className="empty">No runs yet.</p>
        ) : (
          <Panel scroll>
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Input vintage</th>
                  <th>Anchor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/orgs/${data.org.slug}/runs/${r.id}`}>
                        {r.name}
                      </Link>
                      {r.executed_at && (
                        <>
                          <br />
                          <span className="muted mono">
                            executed{' '}
                            {new Date(r.executed_at)
                              .toISOString()
                              .slice(0, 16)
                              .replace('T', ' ')}
                          </span>
                        </>
                      )}
                    </td>
                    <td>
                      {r.vintage_name}
                      {r.frozen_at && (
                        <>
                          {' '}
                          <span className="pill">frozen</span>
                        </>
                      )}
                    </td>
                    <td className="mono muted">{r.anchor_approach}</td>
                    <td>
                      <span className={STATUS[r.status] ?? 'pill'}>
                        {r.status.replace('_', ' ')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        <h2>New run</h2>
        {data.vintages.length === 0 ? (
          <p className="empty">
            No vintages yet. Commit source data first — a run reads the
            observations a vintage holds.
          </p>
        ) : (
          <>
            <form className="stack wide" action={createRun}>
              <input type="hidden" name="slug" value={data.org.slug} />
              <label>
                Name
                <input
                  name="name"
                  placeholder="2024 Annual Estimates, first release"
                  required
                />
              </label>
              <label>
                Input vintage
                <select name="vintageId" required defaultValue="">
                  <option value="" disabled>
                    — choose —
                  </option>
                  {data.vintages.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} — {v.n} observation{v.n === 1 ? '' : 's'}
                      {v.frozen_at ? ' (frozen)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Balancing anchor
                <select name="anchor" defaultValue="production">
                  <option value="production">production</option>
                  <option value="expenditure">expenditure</option>
                  <option value="income">income</option>
                  <option value="none">none — publish no headline</option>
                </select>
              </label>
              <label>
                Frequency
                <select name="frequency" defaultValue="annual">
                  <option value="annual">annual</option>
                  <option value="quarterly">quarterly</option>
                </select>
              </label>
              <label>
                Volume reference period (optional)
                <input name="volumeReference" placeholder="2021" />
              </label>
              <label>
                Index formula
                <select name="volumeFormula" defaultValue="">
                  <option value="">— current prices only —</option>
                  <option value="laspeyres">Laspeyres</option>
                  <option value="paasche">Paasche</option>
                  <option value="fisher">Fisher</option>
                </select>
              </label>
              <button type="submit">Create run</button>
            </form>
            <p className="muted">
              The anchor decides which approach is published as the headline.
              The others are reported with their discrepancy — never adjusted
              to agree. Naming a volume reference period chain-links the results
              to that period&apos;s price level, and needs deflators in the
              vintage.
            </p>
          </>
        )}
      </main>
    </>
  );
}
