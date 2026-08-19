// Volume measures through the whole stack: deflators arriving as ordinary
// index-valued observations, chain-linking in a run, and the non-additivity
// residual being stored rather than hidden.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withRls, closeDb, type RlsClaims } from '../../src/db/rls';
import { admin, claimsFor, createOrg, createTestUser } from '../rls/helpers';
import { executeRun } from '../../src/compile/execute';

const run = Date.now().toString(36);

let alice: RlsClaims;
let orgA: { id: string };
let vintageId: string;
let runId: string;
let itemA: string;
let itemC: string;

// Two industries with opposite price movements across three years, so the
// chained aggregate cannot equal the sum of its chained parts.
const DATA = {
  A: { values: [600, 700, 800], deflators: [100, 120, 140] },
  C: { values: [400, 420, 430], deflators: [100, 90, 80] },
};
const YEARS = ['2021', '2022', '2023'];

beforeAll(async () => {
  alice = claimsFor(await createTestUser(`vol-${run}@a.test`), 'alice');
  orgA = await createOrg(alice, 'Volume NSO', `vol-${run}`);

  const [isic] = await admin`
    select v.id from classification_version v
      join classification c on c.id = v.classification_id
     where c.code = 'ISIC4' and c.owner_org_id is null`;
  const [a] = await admin`
    select id from classification_item where version_id = ${isic.id} and code = 'A'`;
  const [c] = await admin`
    select id from classification_item where version_id = ${isic.id} and code = 'C'`;
  itemA = a.id;
  itemC = c.id;

  await withRls(alice, { reason: 'test: periods' }, (tx) =>
    tx.execute(sql`
      insert into reference_period (org_id, frequency, start_date, end_date, label, fiscal_year)
      values (${orgA.id}::uuid, 'annual', '2021-01-01', '2021-12-31', '2021', 2021),
             (${orgA.id}::uuid, 'annual', '2022-01-01', '2022-12-31', '2022', 2022),
             (${orgA.id}::uuid, 'annual', '2023-01-01', '2023-12-31', '2023', 2023)
    `),
  );

  vintageId = await withRls(alice, { reason: 'test: vintage' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into data_vintage (org_id, name) values (${orgA.id}::uuid, 'v1') returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });

  // Seed observations directly: output and intermediate consumption giving
  // the value added above, plus taxes, plus a B.1g deflator per industry.
  await withRls(alice, { reason: 'test: observations' }, async (tx) => {
    const periods = (await tx.execute(sql`
      select id, label from reference_period where org_id = ${orgA.id}::uuid
    `)) as unknown as { id: string; label: string }[];
    const periodByLabel = new Map([...periods].map((p) => [p.label, p.id]));

    const series = async (
      txn: string, activity: string | null, unit: string,
    ): Promise<string> => {
      const rows = (await tx.execute(sql`
        insert into time_series (org_id, transaction_code, activity_item_id,
                                 price_basis, valuation, frequency, unit_code)
        values (${orgA.id}::uuid, ${txn}, ${activity}::uuid, 'current',
                ${unit === 'INDEX' ? null : 'basic'}::valuation_basis,
                'annual', ${unit})
        on conflict (org_id, transaction_code, activity_item_id, product_item_id,
                     sector_item_id, purpose_item_id, price_basis, valuation, frequency)
        do update set unit_code = excluded.unit_code
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    };

    const observe = async (seriesId: string, label: string, value: number) => {
      await tx.execute(sql`
        insert into observation (org_id, series_id, period_id, vintage_id, value)
        values (${orgA.id}::uuid, ${seriesId}::uuid,
                ${periodByLabel.get(label)}::uuid, ${vintageId}::uuid, ${value})
      `);
    };

    for (const [code, item] of [['A', itemA], ['C', itemC]] as const) {
      const spec = DATA[code as 'A' | 'C'];
      // Value added = output − intermediate; use IC = 0 so GVA equals output.
      const outputSeries = await series('P.1', item, 'NC_MN');
      const icSeries = await series('P.2', item, 'NC_MN');
      const deflatorSeries = await series('B.1g', item, 'INDEX');
      for (const [i, label] of YEARS.entries()) {
        await observe(outputSeries, label, spec.values[i]);
        await observe(icSeries, label, 0);
        await observe(deflatorSeries, label, spec.deflators[i]);
      }
    }

    const taxes = await series('D.21', null, 'NC_MN');
    for (const label of YEARS) await observe(taxes, label, 0);
  });

  runId = await withRls(alice, { reason: 'test: run' }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into compilation_run
        (org_id, name, frequency, input_vintage_id, anchor_approach,
         volume_reference_period_label, volume_index_formula)
      values (${orgA.id}::uuid, 'volumes', 'annual', ${vintageId}::uuid,
              'production', '2021', 'laspeyres')
      returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
});

afterAll(async () => {
  await closeDb();
  await admin.end();
});

async function volumeValue(measure: string, label: string, activity: string | null) {
  const rows = (await withRls(alice, {}, (tx) =>
    tx.execute(sql`
      select cr.value from compilation_result cr
        join reference_period p on p.id = cr.period_id
       where cr.run_id = ${runId}::uuid and cr.measure = ${measure}
         and cr.price_basis = 'chain_linked' and p.label = ${label}
         and cr.activity_item_id is not distinct from ${activity}::uuid
    `),
  )) as unknown as { value: string | null }[];
  return rows.length && rows[0].value !== null ? Number(rows[0].value) : null;
}

describe('volumes in a compilation run', () => {
  it('executes and reports the volume summary', async () => {
    const summary = await executeRun(alice, orgA.id, runId);
    expect(summary.volumes).not.toBeNull();
    expect(summary.volumes?.seriesLinked).toBe(2);
    expect(summary.volumes?.referencePeriodLabel).toBe('2021');
  });

  it('sets the chain index to 100 in the reference period', async () => {
    expect(await volumeValue('chain_index', '2021', itemA)).toBeCloseTo(100, 6);
    expect(await volumeValue('chain_index', '2021', null)).toBeCloseTo(100, 6);
  });

  it('chain-links each industry with its own deflator', async () => {
    // A: 700/1.2 = 583.33 against 600 ⇒ −2.78%
    expect(await volumeValue('volume_growth_percent', '2022', itemA)).toBeCloseTo(
      ((700 / 1.2 - 600) / 600) * 100, 4,
    );
    // C: 420/0.9 = 466.67 against 400 ⇒ +16.67%
    expect(await volumeValue('volume_growth_percent', '2022', itemC)).toBeCloseTo(
      ((420 / 0.9 - 400) / 400) * 100, 4,
    );
  });

  it('aggregates from the components, not from an aggregate deflator', async () => {
    // (583.33 + 466.67) / 1000 − 1 = +5%
    expect(await volumeValue('volume_growth_percent', '2022', null)).toBeCloseTo(5, 4);
  });

  it('stores each period at the previous period’s prices', async () => {
    expect(await volumeValue('previous_year_prices_value', '2022', itemA)).toBeCloseTo(
      700 / 1.2, 4,
    );
  });

  it('stores the non-additivity residual instead of hiding it', async () => {
    // Zero in the reference period and the one after; non-zero from the
    // second link, which is the property that surprises users.
    expect(await volumeValue('non_additivity_residual', '2021', null)).toBeCloseTo(0, 6);
    expect(await volumeValue('non_additivity_residual', '2022', null)).toBeCloseTo(0, 6);
    const later = await volumeValue('non_additivity_residual', '2023', null);
    expect(Math.abs(later as number)).toBeGreaterThan(1);
  });

  it('keeps current-price results alongside the volume ones', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select price_basis, count(*)::int as n from compilation_result
         where run_id = ${runId}::uuid group by price_basis order by price_basis
      `),
    )) as unknown as { price_basis: string; n: number }[];
    const byBasis = Object.fromEntries([...rows].map((r) => [r.price_basis, r.n]));
    expect(byBasis.current).toBeGreaterThan(0);
    expect(byBasis.chain_linked).toBeGreaterThan(0);
  });

  it('leaves volumes alone when the run does not ask for them', async () => {
    const plainRun = await withRls(alice, { reason: 'test: no volumes' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into compilation_run (org_id, name, frequency, input_vintage_id)
        values (${orgA.id}::uuid, 'current prices only', 'annual', ${vintageId}::uuid)
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });
    const summary = await executeRun(alice, orgA.id, plainRun);
    expect(summary.volumes).toBeNull();
  });

  it('says so when volumes are requested but no deflators exist', async () => {
    const emptyVintage = await withRls(alice, { reason: 'test: bare vintage' }, async (tx) => {
      const v = (await tx.execute(sql`
        insert into data_vintage (org_id, name) values (${orgA.id}::uuid, 'bare') returning id
      `)) as unknown as { id: string }[];
      const periods = (await tx.execute(sql`
        select id from reference_period where org_id = ${orgA.id}::uuid limit 1
      `)) as unknown as { id: string }[];
      const s = (await tx.execute(sql`
        insert into time_series (org_id, transaction_code, activity_item_id, price_basis,
                                 valuation, frequency, unit_code)
        values (${orgA.id}::uuid, 'P.1', ${itemA}::uuid, 'current', 'basic', 'annual', 'NC_MN')
        on conflict (org_id, transaction_code, activity_item_id, product_item_id,
                     sector_item_id, purpose_item_id, price_basis, valuation, frequency)
        do update set unit_code = excluded.unit_code returning id
      `)) as unknown as { id: string }[];
      await tx.execute(sql`
        insert into observation (org_id, series_id, period_id, vintage_id, value)
        values (${orgA.id}::uuid, ${s[0].id}::uuid, ${periods[0].id}::uuid,
                ${v[0].id}::uuid, 100)
      `);
      return v[0].id;
    });

    const bareRun = await withRls(alice, { reason: 'test: bare run' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into compilation_run (org_id, name, frequency, input_vintage_id,
                                     volume_reference_period_label)
        values (${orgA.id}::uuid, 'no deflators', 'annual', ${emptyVintage}::uuid, '2021')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });
    const summary = await executeRun(alice, orgA.id, bareRun);
    expect(summary.volumes).toBeNull();

    const diagnostics = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select code, message from compilation_diagnostic where run_id = ${bareRun}::uuid
      `),
    )) as unknown as { code: string; message: string }[];
    expect([...diagnostics].map((d) => d.code)).toContain('no_deflators');
  });
});
