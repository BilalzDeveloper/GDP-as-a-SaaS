#!/usr/bin/env node
// Replace the indicative benchmark figures with the official ones.
//
// The seeded set in `seeds/benchmarks.csv` was entered by hand so the insights
// pages have something to show. It is close to the published series and is not
// the published series, and the application says so on every page that uses
// it. This script is how that stops being true.
//
//   DATABASE_URL=... node scripts/load-benchmarks.mjs [--year 2023]
//
// It reads two World Bank indicators over their public API —
//   NY.GDP.MKTP.CD   GDP at current US dollars
//   SP.POP.TOTL      total population
// — writes them under the source `worldbank`, and marks that source verified,
// because unlike the transcription it came from the publisher. The indicative
// source is left in place but is no longer preferred: the pages read the
// verified source when one exists.
//
// Needs outbound network access, which the environment this was written in did
// not have. Run it once where there is some. See DECISIONS.md D51.
import postgres from 'postgres';

const API = 'https://api.worldbank.org/v2';
const INDICATORS = {
  'NY.GDP.MKTP.CD': { indicator: 'gdp_current_usd', unit: 'USD_MN', scale: 1e-6 },
  'SP.POP.TOTL': { indicator: 'population', unit: 'PERSONS_TH', scale: 1e-3 },
};

const yearArg = process.argv.indexOf('--year');
const YEAR = yearArg === -1 ? '2023' : process.argv[yearArg + 1];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

/** Every page of one indicator for one year, for all countries. */
async function fetchIndicator(code) {
  const rows = [];
  for (let page = 1; ; page++) {
    const url = `${API}/country/all/indicator/${code}?date=${YEAR}&format=json&per_page=500&page=${page}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${code} page ${page}: HTTP ${response.status}`);
    }
    const body = await response.json();
    const [meta, data] = body;
    if (!Array.isArray(data)) throw new Error(`${code}: unexpected response shape`);
    rows.push(...data);
    if (page >= (meta?.pages ?? 1)) break;
  }
  return rows;
}

try {
  // Only countries this installation knows about: the API returns aggregates
  // ("World", "Euro area") alongside countries, and an aggregate filed as a
  // country would sit at the top of every ranking.
  const known = new Set(
    (await sql`select iso3 from country`).map((r) => r.iso3),
  );

  await sql`
    insert into benchmark_source (code, name, url, retrieved_at, verified, note)
    values ('worldbank', 'World Bank World Development Indicators',
            'https://data.worldbank.org', current_date, true,
            ${`Retrieved from the World Bank API for ${YEAR}: NY.GDP.MKTP.CD (GDP, current US$) and SP.POP.TOTL (population, total). Loaded by scripts/load-benchmarks.mjs.`})
    on conflict (code) do update
      set retrieved_at = current_date, verified = true, note = excluded.note`;

  let written = 0;
  let skipped = 0;
  for (const [code, spec] of Object.entries(INDICATORS)) {
    const rows = await fetchIndicator(code);
    for (const row of rows) {
      const iso3 = row?.countryiso3code;
      // A null value is a genuine gap in the source, not a zero.
      if (!iso3 || !known.has(iso3) || row.value === null) {
        skipped++;
        continue;
      }
      await sql`
        insert into benchmark_observation
          (source_code, country_iso3, indicator, period_label, value, unit_code)
        values ('worldbank', ${iso3}, ${spec.indicator}, ${String(row.date)},
                ${Number(row.value) * spec.scale}, ${spec.unit})
        on conflict (source_code, country_iso3, indicator, period_label)
          do update set value = excluded.value, unit_code = excluded.unit_code`;
      written++;
    }
    console.log(`  ${code}: ${rows.length} rows returned`);
  }
  console.log(`wrote ${written} observations, skipped ${skipped} (aggregates and gaps)`);
  console.log('The insights pages now read the verified source.');
} finally {
  await sql.end();
}
