import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { OrgShell, Panel } from '@/components/shell';
import { changedFields, describeRow, TABLE_LABEL } from './describe';

export const dynamic = 'force-dynamic';

/**
 * The audit trail, readable.
 *
 * Non-negotiable 2: "Every value change records who, when, what changed, and
 * why. NSOs are accountable to parliaments and international bodies." The
 * recording has been in place since milestone 1 — a trigger on every tenant
 * table, an append-only log, and a mandatory reason. What was missing was
 * anyone able to read it. A trail nobody can open does not discharge
 * accountability to anybody.
 *
 * The log is deliberately not paginated by offset. Offsets shift under
 * inserts, and an auditor scrolling a moving list can miss a row entirely —
 * so paging walks backwards from an id instead.
 */

const PAGE_SIZE = 100;

type Row = {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_email: string | null;
  table_name: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  row_pk: string;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  reason: string;
};

const ACTION_TONE: Record<Row['action'], string> = {
  INSERT: 'pill is-positive',
  UPDATE: 'pill is-accent',
  DELETE: 'pill is-critical',
};

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ table?: string; actor?: string; before?: string }>;
}) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');
  const { slug } = await params;
  const { table, actor, before } = await searchParams;

  const data = await withRls(claims, {}, async (tx) => {
    const orgs = (await tx.execute(
      sql`select id, name, slug from organization where slug = ${slug}`,
    )) as unknown as { id: string; name: string; slug: string }[];
    if (orgs.length === 0) return null;
    const org = orgs[0];

    // One extra row tells us whether there is another page, without a count.
    const entries = (await tx.execute(sql`
      select a.id::text as id, a.occurred_at, a.actor_id::text as actor_id,
             m.email as actor_email, a.table_name, a.action, a.row_pk,
             a.old_data, a.new_data, a.reason
        from audit_log a
        left join public.org_members(${org.id}::uuid) m on m.user_id = a.actor_id
       where a.org_id = ${org.id}::uuid
         and (${table ?? null}::text is null or a.table_name = ${table ?? null})
         and (${actor ?? null}::uuid is null or a.actor_id = ${actor ?? null}::uuid)
         and (${before ?? null}::bigint is null or a.id < ${before ?? null}::bigint)
       order by a.id desc
       limit ${PAGE_SIZE + 1}
    `)) as unknown as Row[];

    // The tables this organization has actually touched, for the filter — a
    // fixed list would offer filters that return nothing.
    const tables = (await tx.execute(sql`
      select table_name, count(*)::int as n
        from audit_log where org_id = ${org.id}::uuid
       group by table_name order by table_name
    `)) as unknown as { table_name: string; n: number }[];

    const actors = (await tx.execute(sql`
      select a.actor_id::text as id, m.email, count(*)::int as n
        from audit_log a
        left join public.org_members(${org.id}::uuid) m on m.user_id = a.actor_id
       where a.org_id = ${org.id}::uuid and a.actor_id is not null
       group by a.actor_id, m.email order by m.email nulls last
    `)) as unknown as { id: string; email: string | null; n: number }[];

    return {
      org,
      entries: [...entries],
      tables: [...tables],
      actors: [...actors],
    };
  });

  if (!data) notFound();
  const { org, actors, tables } = data;

  const hasMore = data.entries.length > PAGE_SIZE;
  const entries = data.entries.slice(0, PAGE_SIZE);
  const total = tables.reduce((n, t) => n + t.n, 0);

  const withFilters = (next: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    const merged = { table, actor, ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value) query.set(key, value);
    }
    const qs = query.toString();
    return `/orgs/${org.slug}/audit${qs ? `?${qs}` : ''}`;
  };

  return (
    <>
      <OrgShell
        slug={org.slug}
        orgName={org.name}
        email={claims.email}
        current="audit"
      />
      <main>
        <h1>Audit trail</h1>
        <p className="lede">
          Every change to this organization&apos;s data: who made it, when, what
          it was before, what it became, and the reason recorded at the time.
        </p>

        <ul className="meta">
          <li>
            <span className="k">Entries</span>
            <span className="v">{total.toLocaleString('en-GB')}</span>
          </li>
          <li>
            <span className="k">Showing</span>
            <span className="v">
              {entries.length === 0 ? 'none' : `${entries.length} most recent`}
              {table ? ` · ${TABLE_LABEL[table] ?? table}` : ''}
            </span>
          </li>
        </ul>

        {/* Filters are links, not a form: an auditor's view should be a URL
            they can cite in a report and come back to. */}
        <Panel title="Filter">
          <p className="filter-row">
            <span className="k">Table</span>
            <Link
              href={withFilters({ table: undefined, before: undefined })}
              aria-current={!table ? 'page' : undefined}
            >
              all
            </Link>
            {tables.map((t) => (
              <Link
                key={t.table_name}
                href={withFilters({ table: t.table_name, before: undefined })}
                aria-current={table === t.table_name ? 'page' : undefined}
              >
                {TABLE_LABEL[t.table_name] ?? t.table_name} ({t.n})
              </Link>
            ))}
          </p>
          {actors.length > 1 && (
            <p className="filter-row" style={{ marginBottom: 0 }}>
              <span className="k">Who</span>
              <Link
                href={withFilters({ actor: undefined, before: undefined })}
                aria-current={!actor ? 'page' : undefined}
              >
                anyone
              </Link>
              {actors.map((a) => (
                <Link
                  key={a.id}
                  href={withFilters({ actor: a.id, before: undefined })}
                  aria-current={actor === a.id ? 'page' : undefined}
                >
                  {a.email ?? 'former member'} ({a.n})
                </Link>
              ))}
            </p>
          )}
        </Panel>

        {entries.length === 0 ? (
          <p className="empty">
            No entries match. The trail records changes to this
            organization&apos;s own data — reference classifications and other
            system-wide data are audited separately.
          </p>
        ) : (
          <Panel scroll>
            <table className="audit">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Change</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const changes = changedFields(entry.old_data, entry.new_data);
                  return (
                    <tr key={entry.id}>
                      <td className="mono muted">
                        {new Date(entry.occurred_at)
                          .toISOString()
                          .replace('T', ' ')
                          .slice(0, 19)}
                      </td>
                      <td className="mono">
                        {entry.actor_email ??
                          (entry.actor_id ? 'former member' : 'system')}
                      </td>
                      <td>
                        <span className={ACTION_TONE[entry.action]}>
                          {entry.action.toLowerCase()}
                        </span>{' '}
                        {TABLE_LABEL[entry.table_name] ?? entry.table_name}
                        <br />
                        <span className="muted">
                          {describeRow(entry.table_name, entry.new_data ?? entry.old_data)}
                        </span>
                      </td>
                      <td>
                        {changes.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <ul className="changes">
                            {changes.map((change) => (
                              <li key={change.field}>
                                <span className="mono">{change.field}</span>{' '}
                                <span className="muted">{change.from}</span>
                                {' → '}
                                <span className="strong">{change.to}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>{entry.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        )}

        {hasMore && (
          <p>
            <Link
              className="backlink"
              href={withFilters({ before: entries[entries.length - 1].id })}
            >
              Older entries →
            </Link>
          </p>
        )}

        <div className="callout is-note">
          <p className="callout-title">What this trail can and cannot be</p>
          <p className="muted">
            It is append-only in the database, not by convention: a trigger
            rejects any update or delete of an entry, including from a
            privileged role. Every audited write must carry a reason — a write
            without one is refused rather than recorded blank.
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            It records the change, not the intent behind it. A reason of
            &ldquo;correcting a keying error&rdquo; is a claim by the person who
            made the change, and the trail preserves that claim faithfully
            without vouching for it. Published figures are protected separately:
            a frozen vintage cannot be altered at all.
          </p>
        </div>
      </main>
    </>
  );
}
