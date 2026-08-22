// Reading the international benchmark figures.
//
// Two derived facts the pages need and the table deliberately does not store:
// GDP per capita, and which source is in force. Per capita is computed from
// the two stored indicators so the three can never disagree; the source is
// resolved here so every page agrees about which figures it is showing and how
// much they can be trusted.
import { sql } from 'drizzle-orm';
import { withRls, type RlsClaims } from '@/db/rls';

/** The six member states of the Gulf Cooperation Council. */
export const GCC = ['SAU', 'ARE', 'QAT', 'KWT', 'OMN', 'BHR'] as const;

export interface BenchmarkRow {
  iso3: string;
  name: string;
  /** Nominal GDP in millions of US dollars. */
  gdp: number;
  /** Mid-year population, in people. */
  population: number | null;
  /** GDP per head, in US dollars. Null where population is unknown. */
  perCapita: number | null;
  periodLabel: string;
  /**
   * Every period held for this country, oldest first — the series behind the
   * headline figure. Growth is derived from it rather than stored, so a rate
   * can never disagree with the levels it came from.
   */
  series: { periodLabel: string; gdp: number }[];
  /** Change against the previous period, per cent. Null for the first one. */
  growthPercent: number | null;
  /**
   * Value added at BASIC prices, split between the petroleum sector and the
   * rest of the economy, where the source carries it. These two sum to gross
   * value added and not to GDP: taxes less subsidies on products sit between.
   */
  oil: { oilGva: number; nonOilGva: number; oilShare: number } | null;
}

export interface BenchmarkSource {
  code: string;
  name: string;
  url: string | null;
  retrievedAt: string | null;
  verified: boolean;
  note: string;
}

export interface Benchmarks {
  source: BenchmarkSource;
  /** Descending by GDP, which is the order every page wants. */
  rows: BenchmarkRow[];
  periodLabel: string;
}

/**
 * The benchmark set in force, and the figures it holds.
 *
 * A verified source wins over an unverified one: once someone has run
 * `scripts/load-benchmarks.mjs` the pages must stop showing the transcription.
 * Where neither exists the caller gets null and shows an empty state rather
 * than an empty table.
 */
export async function loadBenchmarks(
  claims: RlsClaims,
): Promise<Benchmarks | null> {
  return withRls(claims, {}, async (tx) => {
    const sources = (await tx.execute(sql`
      select code, name, url, retrieved_at, verified, note
        from benchmark_source
       where exists (select 1 from benchmark_observation o
                      where o.source_code = benchmark_source.code)
       order by verified desc, code
       limit 1
    `)) as unknown as {
      code: string; name: string; url: string | null;
      retrieved_at: string | null; verified: boolean; note: string;
    }[];
    if (sources.length === 0) return null;
    const source = sources[0];

    // The most recent period the chosen source covers. Mixing periods in one
    // ranking would compare a 2023 figure with a 2019 one and show neither as
    // out of date.
    const periods = (await tx.execute(sql`
      select period_label from benchmark_observation
       where source_code = ${source.code}
       order by period_label desc limit 1
    `)) as unknown as { period_label: string }[];
    if (periods.length === 0) return null;
    const periodLabel = periods[0].period_label;

    const rows = (await tx.execute(sql`
      select c.iso3, c.name,
             g.value as gdp,
             p.value as population,
             pu.multiplier as population_multiplier,
             oil.value as oil_gva,
             nonoil.value as non_oil_gva
        from benchmark_observation g
        join country c on c.iso3 = g.country_iso3
        left join benchmark_observation p
               on p.source_code = g.source_code
              and p.country_iso3 = g.country_iso3
              and p.indicator = 'population'
              and p.period_label = g.period_label
        left join unit pu on pu.code = p.unit_code
        left join benchmark_observation oil
               on oil.source_code = g.source_code
              and oil.country_iso3 = g.country_iso3
              and oil.indicator = 'oil_gva_usd'
              and oil.period_label = g.period_label
        left join benchmark_observation nonoil
               on nonoil.source_code = g.source_code
              and nonoil.country_iso3 = g.country_iso3
              and nonoil.indicator = 'non_oil_gva_usd'
              and nonoil.period_label = g.period_label
       where g.source_code = ${source.code}
         and g.indicator = 'gdp_current_usd'
         and g.period_label = ${periodLabel}
       order by g.value desc
    `)) as unknown as {
      iso3: string; name: string; gdp: string;
      population: string | null; population_multiplier: string | null;
      oil_gva: string | null; non_oil_gva: string | null;
    }[];

    // The whole series, in one query rather than one per country.
    const history = (await tx.execute(sql`
      select country_iso3, period_label, value
        from benchmark_observation
       where source_code = ${source.code} and indicator = 'gdp_current_usd'
       order by country_iso3, period_label
    `)) as unknown as {
      country_iso3: string; period_label: string; value: string;
    }[];
    const seriesByCountry = new Map<string, { periodLabel: string; gdp: number }[]>();
    for (const h of history) {
      const existing = seriesByCountry.get(h.country_iso3) ?? [];
      existing.push({ periodLabel: h.period_label, gdp: Number(h.value) });
      seriesByCountry.set(h.country_iso3, existing);
    }

    return {
      source: {
        code: source.code,
        name: source.name,
        url: source.url,
        retrievedAt: source.retrieved_at,
        verified: source.verified,
        note: source.note,
      },
      periodLabel,
      rows: [...rows].map((r) => {
        const gdp = Number(r.gdp);
        // Population is stored in whatever unit the source used — thousands
        // for the transcription, people for the World Bank loader — so the
        // multiplier is applied rather than assumed.
        const population =
          r.population === null
            ? null
            : Number(r.population) * Number(r.population_multiplier ?? 1);
        const series = seriesByCountry.get(r.iso3) ?? [];
        const previous = series[series.length - 2];
        const oilGva = r.oil_gva === null ? null : Number(r.oil_gva);
        const nonOilGva = r.non_oil_gva === null ? null : Number(r.non_oil_gva);
        return {
          iso3: r.iso3,
          name: r.name,
          gdp,
          population,
          // GDP is in millions of dollars; per capita is in dollars.
          perCapita:
            population === null || population === 0
              ? null
              : (gdp * 1_000_000) / population,
          periodLabel: periodLabel,
          series,
          growthPercent:
            previous && previous.gdp !== 0
              ? ((gdp - previous.gdp) / previous.gdp) * 100
              : null,
          oil:
            oilGva === null || nonOilGva === null || oilGva + nonOilGva === 0
              ? null
              : {
                  oilGva,
                  nonOilGva,
                  oilShare: (oilGva / (oilGva + nonOilGva)) * 100,
                },
        };
      }),
    };
  });
}

/** The GCC member states, in the order the ranking put them. */
export function gccRows(rows: readonly BenchmarkRow[]): BenchmarkRow[] {
  return rows.filter((r) => (GCC as readonly string[]).includes(r.iso3));
}
