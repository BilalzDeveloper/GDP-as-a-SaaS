// Per-capita GDP and growth rates, against a real database.
//
// The engine's arithmetic is trivial — a division and a percentage change —
// and already covered. What is worth testing is everything around it: that
// population reaches the calculation from the run's own vintage, that the
// unit's multiplier is applied (a figure filed in thousands divided into GDP
// unconverted overstates GDP per head a thousandfold, and would look
// plausible), and that a memorandum item never leaks into an aggregate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withRls, closeDb, type RlsClaims } from '../../src/db/rls';
import { admin, claimsFor, createOrg, createTestUser } from '../rls/helpers';
import { parseCsvFile } from '../../src/intake/parse';
import { stageAndValidate, commitDataset } from '../../src/intake/service';
import { executeRun } from '../../src/compile/execute';
import type { MappingDefinition } from '../../src/intake/types';

const suffix = Date.now().toString(36);

let alice: RlsClaims;
let orgA: { id: string };
let activityVersionId: string;

// Two years of a consistent little economy, plus a population figure filed in
// THOUSANDS of people — the case the multiplier exists for.
//
//   2023  Σ GVA 1350 + taxes 320 − subsidies 70 = 1600
//   2024  Σ GVA 1485 + taxes 350 − subsidies 75 = 1760
//
// Population 8,000 thousand = 8,000,000 people. GDP is 1600 MILLIONS of
// national currency = 1,600,000,000 units, so GDP per head is 200 units — the
// figure an office publishes. Compiling it in millions per head would give
// 0.0002, which numeric(20,6) rounds away to almost nothing.
const CSV = [
  'txn,isic,period,value',
  'P.1,A,2023,500', 'P.2,A,2023,200',
  'P.1,C,2023,2000', 'P.2,C,2023,1200',
  'P.1,F,2023,700', 'P.2,F,2023,450',
  'D.21,,2023,320', 'D.31,,2023,70',
  'P.1,A,2024,540', 'P.2,A,2024,210',
  'P.1,C,2024,2150', 'P.2,C,2024,1260',
  'P.1,F,2024,750', 'P.2,F,2024,485',
  'D.21,,2024,350', 'D.31,,2024,75',
].join('\n');

const POPULATION_CSV = [
  'txn,isic,period,value',
  'POP,,2023,8000',
  'POP,,2024,8100',
].join('\n');

function mapping(unitCode: string): MappingDefinition {
  return {
    columns: {
      value: { source: 'value' },
      periodLabel: { source: 'period' },
      transactionCode: { source: 'txn' },
      activityCode: { source: 'isic' },
    },
    activityVersionId,
    unitCode,
    priceBasis: 'current',
    valuation: 'basic',
    frequency: 'annual',
  };
}

async function loadInto(
  vintageId: string,
  name: string,
  csv: string,
  unitCode: string,
): Promise<void> {
  const parsed = parseCsvFile(csv);
  const datasetId = await withRls(alice, { reason: 'test: upload' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into source_dataset (
        org_id, name, original_filename, content_type, byte_size, sha256,
        status, header, row_count
      ) values (
        ${orgA.id}::uuid, ${name}, ${name + '.csv'}, 'text/csv',
        ${csv.length}, ${name.padEnd(64, '0').slice(0, 64)}, 'parsed',
        ${JSON.stringify(parsed.header)}::jsonb, ${parsed.rows.length}
      ) returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
  const map = mapping(unitCode);
  const validation = await stageAndValidate(alice, orgA.id, datasetId, parsed, map);
  expect(validation.errorCount, `${name} staged with errors`).toBe(0);
  await commitDataset(alice, orgA.id, datasetId, vintageId, map);
}

let runId: string;
let vintageId: string;

beforeAll(async () => {
  alice = claimsFor(await createTestUser(`pc-alice-${suffix}@a.test`), 'alice');
  orgA = await createOrg(alice, 'Per-capita NSO', `pc-${suffix}`);

  const [isic] = await admin`
    select v.id from classification_version v
      join classification c on c.id = v.classification_id
     where c.code = 'ISIC4' and c.owner_org_id is null`;
  activityVersionId = isic.id;

  await withRls(alice, { reason: 'test: periods' }, async (tx) => {
    for (const year of [2023, 2024]) {
      await tx.execute(sql`
        insert into reference_period
          (org_id, frequency, start_date, end_date, label, fiscal_year)
        values (${orgA.id}::uuid, 'annual', ${`${year}-01-01`}::date,
                ${`${year}-12-31`}::date, ${String(year)}, ${year})
      `);
    }
  });

  vintageId = await withRls(alice, { reason: 'test: vintage' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into data_vintage (org_id, name) values (${orgA.id}::uuid, ${'v-' + suffix})
      returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });

  await loadInto(vintageId, `accounts-${suffix}`, CSV, 'NC_MN');
  await loadInto(vintageId, `population-${suffix}`, POPULATION_CSV, 'PERSONS_TH');

  runId = await withRls(alice, { reason: 'test: run' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into compilation_run
        (org_id, name, frequency, input_vintage_id, anchor_approach)
      values (${orgA.id}::uuid, ${'run ' + suffix}, 'annual', ${vintageId}::uuid,
              'production')
      returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
});

afterAll(async () => {
  await closeDb();
  await admin.end();
});

async function measure(label: string, name: string): Promise<number | null> {
  const rows = (await withRls(alice, {}, (tx) =>
    tx.execute(sql`
      select cr.value from compilation_result cr
        join reference_period p on p.id = cr.period_id
       where cr.run_id = ${runId}::uuid and cr.measure = ${name}
         and p.label = ${label} and cr.benchmarked = false
    `),
  )) as unknown as { value: string | null }[];
  return rows.length && rows[0].value !== null ? Number(rows[0].value) : null;
}

describe('per-capita GDP and growth', () => {
  it('executes and reports what it derived', async () => {
    const summary = await executeRun(alice, orgA.id, runId);
    expect(summary.periodsCompiled).toBe(2);
    expect(summary.derived.perCapitaPeriods).toBe(2);
    expect(summary.derived.growthPeriods).toBe(1);
  });

  it('compiles the headline GDP the fixture describes', async () => {
    expect(await measure('2023', 'headline_gdp')).toBe(1600);
    expect(await measure('2024', 'headline_gdp')).toBe(1760);
  });

  it('applies the unit multiplier to the population figure', async () => {
    // Filed as 8000 in PERSONS_TH. Storing 8000 and dividing by it would give
    // a per-capita figure a thousand times too large, and it would look
    // entirely plausible on the page.
    expect(await measure('2023', 'population')).toBe(8_000_000);
    expect(await measure('2024', 'population')).toBe(8_100_000);
  });

  it('publishes per-capita GDP in units of the currency, not in millions', async () => {
    // 1600 millions ÷ 8,000,000 people = 200 units per head.
    expect(await measure('2023', 'gdp_per_capita')).toBeCloseTo(200, 6);
    // 1760 millions ÷ 8,100,000 = 217.283951 units per head.
    expect(await measure('2024', 'gdp_per_capita')).toBeCloseTo(
      (1760 * 1_000_000) / 8_100_000,
      5,
    );
  });

  it('refuses to compute per capita when the vintage mixes currency scales', async () => {
    // Adding millions to thousands is wrong before anything is divided, so
    // this is a warning about the aggregates, not just about per capita.
    const mixed = await withRls(alice, { reason: 'test: mixed scales' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into data_vintage (org_id, name)
        values (${orgA.id}::uuid, ${'mixed-' + suffix}) returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });
    await loadInto(mixed, `accounts-mixed-${suffix}`, CSV, 'NC_MN');
    await loadInto(mixed, `pop-mixed-${suffix}`, POPULATION_CSV, 'PERSONS_TH');
    // A second currency scale in the same vintage.
    await loadInto(
      mixed,
      `extra-mixed-${suffix}`,
      ['txn,isic,period,value', 'D.2,,2023,420'].join('\n'),
      'NC_TH',
    );

    const mixedRun = await withRls(alice, { reason: 'test: mixed run' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into compilation_run
          (org_id, name, frequency, input_vintage_id, anchor_approach)
        values (${orgA.id}::uuid, ${'mixed run ' + suffix}, 'annual',
                ${mixed}::uuid, 'production')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });

    const summary = await executeRun(alice, orgA.id, mixedRun);
    expect(summary.derived.perCapitaPeriods).toBe(0);

    const diagnostics = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select code, severity, message from compilation_diagnostic
         where run_id = ${mixedRun}::uuid and code = 'mixed_currency_units'
      `),
    )) as unknown as { code: string; severity: string; message: string }[];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('NC_MN');
    expect(diagnostics[0].message).toContain('NC_TH');
  });

  it('computes growth against the previous period', async () => {
    // 1600 → 1760 is 10%.
    expect(await measure('2023', 'gdp_growth_percent')).toBeNull();
    expect(await measure('2024', 'gdp_growth_percent')).toBeCloseTo(10, 10);
  });

  it('writes no year-on-year rate on an annual run', async () => {
    // At annual frequency it would be the same number as period-on-period,
    // and two names for one figure is how a publication contradicts itself.
    expect(await measure('2024', 'gdp_growth_yoy_percent')).toBeNull();
  });

  it('keeps the memorandum item out of every aggregate', async () => {
    // POP is 8000 in the same vintage as the accounts. If the assembler had
    // swept it into a bucket, GDP would not be 1600 — this is the assertion
    // that catches that, and the reason `transaction_code.kind` exists.
    expect(await measure('2023', 'headline_gdp')).toBe(1600);
    expect(await measure('2023', 'total_gross_value_added')).toBe(1350);

    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select count(*)::int as n from compilation_result
         where run_id = ${runId}::uuid and measure = 'population'
           and approach <> 'summary'::compilation_approach
      `),
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  it('reproduces the derived figures on re-execution', async () => {
    const before = await measure('2024', 'gdp_per_capita');
    await executeRun(alice, orgA.id, runId);
    expect(await measure('2024', 'gdp_per_capita')).toBe(before);
  });
});

describe('a run whose vintage has no population', () => {
  it('says so rather than showing nothing', async () => {
    const bare = await withRls(alice, { reason: 'test: bare vintage' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into data_vintage (org_id, name)
        values (${orgA.id}::uuid, ${'bare-' + suffix}) returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });
    await loadInto(bare, `accounts-bare-${suffix}`, CSV, 'NC_MN');

    const bareRun = await withRls(alice, { reason: 'test: bare run' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into compilation_run
          (org_id, name, frequency, input_vintage_id, anchor_approach)
        values (${orgA.id}::uuid, ${'bare run ' + suffix}, 'annual',
                ${bare}::uuid, 'production')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });

    const summary = await executeRun(alice, orgA.id, bareRun);
    expect(summary.derived.perCapitaPeriods).toBe(0);
    // Growth still works: it needs no population.
    expect(summary.derived.growthPeriods).toBe(1);

    const diagnostics = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select code, message from compilation_diagnostic
         where run_id = ${bareRun}::uuid and code = 'no_population'
      `),
    )) as unknown as { code: string; message: string }[];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('POP');
  });
});

describe('the reference vocabulary', () => {
  it('marks population as a memorandum item, not a transaction', async () => {
    const [row] = await admin`
      select kind, sna2008_ref from transaction_code where code = 'POP'`;
    expect(row.kind).toBe('memorandum');
    expect(row.sna2008_ref).toContain('SNA 2008');
  });

  it('leaves every SNA flow a transaction', async () => {
    // The point is not the size of the list but that nothing carrying an SNA
    // transaction code (P.*, D.*, B.*) has been quietly reclassified: those
    // are the codes the assembler sums into aggregates.
    const rows = await admin`
      select code, kind from transaction_code where kind <> 'transaction'`;
    const misfiled = rows.filter((r) => /^[PDB]\.[0-9]/.test(r.code as string));
    expect(misfiled).toEqual([]);

    // And every non-transaction is one of the two kinds that exist, each
    // introduced by a migration that explains why (D42, D45).
    for (const row of rows) {
      expect(['memorandum', 'adjustment']).toContain(row.kind);
    }
  });
});
