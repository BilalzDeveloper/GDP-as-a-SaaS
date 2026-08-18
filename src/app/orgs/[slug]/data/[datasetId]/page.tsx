import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { applyMapping, commitStaged } from '../actions';

export const dynamic = 'force-dynamic';

type Issue = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  source_row_number: number | null;
  n: number;
};

export default async function DatasetPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; datasetId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');
  const { slug, datasetId } = await params;
  const { error } = await searchParams;

  const data = await withRls(claims, {}, async (tx) => {
    const orgs = (await tx.execute(
      sql`select id, name, slug from organization where slug = ${slug}`,
    )) as unknown as { id: string; name: string; slug: string }[];
    if (orgs.length === 0) return null;

    const datasets = (await tx.execute(sql`
      select id, name, original_filename, sha256, byte_size, row_count, status,
             header, sheet_name, provenance
        from source_dataset where id = ${datasetId}::uuid
    `)) as unknown as {
      id: string; name: string; original_filename: string; sha256: string;
      byte_size: number; row_count: number | null; status: string;
      header: string[] | null; sheet_name: string | null;
      provenance: Record<string, string>;
    }[];
    if (datasets.length === 0) return null;

    const issues = (await tx.execute(sql`
      select vi.severity, vi.code, min(vi.message) as message,
             min(sr.source_row_number) as source_row_number, count(*)::int as n
        from validation_issue vi
        left join staging_row sr on sr.id = vi.staging_row_id
       where vi.dataset_id = ${datasetId}::uuid
       group by vi.severity, vi.code
       order by case vi.severity when 'error' then 0 when 'warning' then 1 else 2 end,
                count(*) desc
    `)) as unknown as Issue[];

    const staged = (await tx.execute(sql`
      select count(*)::int as total,
             count(*) filter (where is_valid)::int as valid
        from staging_row where dataset_id = ${datasetId}::uuid
    `)) as unknown as { total: number; valid: number }[];

    const committed = (await tx.execute(sql`
      select count(*)::int as n from observation
       where source_dataset_id = ${datasetId}::uuid
    `)) as unknown as { n: number }[];

    const versions = (await tx.execute(sql`
      select v.id, c.code, v.version_label
        from classification_version v
        join classification c on c.id = v.classification_id
       where c.kind = 'activity'
       order by (c.owner_org_id is not null), c.code
    `)) as unknown as { id: string; code: string; version_label: string }[];

    const units = (await tx.execute(
      sql`select code, name from unit order by code`,
    )) as unknown as { code: string; name: string }[];

    return {
      org: orgs[0],
      dataset: datasets[0],
      issues: [...issues],
      staged: staged[0],
      committed: committed[0].n,
      versions: [...versions],
      units: [...units],
    };
  });

  if (!data) notFound();
  const { org, dataset, issues, staged, committed, versions, units } = data;
  const header = dataset.header ?? [];
  const errorCount = issues.filter((i) => i.severity === 'error').reduce((s, i) => s + i.n, 0);

  return (
    <main>
      <p>
        <Link href={`/orgs/${org.slug}/data`}>← Source data</Link>
      </p>
      <h1>{dataset.name}</h1>
      <p className="muted">
        {dataset.original_filename} · {dataset.row_count ?? 0} rows ·{' '}
        {(dataset.byte_size / 1024).toFixed(1)} KB
        {dataset.sheet_name && <> · sheet {dataset.sheet_name}</>}
        <br />
        SHA-256 {dataset.sha256.slice(0, 16)}…
        {dataset.provenance?.note && <> · {dataset.provenance.note}</>}
      </p>
      {error && <p className="error">{error}</p>}

      <h2>Map the columns</h2>
      <form className="stack" action={applyMapping}>
        <input type="hidden" name="slug" value={org.slug} />
        <input type="hidden" name="datasetId" value={dataset.id} />
        {(
          [
            ['col_value', 'Value', true],
            ['col_periodLabel', 'Reference period', true],
            ['col_transactionCode', 'SNA transaction code', false],
            ['col_activityCode', 'Activity code', false],
            ['col_sectorCode', 'Institutional sector code', false],
            ['col_unitCode', 'Unit (per row, optional)', false],
          ] as const
        ).map(([name, label, required]) => (
          <label key={name}>
            {label}
            {required && ' *'}
            <select name={name} defaultValue="" required={required}>
              <option value="">— not mapped —</option>
              {header.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          …or one transaction code for every row
          <input name="const_transactionCode" placeholder="e.g. P.1" />
        </label>
        <label>
          Activity classification version
          <select name="activityVersionId" defaultValue="">
            <option value="">— none —</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.code} {v.version_label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Unit for the whole file
          <select name="unitCode" defaultValue="NC_MN">
            {units.map((u) => (
              <option key={u.code} value={u.code}>
                {u.code} — {u.name}
              </option>
            ))}
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
          Valuation
          <select name="valuation" defaultValue="">
            <option value="">— not stated —</option>
            <option value="basic">basic prices</option>
            <option value="producers">producers&apos; prices</option>
            <option value="purchasers">purchasers&apos; prices</option>
          </select>
        </label>
        <label>
          Decimal separator
          <select name="decimalSeparator" defaultValue="">
            <option value="">— infer, and flag anything ambiguous —</option>
            <option value=".">. (1234.56)</option>
            <option value=",">, (1234,56)</option>
          </select>
        </label>
        <label>
          Save this mapping as
          <input name="mappingName" placeholder="e.g. ABS annual extract" />
        </label>
        <button type="submit">Apply mapping and validate</button>
      </form>

      <h2>Validation</h2>
      {staged.total === 0 ? (
        <p className="muted">Nothing staged yet — apply a mapping above.</p>
      ) : (
        <>
          <p>
            {staged.valid} of {staged.total} rows are ready to commit.
            {errorCount > 0 && (
              <>
                {' '}
                <span className="error">{errorCount} error(s) block the commit.</span>
              </>
            )}
          </p>
          {issues.length > 0 && (
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Finding</th>
                    <th>Count</th>
                    <th>First row</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((i) => (
                    <tr key={`${i.severity}-${i.code}`}>
                      <td className={i.severity === 'error' ? 'error' : undefined}>
                        {i.severity}
                      </td>
                      <td>
                        <strong>{i.code}</strong>
                        <br />
                        <span className="muted">{i.message}</span>
                      </td>
                      <td>{i.n}</td>
                      <td>{i.source_row_number ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">
            Errors block the commit. Warnings do not — several of them are
            legitimately possible, and a compiler who has checked should not be
            stopped by the tool.
          </p>
        </>
      )}

      <h2>Commit</h2>
      {committed > 0 && (
        <p>
          {committed} observation(s) committed from this dataset. Re-committing
          updates them in place while the vintage is open.
        </p>
      )}
      <form className="stack" action={commitStaged}>
        <input type="hidden" name="slug" value={org.slug} />
        <input type="hidden" name="datasetId" value={dataset.id} />
        <label>
          Vintage
          <input name="vintageName" placeholder="e.g. 2024 first estimate" required />
        </label>
        <button type="submit" disabled={staged.total === 0 || errorCount > 0}>
          Commit staged rows
        </button>
      </form>
      <p className="muted">
        Committing writes observations into an open vintage. Once a vintage is
        frozen its observations become immutable — revisions go into a new
        vintage, so a published figure stays reproducible.
      </p>
    </main>
  );
}
