// Quarterly compilation benchmarked to the annual accounts, against a real
// database: the whole path from two uploaded files to a quarterly series that
// sums exactly to the published annual figures.
//
// The engine's own tests (tests/engine/benchmark.test.ts) prove the Denton
// arithmetic against closed-form answers. What is tested here is everything
// around it: that quarters are grouped into years by the fiscal year the
// organization defined rather than by parsing a label, that the constraint
// actually holds in stored data, that re-execution reproduces the figures,
// and that a compiler cannot reach another tenant's annual run to benchmark
// against.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withRls, closeDb, type RlsClaims } from '../../src/db/rls';
import { admin, claimsFor, createOrg, createTestUser, dbMessage } from '../rls/helpers';
import { parseCsvFile } from '../../src/intake/parse';
import { stageAndValidate, commitDataset } from '../../src/intake/service';
import { executeRun } from '../../src/compile/execute';
import type { MappingDefinition } from '../../src/intake/types';

const suffix = Date.now().toString(36);

/** Run something expected to be refused, and return the message it was refused with. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (e) {
    return dbMessage(e);
  }
  throw new Error('expected the database to refuse this, but it succeeded');
}

let alice: RlsClaims;
let bob: RlsClaims;
let orgA: { id: string };
let orgB: { id: string };
let activityVersionId: string;
let annualRunId: string;
let quarterlyRunId: string;

// The annual accounts: better sources, so these are what the quarters must
// come back to.
//   2023  GVA A 320 + GVA C 830 + taxes 330 − subsidies 70 = 1410
//   2024  GVA A 350 + GVA C 900 + taxes 350 − subsidies 75 = 1525
const ANNUAL_CSV = [
  'txn,isic,period,value',
  'P.1,A,2023,520', 'P.2,A,2023,200',
  'P.1,C,2023,2080', 'P.2,C,2023,1250',
  'D.21,,2023,330', 'D.31,,2023,70',
  'P.1,A,2024,560', 'P.2,A,2024,210',
  'P.1,C,2024,2200', 'P.2,C,2024,1300',
  'D.21,,2024,350', 'D.31,,2024,75',
].join('\n');

/**
 * The quarterly indicator. Deliberately does NOT add up to the annual
 * accounts — that is the situation benchmarking exists for. It also runs a
 * year further than the annual accounts do, so the last four quarters are
 * extrapolated.
 */
const QUARTERLY_CSV = (() => {
  const rows = ['txn,isic,period,value'];
  const add = (period: string, txn: string, isic: string, value: number) =>
    rows.push(`${txn},${isic},${period},${value}`);
  // Quarterly shares that wobble, so movement is visible in the result.
  const shares = [0.24, 0.25, 0.26, 0.25];
  const annual: Record<string, Record<string, number>> = {
    '2023': { 'P.1|A': 515, 'P.2|A': 198, 'P.1|C': 2050, 'P.2|C': 1240, 'D.21|': 325, 'D.31|': 68 },
    '2024': { 'P.1|A': 548, 'P.2|A': 205, 'P.1|C': 2160, 'P.2|C': 1285, 'D.21|': 344, 'D.31|': 74 },
    '2025': { 'P.1|A': 580, 'P.2|A': 215, 'P.1|C': 2280, 'P.2|C': 1340, 'D.21|': 362, 'D.31|': 78 },
  };
  for (const [year, series] of Object.entries(annual)) {
    for (let q = 0; q < 4; q++) {
      for (const [key, total] of Object.entries(series)) {
        const [txn, isic] = key.split('|');
        // Round to two places so the stored NUMERIC(20,6) holds them exactly.
        add(`${year}-Q${q + 1}`, txn, isic, Math.round(total * shares[q] * 100) / 100);
      }
    }
  }
  return rows.join('\n');
})();

function mapping(
  versionId: string,
  frequency: 'annual' | 'quarterly',
): MappingDefinition {
  return {
    columns: {
      value: { source: 'value' },
      periodLabel: { source: 'period' },
      transactionCode: { source: 'txn' },
      activityCode: { source: 'isic' },
    },
    activityVersionId: versionId,
    unitCode: 'NC_MN',
    priceBasis: 'current',
    valuation: 'basic',
    frequency,
  };
}

/** Upload, stage, validate and commit one CSV into a fresh vintage. */
async function loadCsv(
  claims: RlsClaims,
  orgId: string,
  name: string,
  csv: string,
  frequency: 'annual' | 'quarterly',
): Promise<string> {
  const parsed = parseCsvFile(csv);
  const datasetId = await withRls(claims, { reason: 'test: upload' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into source_dataset (
        org_id, name, original_filename, content_type, byte_size, sha256,
        status, header, row_count
      ) values (
        ${orgId}::uuid, ${name}, ${name + '.csv'}, 'text/csv',
        ${csv.length}, ${name.padEnd(64, '0').slice(0, 64)}, 'parsed',
        ${JSON.stringify(parsed.header)}::jsonb, ${parsed.rows.length}
      ) returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });

  const map = mapping(activityVersionId, frequency);
  const validation = await stageAndValidate(claims, orgId, datasetId, parsed, map);
  expect(validation.errorCount, `${name} staged with errors`).toBe(0);

  const vintageId = await withRls(claims, { reason: 'test: vintage' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into data_vintage (org_id, name) values (${orgId}::uuid, ${name})
      returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
  await commitDataset(claims, orgId, datasetId, vintageId, map);
  return vintageId;
}

beforeAll(async () => {
  alice = claimsFor(await createTestUser(`qb-alice-${suffix}@a.test`), 'alice');
  bob = claimsFor(await createTestUser(`qb-bob-${suffix}@b.test`), 'bob');
  orgA = await createOrg(alice, 'Quarterly NSO A', `qb-a-${suffix}`);
  orgB = await createOrg(bob, 'Quarterly NSO B', `qb-b-${suffix}`);

  const [isic] = await admin`
    select v.id from classification_version v
      join classification c on c.id = v.classification_id
     where c.code = 'ISIC4' and c.owner_org_id is null`;
  activityVersionId = isic.id;

  // Reference periods. The fiscal_year column is what groups quarters into
  // years — set here, never inferred from the label.
  await withRls(alice, { reason: 'test: periods' }, async (tx) => {
    for (const year of [2023, 2024, 2025]) {
      await tx.execute(sql`
        insert into reference_period
          (org_id, frequency, start_date, end_date, label, fiscal_year)
        values (${orgA.id}::uuid, 'annual',
                ${`${year}-01-01`}::date, ${`${year}-12-31`}::date,
                ${String(year)}, ${year})
      `);
      const quarterEnds = ['03-31', '06-30', '09-30', '12-31'];
      const quarterStarts = ['01-01', '04-01', '07-01', '10-01'];
      for (let q = 0; q < 4; q++) {
        await tx.execute(sql`
          insert into reference_period
            (org_id, frequency, start_date, end_date, label, fiscal_year)
          values (${orgA.id}::uuid, 'quarterly',
                  ${`${year}-${quarterStarts[q]}`}::date,
                  ${`${year}-${quarterEnds[q]}`}::date,
                  ${`${year}-Q${q + 1}`}, ${year})
        `);
      }
    }
  });

  const annualVintage = await loadCsv(
    alice, orgA.id, `annual-${suffix}`, ANNUAL_CSV, 'annual',
  );
  const quarterlyVintage = await loadCsv(
    alice, orgA.id, `quarterly-${suffix}`, QUARTERLY_CSV, 'quarterly',
  );

  annualRunId = await withRls(alice, { reason: 'test: annual run' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into compilation_run
        (org_id, name, frequency, input_vintage_id, anchor_approach)
      values (${orgA.id}::uuid, ${`annual ${suffix}`}, 'annual',
              ${annualVintage}::uuid, 'production')
      returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
  await executeRun(alice, orgA.id, annualRunId);

  quarterlyRunId = await withRls(alice, { reason: 'test: quarterly run' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into compilation_run
        (org_id, name, frequency, input_vintage_id, anchor_approach,
         benchmark_source_run_id, benchmark_method)
      values (${orgA.id}::uuid, ${`quarterly ${suffix}`}, 'quarterly',
              ${quarterlyVintage}::uuid, 'production',
              ${annualRunId}::uuid, 'denton_proportional')
      returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
});

afterAll(async () => {
  await closeDb();
  await admin.end();
});

async function results(runId: string, benchmarked: boolean, measure: string) {
  const rows = (await withRls(alice, {}, (tx) =>
    tx.execute(sql`
      select p.label, cr.value, p.fiscal_year
        from compilation_result cr
        join reference_period p on p.id = cr.period_id
       where cr.run_id = ${runId}::uuid
         and cr.approach = 'summary'::compilation_approach
         and cr.measure = ${measure}
         and cr.price_basis = 'current'
         and cr.benchmarked = ${benchmarked}
       order by p.start_date
    `),
  )) as unknown as { label: string; value: string; fiscal_year: number }[];
  return [...rows].map((r) => ({
    label: r.label,
    value: Number(r.value),
    year: r.fiscal_year,
  }));
}

describe('a quarterly run benchmarked to the annual accounts', () => {
  it('executes and reports what it benchmarked', async () => {
    const summary = await executeRun(alice, orgA.id, quarterlyRunId);
    expect(summary.periodsCompiled).toBe(12);
    expect(summary.benchmarking).not.toBeNull();
    expect(summary.benchmarking!.variant).toBe('proportional');
    expect(summary.benchmarking!.seriesBenchmarked).toBeGreaterThan(0);
    // Two benchmarked years, on every series that had an annual counterpart.
    expect(summary.benchmarking!.constraintsApplied).toBeGreaterThanOrEqual(2);
  });

  it('makes the four quarters of each benchmarked year sum to the annual figure', async () => {
    // This is the property the whole milestone exists for. Checked against
    // the annual run's own stored result, not against a number typed here,
    // so the two cannot drift apart.
    const annual = await results(annualRunId, false, 'headline_gdp');
    const quarterly = await results(quarterlyRunId, true, 'headline_gdp');

    for (const { year, value: annualTotal } of annual) {
      const quarters = quarterly.filter((q) => q.year === year);
      expect(quarters, `no quarters for ${year}`).toHaveLength(4);
      const total = quarters.reduce((sum, q) => sum + q.value, 0);
      expect(Math.abs(total - annualTotal)).toBeLessThan(1e-4);
    }
  });

  it('keeps the unbenchmarked indicator alongside the benchmarked figure', async () => {
    const indicator = await results(quarterlyRunId, false, 'headline_gdp');
    const benchmarked = await results(quarterlyRunId, true, 'headline_gdp');
    expect(indicator).toHaveLength(12);
    expect(benchmarked).toHaveLength(12);
    // The indicator did not add up, which is why it needed benchmarking.
    const indicator2023 = indicator
      .filter((q) => q.year === 2023)
      .reduce((sum, q) => sum + q.value, 0);
    expect(indicator2023).not.toBeCloseTo(1410, 2);
    // And the adjustment is small — a few per cent, not a rewrite.
    for (let i = 0; i < 12; i++) {
      const ratio = benchmarked[i].value / indicator[i].value;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    }
  });

  it('preserves the shape of the indicator’s movement', async () => {
    // Benchmarking must not invent or destroy turning points: wherever the
    // indicator rose from one quarter to the next, the published series
    // should rise too.
    const indicator = await results(quarterlyRunId, false, 'headline_gdp');
    const benchmarked = await results(quarterlyRunId, true, 'headline_gdp');
    for (let i = 1; i < indicator.length; i++) {
      const indicatorRose = indicator[i].value > indicator[i - 1].value;
      const benchmarkedRose = benchmarked[i].value > benchmarked[i - 1].value;
      expect(benchmarkedRose, `direction changed at ${indicator[i].label}`).toBe(
        indicatorRose,
      );
    }
  });

  it('records every constraint it applied, with a zero residual', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select p.label, bc.measure, bc.annual_total, bc.indicator_total,
               bc.benchmarked_total, bc.residual
          from benchmark_constraint bc
          join reference_period p on p.id = bc.annual_period_id
         where bc.run_id = ${quarterlyRunId}::uuid
           and bc.measure = 'headline_gdp'
         order by p.start_date
      `),
    )) as unknown as {
      label: string; measure: string; annual_total: string;
      indicator_total: string; benchmarked_total: string; residual: string;
    }[];

    expect([...rows].map((r) => r.label)).toEqual(['2023', '2024']);
    for (const row of rows) {
      expect(Math.abs(Number(row.residual))).toBeLessThan(1e-4);
      expect(Number(row.benchmarked_total)).toBeCloseTo(Number(row.annual_total), 3);
      // The indicator total is stored precisely so the size of the
      // adjustment is recoverable from the database alone.
      expect(Number(row.indicator_total)).not.toBe(Number(row.annual_total));
    }
    expect(Number(rows[0].annual_total)).toBeCloseTo(1410, 6);
    expect(Number(rows[1].annual_total)).toBeCloseTo(1525, 6);
  });

  it('extrapolates the year the annual accounts do not reach yet, and says so', async () => {
    const benchmarked = await results(quarterlyRunId, true, 'headline_gdp');
    const indicator = await results(quarterlyRunId, false, 'headline_gdp');
    const last2024 = benchmarked.filter((q) => q.year === 2024).at(-1)!;
    const last2024Indicator = indicator.filter((q) => q.year === 2024).at(-1)!;
    const carriedRatio = last2024.value / last2024Indicator.value;

    // Every 2025 quarter carries the final adjustment forward unchanged.
    for (const q of benchmarked.filter((x) => x.year === 2025)) {
      const raw = indicator.find((x) => x.label === q.label)!;
      expect(q.value / raw.value).toBeCloseTo(carriedRatio, 8);
    }

    const diagnostics = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select code, message from compilation_diagnostic
         where run_id = ${quarterlyRunId}::uuid and code = 'benchmark_extrapolated'
      `),
    )) as unknown as { code: string; message: string }[];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('2025-Q1');
    expect(diagnostics[0].message).toContain('revised');
  });

  it('reproduces the same figures on re-execution', async () => {
    // Non-negotiable 1. Denton has no random component and no iteration, so
    // "close enough" is not the standard here — the figures must be equal.
    const before = await results(quarterlyRunId, true, 'headline_gdp');
    await executeRun(alice, orgA.id, quarterlyRunId);
    const after = await results(quarterlyRunId, true, 'headline_gdp');
    expect(after).toEqual(before);
  });

  it('pins the benchmark source and method into the method version', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select mv.config from compilation_run r
          join method_version mv on mv.id = r.method_version_id
         where r.id = ${quarterlyRunId}::uuid
      `),
    )) as unknown as { config: Record<string, unknown> }[];
    expect(rows[0].config.benchmarkMethod).toBe('denton_proportional');
    expect(rows[0].config.benchmarkSourceRunId).toBe(annualRunId);
    expect(rows[0].config.frequency).toBe('quarterly');
  });

  it('does not benchmark the statistical discrepancy', async () => {
    // A discrepancy is a residual between two estimates, not a flow with an
    // annual total of its own.
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select count(*)::int as n from compilation_result
         where run_id = ${quarterlyRunId}::uuid and benchmarked = true
           and measure like 'statistical_discrepancy%'
      `),
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });
});

describe('a quarterly run with no benchmark', () => {
  it('says plainly that its quarters may not sum to the annual accounts', async () => {
    const vintage = await loadCsv(
      alice, orgA.id, `unbenchmarked-${suffix}`, QUARTERLY_CSV, 'quarterly',
    );
    const runId = await withRls(alice, { reason: 'test: unbenchmarked' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into compilation_run
          (org_id, name, frequency, input_vintage_id, anchor_approach)
        values (${orgA.id}::uuid, ${`unbenchmarked ${suffix}`}, 'quarterly',
                ${vintage}::uuid, 'production')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });

    const summary = await executeRun(alice, orgA.id, runId);
    expect(summary.benchmarking).toBeNull();

    const diagnostics = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select code from compilation_diagnostic
         where run_id = ${runId}::uuid and code = 'not_benchmarked'
      `),
    )) as unknown as { code: string }[];
    expect(diagnostics).toHaveLength(1);

    const benchmarked = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select count(*)::int as n from compilation_result
         where run_id = ${runId}::uuid and benchmarked = true
      `),
    )) as unknown as { n: number }[];
    expect(benchmarked[0].n).toBe(0);
  });
});

describe('what the database refuses', () => {
  it('will not benchmark a run against another organization’s annual run', async () => {
    // Non-negotiable 3. RLS hides org A's run from bob's SELECTs, but a
    // foreign key is checked by the system and does not consult policies —
    // so a guessed UUID would otherwise pull org A's totals into org B's
    // results. The trigger is what stops it.
    const vintage = await withRls(bob, { reason: 'test: vintage' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into data_vintage (org_id, name) values (${orgB.id}::uuid, 'v')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });

    const message = await refusal(
      withRls(bob, { reason: 'test: cross-tenant benchmark' }, (tx) =>
        tx.execute(sql`
          insert into compilation_run
            (org_id, name, frequency, input_vintage_id, anchor_approach,
             benchmark_source_run_id)
          values (${orgB.id}::uuid, ${`stolen ${suffix}`}, 'quarterly',
                  ${vintage}::uuid, 'production', ${annualRunId}::uuid)
        `),
      ),
    );
    expect(message).toContain('does not belong to this organization');

    // And nothing of org A's leaked into org B in the attempt.
    const rows = (await withRls(bob, {}, (tx) =>
      tx.execute(sql`
        select count(*)::int as n from compilation_run
         where benchmark_source_run_id is not null
      `),
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  it('will not benchmark an annual run', async () => {
    const message = await refusal(
      withRls(alice, { reason: 'test: annual benchmark' }, (tx) =>
        tx.execute(sql`
          insert into compilation_run
            (org_id, name, frequency, input_vintage_id, anchor_approach,
             benchmark_source_run_id)
          select ${orgA.id}::uuid, ${`annual-bm ${suffix}`}, 'annual',
                 input_vintage_id, 'production', ${annualRunId}::uuid
            from compilation_run where id = ${annualRunId}::uuid
        `),
      ),
    );
    expect(message).toContain('An annual run is not benchmarked');
  });

  it('will not benchmark against a quarterly run', async () => {
    const message = await refusal(
      withRls(alice, { reason: 'test: quarterly source' }, (tx) =>
        tx.execute(sql`
          insert into compilation_run
            (org_id, name, frequency, input_vintage_id, anchor_approach,
             benchmark_source_run_id)
          select ${orgA.id}::uuid, ${`bad-source ${suffix}`}, 'quarterly',
                 input_vintage_id, 'production', ${quarterlyRunId}::uuid
            from compilation_run where id = ${quarterlyRunId}::uuid
        `),
      ),
    );
    expect(message).toContain('must be an annual run');
  });

  it('will not let a run be its own benchmark', async () => {
    // Belt and braces: a CHECK constraint forbids it outright, and the
    // trigger catches it first because a run that is its own source is by
    // definition not an annual one. Either refusal is fine — what matters is
    // that a run cannot be reconciled to itself, which would make any totals
    // trivially satisfied.
    const message = await refusal(
      withRls(alice, { reason: 'test: self benchmark' }, (tx) =>
        tx.execute(sql`
          update compilation_run set benchmark_source_run_id = id
           where id = ${quarterlyRunId}::uuid
        `),
      ),
    );
    expect(message).toMatch(/benchmark_not_self|must be an annual run/i);
  });
});

describe('tenant isolation for benchmark_constraint', () => {
  it('hides one organization’s constraints from another', async () => {
    const rows = (await withRls(bob, {}, (tx) =>
      tx.execute(sql`select count(*)::int as n from benchmark_constraint`),
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);

    const mine = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`select count(*)::int as n from benchmark_constraint`),
    )) as unknown as { n: number }[];
    expect(mine[0].n).toBeGreaterThan(0);
  });

  it('refuses a write naming another organization', async () => {
    // The ids are fetched out of band, as an attacker who had learned them
    // would have them: reading them through bob's own session would return
    // nothing and the insert would write zero rows for the wrong reason,
    // proving nothing about the write policy.
    const [period] = await admin`
      select id from reference_period
       where org_id = ${orgA.id}::uuid and frequency = 'annual' limit 1`;

    const message = await refusal(
      withRls(bob, { reason: 'test: cross-tenant constraint' }, (tx) =>
        tx.execute(sql`
          insert into benchmark_constraint
            (org_id, run_id, annual_period_id, approach, measure,
             annual_total, indicator_total, benchmarked_total, residual)
          values (${orgA.id}::uuid, ${quarterlyRunId}::uuid, ${period.id}::uuid,
                  'summary', 'headline_gdp', 1, 1, 1, 0)
        `),
      ),
    );
    expect(message).toMatch(/row-level security/i);

    // Naming his own organization does not help either: the run belongs to
    // org A, so the row would still be a bridge between two tenants.
    const own = await refusal(
      withRls(bob, { reason: 'test: cross-tenant constraint' }, (tx) =>
        tx.execute(sql`
          insert into benchmark_constraint
            (org_id, run_id, annual_period_id, approach, measure,
             annual_total, indicator_total, benchmarked_total, residual)
          values (${orgB.id}::uuid, ${quarterlyRunId}::uuid, ${period.id}::uuid,
                  'summary', 'headline_gdp', 1, 1, 1, 0)
        `),
      ),
    );
    expect(own).toBeTruthy();
  });
});
