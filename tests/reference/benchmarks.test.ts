// The international benchmark figures.
//
// Two things matter more than the numbers themselves: that the set is
// internally coherent (every country resolves, every unit exists, GDP and
// population come in pairs), and that it is honestly labelled. The seeded set
// is a transcription and must say so until someone loads the official file.
import { describe, expect, it } from 'vitest';
import { admin } from '../rls/helpers';
import { GCC } from '../../src/insights/benchmarks';

describe('benchmark reference data', () => {
  it('covers the largest economies and every GCC state', async () => {
    const rows = await admin`
      select distinct country_iso3 from benchmark_observation`;
    const covered = new Set(rows.map((r) => r.country_iso3 as string));
    for (const iso3 of GCC) {
      expect(covered.has(iso3), `${iso3} is missing`).toBe(true);
    }
    for (const iso3 of ['USA', 'CHN', 'DEU', 'JPN', 'IND', 'GBR']) {
      expect(covered.has(iso3), `${iso3} is missing`).toBe(true);
    }
    expect(covered.size).toBeGreaterThanOrEqual(30);
  });

  it('pairs every GDP figure with a population figure', async () => {
    // Per capita is derived from the two, so a GDP row without its population
    // would show a blank column rather than a wrong number — but it would
    // still be a hole in the data, and this is where it shows up.
    const [unpaired] = await admin`
      select count(*)::int as n
        from benchmark_observation g
       where g.indicator = 'gdp_current_usd'
         and not exists (
           select 1 from benchmark_observation p
            where p.source_code = g.source_code
              and p.country_iso3 = g.country_iso3
              and p.indicator = 'population'
              and p.period_label = g.period_label)`;
    expect(unpaired.n).toBe(0);
  });

  it('resolves every country and unit against the reference tables', async () => {
    // Foreign keys enforce this, so a failure here means the seed loaded
    // against a database that has since lost rows.
    const [orphans] = await admin`
      select count(*)::int as n
        from benchmark_observation o
        left join country c on c.iso3 = o.country_iso3
        left join unit u on u.code = o.unit_code
       where c.iso3 is null or u.code is null`;
    expect(orphans.n).toBe(0);
  });

  it('states positive figures only', async () => {
    const [bad] = await admin`
      select count(*)::int as n from benchmark_observation where value <= 0`;
    expect(bad.n).toBe(0);
  });

  it('labels the transcribed set as unverified, and says why in the note', async () => {
    // The honesty requirement, as a test. If someone flips this flag without
    // loading the official file, this fails.
    const [source] = await admin`
      select verified, note from benchmark_source where code = 'indicative'`;
    expect(source.verified).toBe(false);
    expect(source.note).toMatch(/NOT OFFICIAL DATA/);
    expect(source.note).toMatch(/load-benchmarks/);
  });

  it('holds a series, not a snapshot', async () => {
    // Growth is derived from adjacent periods, so a single year would leave
    // every growth column empty rather than wrong — which is harder to notice.
    const periods = await admin`
      select distinct period_label from benchmark_observation order by period_label`;
    expect(periods.map((p) => p.period_label)).toEqual(['2021', '2022', '2023']);

    const [gaps] = await admin`
      select count(*)::int as n from (
        select country_iso3, count(*)::int as years
          from benchmark_observation
         where indicator = 'gdp_current_usd'
         group by country_iso3
        having count(*) <> 3) short`;
    expect(gaps.n).toBe(0);
  });

  it('pairs oil with non-oil for every GCC state and period', async () => {
    // A share computed from one of the two would be silently wrong.
    for (const iso3 of GCC) {
      const rows = await admin`
        select indicator, count(*)::int as n
          from benchmark_observation
         where country_iso3 = ${iso3}
           and indicator in ('oil_gva_usd', 'non_oil_gva_usd')
         group by indicator`;
      expect(rows.length, `${iso3} is missing an oil indicator`).toBe(2);
      for (const r of rows) expect(r.n).toBe(3);
    }
  });

  it('keeps the oil split below GDP, where value added belongs', async () => {
    // Oil and non-oil are value added at basic prices; GDP at market prices
    // also carries taxes less subsidies on products, so their sum must sit
    // below it. A pair that exceeded GDP would mean the two are not what the
    // column comment says they are.
    const rows = await admin`
      select g.country_iso3, g.period_label,
             g.value as gdp, (o.value + n.value) as gva
        from benchmark_observation g
        join benchmark_observation o
          on o.country_iso3 = g.country_iso3 and o.period_label = g.period_label
         and o.indicator = 'oil_gva_usd'
        join benchmark_observation n
          on n.country_iso3 = g.country_iso3 and n.period_label = g.period_label
         and n.indicator = 'non_oil_gva_usd'
       where g.indicator = 'gdp_current_usd'`;
    expect(rows.length).toBe(GCC.length * 3);
    for (const r of rows) {
      expect(
        Number(r.gva),
        `${r.country_iso3} ${r.period_label}: GVA exceeds GDP`,
      ).toBeLessThan(Number(r.gdp));
    }
  });

  it('only carries the oil split for the GCC', async () => {
    // No other economy in the set publishes it here, and inventing one would
    // be a figure with no source at all.
    const rows = await admin`
      select distinct country_iso3 from benchmark_observation
       where indicator in ('oil_gva_usd', 'non_oil_gva_usd')`;
    expect(rows.map((r) => r.country_iso3).sort()).toEqual([...GCC].sort());
  });

  it('keeps the figures in the order of magnitude they claim', async () => {
    // Not a check of accuracy — nothing here can check that — but a check
    // that a decimal point has not moved: the largest economy is tens of
    // trillions, the smallest GCC state tens of billions, both in US$ millions.
    const [largest] = await admin`
      select value from benchmark_observation
       where indicator = 'gdp_current_usd' order by value desc limit 1`;
    expect(Number(largest.value)).toBeGreaterThan(10_000_000);
    expect(Number(largest.value)).toBeLessThan(100_000_000);

    const [smallest] = await admin`
      select value from benchmark_observation
       where indicator = 'gdp_current_usd' order by value asc limit 1`;
    expect(Number(smallest.value)).toBeGreaterThan(1_000);
  });
});
