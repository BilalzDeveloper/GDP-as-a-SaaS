import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { OrgShell, Panel } from '@/components/shell';
import { createPeriods, uploadDataset } from './actions';

export const dynamic = 'force-dynamic';

type DatasetRow = {
  id: string;
  name: string;
  original_filename: string;
  byte_size: number;
  row_count: number | null;
  status: string;
  uploaded_at: string;
  error_count: number;
};

const STATUS: Record<string, { label: string; tone: string }> = {
  uploaded: { label: 'Uploaded', tone: 'pill' },
  parsed: { label: 'Needs mapping', tone: 'pill is-warning' },
  mapped: { label: 'Mapped', tone: 'pill' },
  validated: { label: 'Validated', tone: 'pill is-accent' },
  committed: { label: 'Committed', tone: 'pill is-positive' },
  discarded: { label: 'Discarded', tone: 'pill' },
};

const MONTH_NAME = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default async function DataPage({
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
    const orgs = (await tx.execute(sql`
      select id, name, slug, fiscal_year_start_month
        from organization where slug = ${slug}
    `)) as unknown as {
      id: string;
      name: string;
      slug: string;
      fiscal_year_start_month: number;
    }[];
    if (orgs.length === 0) return null;
    const datasets = (await tx.execute(sql`
      select d.id, d.name, d.original_filename, d.byte_size, d.row_count,
             d.status, d.uploaded_at,
             (select count(*)::int from validation_issue vi
               where vi.dataset_id = d.id and vi.severity = 'error') as error_count
        from source_dataset d
       where d.org_id = ${orgs[0].id}
       order by d.uploaded_at desc
    `)) as unknown as DatasetRow[];
    const periods = (await tx.execute(sql`
      select fiscal_year,
             count(*) filter (where frequency = 'annual')::int as annual,
             count(*) filter (where frequency = 'quarterly')::int as quarterly,
             min(start_date)::text as starts,
             max(end_date)::text as ends
        from reference_period
       where org_id = ${orgs[0].id}
       group by fiscal_year
       order by fiscal_year desc
    `)) as unknown as {
      fiscal_year: number;
      annual: number;
      quarterly: number;
      starts: string;
      ends: string;
    }[];
    return {
      org: orgs[0],
      datasets: [...datasets],
      periods: [...periods],
      periodCount: periods.reduce((n, p) => n + p.annual + p.quarterly, 0),
    };
  });

  if (!data) notFound();

  return (
    <>
      <OrgShell
        slug={data.org.slug}
        orgName={data.org.name}
        email={claims.email}
        current="data"
      />
      <main>
        <h1>Source data</h1>
        <p className="lede">
          Uploaded surveys, administrative records and statistical extracts.
          Each file is stored with its checksum, so a committed figure always
          traces back to the exact bytes it came from.
        </p>

        {error && (
          <div className="callout is-critical">
            <p className="error" style={{ margin: 0 }}>
              {error}
            </p>
          </div>
        )}

        {data.periodCount === 0 && (
          <div className="callout is-warning">
            <p className="callout-title">No reference periods defined</p>
            <p className="muted" style={{ margin: 0 }}>
              No uploaded row will resolve to a period until they exist. Define
              at least one year below before uploading — periods carry the
              fiscal-year convention, which differs by country, so they belong
              to the organization rather than to the system.
            </p>
          </div>
        )}

        <h2>Reference periods</h2>
        <p className="muted">
          This organization&apos;s fiscal year starts in{' '}
          <strong>{MONTH_NAME[data.org.fiscal_year_start_month - 1]}</strong>, so
          a year runs from the first of that month and its quarters are counted
          from there.
        </p>
        {data.periods.length > 0 && (
          <Panel scroll>
            <table>
              <thead>
                <tr>
                  <th>Fiscal year</th>
                  <th>Covers</th>
                  <th className="num">Annual</th>
                  <th className="num">Quarters</th>
                </tr>
              </thead>
              <tbody>
                {data.periods.map((p) => (
                  <tr key={p.fiscal_year}>
                    <td className="mono">{p.fiscal_year}</td>
                    <td className="mono muted">
                      {p.starts} → {p.ends}
                    </td>
                    <td className="num">{p.annual}</td>
                    <td className="num">{p.quarterly}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        <form className="stack" action={createPeriods}>
          <input type="hidden" name="slug" value={data.org.slug} />
          <label>
            Fiscal year
            <input
              name="fiscalYear"
              type="number"
              min={1900}
              max={2200}
              step={1}
              required
              placeholder="2024"
            />
          </label>
          <label>
            Define
            <select name="cover" defaultValue="both">
              <option value="both">the year and its four quarters</option>
              <option value="annual">the annual period only</option>
              <option value="quarterly">the four quarters only</option>
            </select>
          </label>
          <button type="submit">Define periods</button>
        </form>
        <p className="muted">
          Defining a year that already exists adds only what is missing.
        </p>

        <h2>Datasets</h2>
        {data.datasets.length === 0 ? (
          <p className="empty">Nothing uploaded yet.</p>
        ) : (
          <Panel scroll>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Rows</th>
                  <th>Status</th>
                  <th>Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {data.datasets.map((d) => {
                  const status = STATUS[d.status] ?? {
                    label: d.status,
                    tone: 'pill',
                  };
                  return (
                    <tr key={d.id}>
                      <td>
                        <Link href={`/orgs/${data.org.slug}/data/${d.id}`}>
                          {d.name}
                        </Link>
                        <br />
                        <span className="muted mono">{d.original_filename}</span>
                      </td>
                      <td className="num">{d.row_count ?? '—'}</td>
                      <td>
                        <span className={status.tone}>{status.label}</span>
                        {d.error_count > 0 && (
                          <>
                            {' '}
                            <span className="pill is-critical">
                              {d.error_count} error
                              {d.error_count === 1 ? '' : 's'}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="mono muted">
                        {new Date(d.uploaded_at).toISOString().slice(0, 10)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        )}

        <h2>Upload a file</h2>
        <form className="stack" action={uploadDataset} encType="multipart/form-data">
          <input type="hidden" name="slug" value={data.org.slug} />
          <label>
            File — .csv or .xlsx, up to 10 MB
            <input
              type="file"
              name="file"
              accept=".csv,.tsv,.txt,.xlsx,.xlsm"
              required
            />
          </label>
          <label>
            Name
            <input name="name" placeholder="Annual business survey 2024" />
          </label>
          <label>
            Provenance — where this came from
            <input name="provenance" placeholder="ABS extract, run 2026-03-14" />
          </label>
          <button type="submit">Upload</button>
        </form>
      </main>
    </>
  );
}
