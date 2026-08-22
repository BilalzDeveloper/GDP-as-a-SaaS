import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { IdentityBar, Panel } from '@/components/shell';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { withRls } from '@/db/rls';
import { loadBenchmarks } from '@/insights/benchmarks';

export const dynamic = 'force-dynamic';

const usd = (millions: number) =>
  millions >= 1_000_000
    ? `${(millions / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 2 })} tn`
    : `${(millions / 1_000).toLocaleString('en-GB', { maximumFractionDigits: 0 })} bn`;

/**
 * One economy, with the reader's own published compilations beside it.
 *
 * The comparison is the point of the page, and it is also where the honesty
 * has to be loudest: a compiled figure in national currency and a benchmark in
 * US dollars are not comparable without an exchange rate this application does
 * not hold, so it shows them side by side and says plainly that it has not
 * converted anything.
 */
export default async function CountryInsightsPage({
  params,
}: {
  params: Promise<{ iso3: string }>;
}) {
  const { iso3 } = await params;
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');

  const data = await loadBenchmarks(claims);
  const country = data?.rows.find((r) => r.iso3 === iso3.toUpperCase());
  if (!data || !country) notFound();

  const rank = data.rows.findIndex((r) => r.iso3 === country.iso3) + 1;

  // The reader's own published runs, whatever organization they are in. RLS
  // does the filtering: a run belonging to another tenant cannot appear here
  // however this query is written.
  const published = await withRls(claims, {}, async (tx) =>
    [
      ...((await tx.execute(sql`
        select o.name as org_name, o.slug, r.id, r.name, p.label as period_label,
               cr.value, r.published_at
          from compilation_result cr
          join compilation_run r on r.id = cr.run_id
          join organization o on o.id = r.org_id
          join reference_period p on p.id = cr.period_id
         where cr.measure = 'headline_gdp'
           and cr.price_basis = 'current'
           and r.published_at is not null
         order by p.start_date desc, r.published_at desc
         limit 10
      `)) as unknown as {
        org_name: string; slug: string; id: string; name: string;
        period_label: string; value: string | null; published_at: string;
      }[]),
    ],
  );

  return (
    <>
      <IdentityBar email={claims.email} />
      <main>
        <a className="backlink" href="/insights">
          ← Insights
        </a>
        <h1>{country.name}</h1>

        {!data.source.verified && (
          <div className="callout is-warning">
            <p className="callout-title">Indicative figures</p>
            <p style={{ marginBottom: 0 }}>
              The benchmark below was entered by hand and is not the published
              series. Load the official figures before using it for anything.
            </p>
          </div>
        )}

        <div className="hero">
          <p className="hero-figure">{usd(country.gdp)}</p>
          <p className="hero-label">
            Nominal GDP, {country.periodLabel} · {rank}
            {rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'} of{' '}
            {data.rows.length} economies held here
          </p>
        </div>

        <ul className="meta">
          <li>
            <span className="k">Per head</span>
            <span className="v">
              {country.perCapita === null
                ? '—'
                : `US$ ${country.perCapita.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`}
            </span>
          </li>
          <li>
            <span className="k">Population</span>
            <span className="v">
              {country.population === null
                ? '—'
                : `${(country.population / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 1 })} m`}
            </span>
          </li>
          <li>
            <span className="k">Source</span>
            <span className="v">{data.source.name}</span>
          </li>
        </ul>

        <h2>Your published compilations</h2>
        {published.length === 0 ? (
          <p className="empty">
            No run of yours has been published yet. Once one is, it appears here
            beside the benchmark.
          </p>
        ) : (
          <>
            <Panel scroll>
              <table>
                <thead>
                  <tr>
                    <th>Organization</th>
                    <th>Run</th>
                    <th>Period</th>
                    <th className="num">Headline GDP</th>
                  </tr>
                </thead>
                <tbody>
                  {published.map((r) => (
                    <tr key={`${r.id}-${r.period_label}`}>
                      <td>{r.org_name}</td>
                      <td>
                        <Link href={`/orgs/${r.slug}/runs/${r.id}`}>{r.name}</Link>
                      </td>
                      <td className="mono">{r.period_label}</td>
                      <td className="num strong">
                        {r.value === null
                          ? '—'
                          : Number(r.value).toLocaleString('en-GB', {
                              maximumFractionDigits: 2,
                            })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <div className="callout is-note">
              <p className="callout-title">These two columns are not comparable</p>
              <p style={{ marginBottom: 0 }}>
                Your headline is in the currency and scale your compilation was
                made in; the benchmark is in millions of US dollars. Converting
                one to the other needs an exchange rate for the period, which
                this application does not hold and will not guess. Read them as
                two facts about the same economy, not as a difference.
              </p>
            </div>
          </>
        )}

        <p>
          <Link href="/insights">All economies</Link>
        </p>
      </main>
    </>
  );
}
