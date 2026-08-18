import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { uploadDataset } from './actions';

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

const STATUS_LABEL: Record<string, string> = {
  uploaded: 'Uploaded',
  parsed: 'Parsed — needs mapping',
  mapped: 'Mapped',
  validated: 'Validated',
  committed: 'Committed',
  discarded: 'Discarded',
};

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
    const orgs = (await tx.execute(
      sql`select id, name, slug from organization where slug = ${slug}`,
    )) as unknown as { id: string; name: string; slug: string }[];
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
      select count(*)::int as n from reference_period where org_id = ${orgs[0].id}
    `)) as unknown as { n: number }[];
    return { org: orgs[0], datasets: [...datasets], periodCount: periods[0].n };
  });

  if (!data) notFound();

  return (
    <main>
      <p>
        <Link href={`/orgs/${data.org.slug}`}>← {data.org.name}</Link>
      </p>
      <h1>Source data</h1>
      {error && <p className="error">{error}</p>}

      {data.periodCount === 0 && (
        <div className="card">
          <p className="muted">
            This organization has no reference periods defined yet, so no row
            will resolve to a period. Periods carry the fiscal-year convention,
            which differs by country — they are created per organization.
          </p>
        </div>
      )}

      <h2>Upload a file</h2>
      <form className="stack" action={uploadDataset} encType="multipart/form-data">
        <input type="hidden" name="slug" value={data.org.slug} />
        <label>
          File (.csv or .xlsx, up to 10 MB)
          <input type="file" name="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm" required />
        </label>
        <label>
          Name
          <input name="name" placeholder="e.g. Annual business survey 2024" />
        </label>
        <label>
          Provenance — where this came from
          <input name="provenance" placeholder="e.g. ABS extract, run 2026-03-14" />
        </label>
        <button type="submit">Upload</button>
      </form>
      <p className="muted">
        The file is stored with a SHA-256 checksum, so a committed figure can
        always be traced back to the exact bytes it came from.
      </p>

      <h2>Datasets</h2>
      {data.datasets.length === 0 ? (
        <p className="muted">Nothing uploaded yet.</p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Rows</th>
                <th>Status</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {data.datasets.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/orgs/${data.org.slug}/data/${d.id}`}>{d.name}</Link>
                    <br />
                    <span className="muted">{d.original_filename}</span>
                  </td>
                  <td>{d.row_count ?? '—'}</td>
                  <td>
                    {STATUS_LABEL[d.status] ?? d.status}
                    {d.error_count > 0 && (
                      <>
                        <br />
                        <span className="error">{d.error_count} error(s)</span>
                      </>
                    )}
                  </td>
                  <td>{new Date(d.uploaded_at).toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
