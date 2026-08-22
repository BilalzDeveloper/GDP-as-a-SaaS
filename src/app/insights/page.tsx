import Link from 'next/link';
import { redirect } from 'next/navigation';
import { IdentityBar, Panel } from '@/components/shell';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { gccRows, loadBenchmarks, type BenchmarkRow } from '@/insights/benchmarks';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Insights — SNA Compilation Platform',
  description:
    'Published GDP figures for the largest economies and the GCC, for context beside your own compilation.',
};

const usd = (millions: number) =>
  millions >= 1_000_000
    ? `${(millions / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 2 })} tn`
    : `${(millions / 1_000).toLocaleString('en-GB', { maximumFractionDigits: 0 })} bn`;

const perHead = (v: number | null) =>
  v === null
    ? '—'
    : v.toLocaleString('en-GB', { maximumFractionDigits: 0 });

const people = (v: number | null) =>
  v === null ? '—' : `${(v / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 1 })} m`;

/**
 * A ranked table with the magnitude drawn in the row.
 *
 * One measure across many named entities is a bar chart's job, and a ranked
 * horizontal bar is its form. Drawing it inside the table rather than beside
 * it means the figures and the shape are the same object: there is no chart
 * that can disagree with its table, and no table view to go and find.
 *
 * One hue — the skin's accent — because the bars encode magnitude, not
 * identity. The numbers stay in text tokens; a value written in the data
 * colour is the commonest way a chart becomes unreadable.
 */
function Ranking({
  rows,
  caption,
}: {
  rows: readonly BenchmarkRow[];
  caption: string;
}) {
  const max = Math.max(...rows.map((r) => r.gdp), 1);
  return (
    <Panel title={caption} scroll>
      <table className="ranking">
        <thead>
          <tr>
            <th>Economy</th>
            <th className="num">GDP (US$)</th>
            <th className="bar-col">Relative size</th>
            <th className="num">Per head (US$)</th>
            <th className="num">Population</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.iso3}>
              <td>
                <Link href={`/insights/${r.iso3}`}>
                  <span className="mono">{r.iso3}</span> {r.name}
                </Link>
              </td>
              <td className="num strong">{usd(r.gdp)}</td>
              <td className="bar-col">
                {/* title, so the exact figure is available on hover without a
                    scripted tooltip — the value is already in the row. */}
                <span
                  className="bar"
                  style={{ width: `${(r.gdp / max) * 100}%` }}
                  title={`${r.name}: ${usd(r.gdp)}`}
                />
              </td>
              <td className="num">{perHead(r.perCapita)}</td>
              <td className="num">{people(r.population)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export default async function InsightsPage() {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');

  const data = await loadBenchmarks(claims);

  return (
    <>
      <IdentityBar email={claims.email} />
      <main>
        <h1>Insights</h1>
        <p className="lede">
          Published GDP for the largest economies and the Gulf Cooperation
          Council, so a compilation can be read beside the figures the world
          already has.
        </p>

        {!data ? (
          <p className="empty">
            No benchmark figures are loaded. Run{' '}
            <span className="mono">scripts/load-benchmarks.mjs</span> to fetch
            them.
          </p>
        ) : (
          <>
            {!data.source.verified && (
              <div className="callout is-warning">
                <p className="callout-title">
                  These figures are indicative, not official
                </p>
                <p>
                  They were entered by hand so these pages have something to
                  show, and they are close to the published series without
                  being it. Do not quote them, cite them, or carry them into an
                  analysis that leaves this application.
                </p>
                <p style={{ marginBottom: 0 }}>
                  Running{' '}
                  <span className="mono">scripts/load-benchmarks.mjs</span>{' '}
                  replaces them with the World Bank series and removes this
                  notice.
                </p>
              </div>
            )}

            {(() => {
              const gcc = gccRows(data.rows);
              const gccTotal = gcc.reduce((sum, r) => sum + r.gdp, 0);
              const gccPeople = gcc.reduce((sum, r) => sum + (r.population ?? 0), 0);
              return (
                <>
                  <h2>The Gulf Cooperation Council</h2>
                  {/* The one number these two pages lead with. */}
                  <div className="hero">
                    <p className="hero-figure">{usd(gccTotal)}</p>
                    <p className="hero-label">
                      Combined GDP of the six GCC states, {data.periodLabel} ·
                      US${' '}
                      {perHead(gccPeople === 0 ? null : (gccTotal * 1e6) / gccPeople)}{' '}
                      per head across {people(gccPeople)} people
                    </p>
                  </div>
                  <Ranking
                    rows={gcc}
                    caption={`GCC member states · ${data.periodLabel}`}
                  />
                  <p className="muted">
                    Ranked within the group. Bahrain and Qatar are small
                    economies with very high output per head, which is the
                    figure a comparison by total GDP hides — the reason both
                    columns are here.
                  </p>
                </>
              );
            })()}

            <h2>The largest economies</h2>
            <Ranking
              rows={data.rows.slice(0, 20)}
              caption={`Ranked by nominal GDP · ${data.periodLabel}`}
            />
            <p className="muted">
              Nominal GDP converted at market exchange rates, which is what
              makes it comparable across countries and also what makes it move
              when a currency does. It is not the same ranking as GDP at
              purchasing power parity, and neither is wrong.
            </p>

            <h2>Where these figures come from</h2>
            <ul className="meta">
              <li>
                <span className="k">Source</span>
                <span className="v">
                  {data.source.url ? (
                    <a href={data.source.url}>{data.source.name}</a>
                  ) : (
                    data.source.name
                  )}
                </span>
              </li>
              <li>
                <span className="k">Verified</span>
                <span className="v">{data.source.verified ? 'yes' : 'no'}</span>
              </li>
              {data.source.retrievedAt && (
                <li>
                  <span className="k">Retrieved</span>
                  <span className="v mono">
                    {String(data.source.retrievedAt).slice(0, 10)}
                  </span>
                </li>
              )}
            </ul>
            <p className="muted">{data.source.note}</p>
          </>
        )}

        <p>
          <Link href="/orgs">Back to your organizations</Link>
        </p>
      </main>
    </>
  );
}
