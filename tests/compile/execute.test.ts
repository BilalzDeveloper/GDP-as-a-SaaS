// Compilation against a real database: the whole path from an uploaded file
// to a compiled GDP figure, the reproducibility guarantee, the drill-down
// back to source records, and isolation for the new tables.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withRls, closeDb, type RlsClaims } from '../../src/db/rls';
import { admin, claimsFor, createOrg, createTestUser, dbMessage } from '../rls/helpers';
import { parseCsvFile } from '../../src/intake/parse';
import { stageAndValidate, commitDataset } from '../../src/intake/service';
import { executeRun, ExecutionError } from '../../src/compile/execute';
import type { MappingDefinition } from '../../src/intake/types';

const run = Date.now().toString(36);

let alice: RlsClaims;
let bob: RlsClaims;
let orgA: { id: string };
let orgB: { id: string };
let activityVersionId: string;
let vintageId: string;
let runId: string;

// A consistent little economy: production and income both give GDP = 2950.
//   Σ GVA = 300 + 800 + 250 = 1350 ... plus taxes 320 − subsidies 70
// Production GDP = 1600; income D.1 800 + B.2g 350 + B.3g 100 + D.2 420 − D.3 70 = 1600.
const CSV = [
  'txn,isic,year,value',
  'P.1,A,2023,500',
  'P.2,A,2023,200',
  'P.1,C,2023,2000',
  'P.2,C,2023,1200',
  'P.1,F,2023,700',
  'P.2,F,2023,450',
  'D.21,,2023,320',
  'D.31,,2023,70',
  'D.1,,2023,800',
  'B.2g,,2023,350',
  'B.3g,,2023,100',
  'D.2,,2023,420',
  'D.3,,2023,70',
].join('\n');

function mapping(versionId: string): MappingDefinition {
  return {
    columns: {
      value: { source: 'value' },
      periodLabel: { source: 'year' },
      transactionCode: { source: 'txn' },
      activityCode: { source: 'isic' },
    },
    activityVersionId: versionId,
    unitCode: 'NC_MN',
    priceBasis: 'current',
    valuation: 'basic',
    frequency: 'annual',
  };
}

beforeAll(async () => {
  alice = claimsFor(await createTestUser(`cp-alice-${run}@a.test`), 'alice');
  bob = claimsFor(await createTestUser(`cp-bob-${run}@b.test`), 'bob');
  orgA = await createOrg(alice, 'Compile NSO A', `cp-a-${run}`);
  orgB = await createOrg(bob, 'Compile NSO B', `cp-b-${run}`);

  const [isic] = await admin`
    select v.id from classification_version v
      join classification c on c.id = v.classification_id
     where c.code = 'ISIC4' and c.owner_org_id is null`;
  activityVersionId = isic.id;

  await withRls(alice, { reason: 'test: periods' }, (tx) =>
    tx.execute(sql`
      insert into reference_period (org_id, frequency, start_date, end_date, label, fiscal_year)
      values (${orgA.id}::uuid, 'annual', '2023-01-01', '2023-12-31', '2023', 2023)
    `),
  );

  const datasetId = await withRls(alice, { reason: 'test: upload' }, async (tx) => {
    const parsed = parseCsvFile(CSV);
    const rows = (await tx.execute(sql`
      insert into source_dataset (
        org_id, name, original_filename, content_type, byte_size, sha256,
        status, header, row_count
      ) values (
        ${orgA.id}::uuid, 'accounts', 'accounts.csv', 'text/csv',
        ${CSV.length}, ${'c'.repeat(64)}, 'parsed',
        ${JSON.stringify(parsed.header)}::jsonb, ${parsed.rows.length}
      ) returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });

  const validation = await stageAndValidate(
    alice, orgA.id, datasetId, parseCsvFile(CSV), mapping(activityVersionId),
  );
  expect(validation.errorCount).toBe(0);

  vintageId = await withRls(alice, { reason: 'test: vintage' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into data_vintage (org_id, name) values (${orgA.id}::uuid, 'first estimate')
      returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
  await commitDataset(alice, orgA.id, datasetId, vintageId, mapping(activityVersionId));

  runId = await withRls(alice, { reason: 'test: run' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into compilation_run (org_id, name, frequency, input_vintage_id, anchor_approach)
      values (${orgA.id}::uuid, '2023 first release', 'annual', ${vintageId}::uuid, 'production')
      returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
});

afterAll(async () => {
  await closeDb();
  await admin.end();
});

async function resultValue(approach: string, measure: string, activity?: string | null) {
  const rows = (await withRls(alice, {}, (tx) =>
    tx.execute(sql`
      select value from compilation_result
       where run_id = ${runId}::uuid and approach = ${approach}::compilation_approach
         and measure = ${measure}
         and activity_item_id is not distinct from ${activity ?? null}::uuid
    `),
  )) as unknown as { value: string }[];
  return rows.length ? Number(rows[0].value) : null;
}

describe('executing a run', () => {
  it('compiles the periods the vintage covers', async () => {
    const summary = await executeRun(alice, orgA.id, runId);
    expect(summary.periodsCompiled).toBe(1);
    expect(summary.resultsWritten).toBeGreaterThan(0);
  });

  it('produces the expected GDP by the production approach', async () => {
    // Σ GVA 1350 + taxes 320 − subsidies 70 = 1600
    expect(await resultValue('production', 'total_gross_value_added')).toBe(1350);
    expect(await resultValue('production', 'gdp')).toBe(1600);
  });

  it('produces the same GDP by the income approach', async () => {
    // 800 + 350 + 100 + 420 − 70 = 1600
    expect(await resultValue('income', 'gdp')).toBe(1600);
  });

  it('reports a zero discrepancy when the accounts agree', async () => {
    expect(await resultValue('summary', 'statistical_discrepancy_income')).toBe(0);
    expect(await resultValue('summary', 'headline_gdp')).toBe(1600);
  });

  it('stores value added for every industry', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select ci.code, cr.value from compilation_result cr
          join classification_item ci on ci.id = cr.activity_item_id
         where cr.run_id = ${runId}::uuid and cr.measure = 'gross_value_added'
         order by ci.code
      `),
    )) as unknown as { code: string; value: string }[];
    expect([...rows].map((r) => [r.code, Number(r.value)])).toEqual([
      ['A', 300], ['C', 800], ['F', 250],
    ]);
  });

  it('withholds the expenditure approach and says why', async () => {
    // The file has no expenditure components at all, so nothing is reported
    // for it — and no partial total is invented.
    expect(await resultValue('expenditure', 'gdp')).toBeNull();
  });

  it('marks the run computed and pins the method version', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select r.status, r.executed_at, mv.engine_semver, mv.config
          from compilation_run r
          join method_version mv on mv.id = r.method_version_id
         where r.id = ${runId}::uuid
      `),
    )) as unknown as {
      status: string; executed_at: string;
      engine_semver: string; config: Record<string, unknown>;
    }[];
    expect(rows[0].status).toBe('computed');
    expect(rows[0].engine_semver).toMatch(/^\d+\.\d+\.\d+$/);
    expect(rows[0].config.anchor).toBe('production');
  });

  it('fails cleanly when the vintage holds nothing', async () => {
    const emptyRun = await withRls(alice, { reason: 'test: empty run' }, async (tx) => {
      const v = (await tx.execute(sql`
        insert into data_vintage (org_id, name) values (${orgA.id}::uuid, 'empty')
        returning id
      `)) as unknown as { id: string }[];
      const r = (await tx.execute(sql`
        insert into compilation_run (org_id, name, frequency, input_vintage_id)
        values (${orgA.id}::uuid, 'empty run', 'annual', ${v[0].id}::uuid)
        returning id
      `)) as unknown as { id: string }[];
      return r[0].id;
    });
    await expect(executeRun(alice, orgA.id, emptyRun)).rejects.toThrow(ExecutionError);

    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`select status, error_message from compilation_run where id = ${emptyRun}::uuid`),
    )) as unknown as { status: string; error_message: string }[];
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toContain('no observations');
  });
});

describe('reproducibility (non-negotiable 1)', () => {
  it('re-executing the same run over the same vintage gives identical figures', async () => {
    const before = await resultValue('production', 'gdp');
    await executeRun(alice, orgA.id, runId);
    expect(await resultValue('production', 'gdp')).toBe(before);
  });

  it('re-executing replaces results rather than accumulating them', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select count(*)::int as n from compilation_result
         where run_id = ${runId}::uuid and measure = 'gdp' and approach = 'production'
      `),
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBe(1);
  });

  it('a second run over the same frozen vintage reproduces the figure', async () => {
    await withRls(alice, { reason: 'test: freeze' }, (tx) =>
      tx.execute(sql`update data_vintage set frozen_at = now() where id = ${vintageId}::uuid`),
    );
    const secondRunId = await withRls(alice, { reason: 'test: second run' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into compilation_run (org_id, name, frequency, input_vintage_id, anchor_approach)
        values (${orgA.id}::uuid, 'reproduction', 'annual', ${vintageId}::uuid, 'production')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });
    await executeRun(alice, orgA.id, secondRunId);

    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select value from compilation_result
         where run_id = ${secondRunId}::uuid and approach = 'production'
           and measure = 'gdp' and activity_item_id is null
      `),
    )) as unknown as { value: string }[];
    expect(Number(rows[0].value)).toBe(1600);
  });

  it('method versions cannot be altered after a run pins one', async () => {
    await expect(
      admin`update method_version set engine_semver = '9.9.9'`,
    ).rejects.toThrow(/immutable/);
  });
});

describe('drill-down to source records', () => {
  it('walks from an industry aggregate back to the uploaded rows', async () => {
    const [item] = await admin`
      select id from classification_item
       where version_id = ${activityVersionId} and code = 'A'`;

    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select ts.transaction_code, o.value, sr.source_row_number, sr.raw,
               d.original_filename, d.sha256
          from observation o
          join time_series ts on ts.id = o.series_id
          join reference_period p on p.id = o.period_id
          join staging_row sr on sr.id = o.staging_row_id
          join source_dataset d on d.id = o.source_dataset_id
         where o.vintage_id = ${vintageId}::uuid
           and ts.activity_item_id = ${item.id}::uuid and p.label = '2023'
         order by ts.transaction_code
      `),
    )) as unknown as {
      transaction_code: string; value: string; source_row_number: number;
      raw: Record<string, string>; original_filename: string; sha256: string;
    }[];

    const found = [...rows];
    expect(found.map((r) => r.transaction_code)).toEqual(['P.1', 'P.2']);
    // Value added of 300 for industry A traces to exactly these two rows.
    expect(Number(found[0].value) - Number(found[1].value)).toBe(300);
    expect(found[0].source_row_number).toBe(2);
    expect(found[0].raw.isic).toBe('A');
    expect(found[0].original_filename).toBe('accounts.csv');
  });
});

describe('provenance, as recorded by the run', () => {
  // The pure definition is tested in provenance.test.ts. What matters here is
  // that the record is written, stays attached to the right figure, points
  // only inside the run's own vintage, and survives a re-execution — a run
  // pins its method version, so its provenance has to be as fixed as its
  // figures (migration 0011).
  const sourceCodes = async (measure: string) => {
    const rows = await admin`
      select ts.transaction_code
        from result_source rs
        join compilation_result cr on cr.id = rs.result_id
        join observation o on o.id = rs.observation_id
        join time_series ts on ts.id = o.series_id
       where cr.run_id = ${runId} and cr.measure = ${measure}
         and cr.activity_item_id is null
       order by ts.transaction_code`;
    return rows.map((r) => r.transaction_code as string);
  };

  it('records the rows behind a total-economy figure', async () => {
    expect(await sourceCodes('taxes_on_products')).toEqual(['D.21']);
    expect(await sourceCodes('total_factor_incomes')).toEqual(['B.2g', 'B.3g', 'D.1']);
  });

  it("attaches each industry's rows to that industry's figure and no other", async () => {
    const [mismatched] = await admin`
      select count(*)::int as n
        from result_source rs
        join compilation_result cr on cr.id = rs.result_id
        join observation o on o.id = rs.observation_id
        join time_series ts on ts.id = o.series_id
       where cr.run_id = ${runId} and cr.measure = 'gross_value_added'
         and ts.activity_item_id is distinct from cr.activity_item_id`;
    expect(mismatched.n).toBe(0);

    const [counted] = await admin`
      select count(*)::int as n
        from result_source rs
        join compilation_result cr on cr.id = rs.result_id
       where cr.run_id = ${runId} and cr.measure = 'gross_value_added'`;
    // Three industries, output and intermediate consumption for each.
    expect(counted.n).toBe(6);
  });

  it('records nothing for a figure derived from other figures', async () => {
    const [derived] = await admin`
      select count(*)::int as n
        from result_source rs
        join compilation_result cr on cr.id = rs.result_id
       where cr.run_id = ${runId}
         and cr.measure in ('gdp_per_capita', 'gdp_growth_percent')`;
    expect(derived.n).toBe(0);
  });

  it('points only at observations in the vintage the run read', async () => {
    // Provenance reaching outside the pinned vintage would break
    // reproducibility more quietly than a wrong figure would.
    const [stray] = await admin`
      select count(*)::int as n
        from result_source rs
        join compilation_result cr on cr.id = rs.result_id
        join observation o on o.id = rs.observation_id
        join compilation_run r on r.id = cr.run_id
       where cr.run_id = ${runId}
         and o.vintage_id is distinct from r.input_vintage_id`;
    expect(stray.n).toBe(0);
  });

  it('replaces rather than accumulates on re-execution', async () => {
    const count = async () => {
      const [r] = await admin`
        select count(*)::int as n
          from result_source rs
          join compilation_result cr on cr.id = rs.result_id
         where cr.run_id = ${runId}`;
      return r.n as number;
    };
    const before = await count();
    expect(before).toBeGreaterThan(0);
    await executeRun(alice, orgA.id, runId);
    expect(await count()).toBe(before);
  });
});

describe('tenant isolation for compilation tables', () => {
  const tables = [
    'compilation_run', 'compilation_run_source', 'compilation_result',
    'compilation_diagnostic', 'result_source',
  ];

  it.each(tables)("%s hides another tenant's rows", async (table) => {
    const rows = (await withRls(bob, {}, (tx) =>
      tx.execute(sql.raw(`select count(*)::int as n from ${table} where org_id = '${orgA.id}'`)),
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  it("another tenant cannot execute org A's run", async () => {
    await expect(executeRun(bob, orgB.id, runId)).rejects.toThrow(ExecutionError);
  });

  it("another tenant cannot fabricate results in org A's run", async () => {
    // Two routes, both of which must fail. Via a subquery, RLS filters org A's
    // periods away so nothing is selected to insert — the statement succeeds
    // having written nothing, which is the correct outcome, so the assertion
    // is on the absence of the row rather than on an exception.
    await withRls(bob, { reason: 'attack: fake results via subquery' }, (tx) =>
      tx.execute(sql`
        insert into compilation_result (org_id, run_id, period_id, approach, measure, value)
        select ${orgA.id}::uuid, ${runId}::uuid, id, 'production', 'gdp', 999999
          from reference_period limit 1
      `),
    );

    // With an explicit period id, the write policy itself refuses.
    const [period] = await admin`
      select id from reference_period where org_id = ${orgA.id} limit 1`;
    await expect(
      withRls(bob, { reason: 'attack: fake results directly' }, (tx) =>
        tx.execute(sql`
          insert into compilation_result (org_id, run_id, period_id, approach, measure, value)
          values (${orgA.id}::uuid, ${runId}::uuid, ${period.id}::uuid,
                  'production', 'gdp', 999999)
        `),
      ),
    ).rejects.toSatisfy((e: unknown) => /row-level security/.test(dbMessage(e)));

    // Neither route left anything behind.
    const [check] = await admin`
      select count(*)::int as n from compilation_result
       where run_id = ${runId} and value = 999999`;
    expect(check.n).toBe(0);
  });
});
