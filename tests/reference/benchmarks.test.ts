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
    expect(covered.size).toBeGreaterThanOrEqual(25);
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
      select verified, note from benchmark_source where code = 'indicative-2023'`;
    expect(source.verified).toBe(false);
    expect(source.note).toMatch(/NOT OFFICIAL DATA/);
    expect(source.note).toMatch(/load-benchmarks/);
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
