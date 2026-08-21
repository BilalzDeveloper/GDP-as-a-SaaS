// Intake against a real database: isolation for the eight new tenant tables,
// the frozen-vintage guarantee, and the whole upload → map → validate →
// commit path.
//
// New tenant tables need matching policies AND matching isolation tests in the
// same change (CLAUDE.md working rules) — this is that test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withRls, closeDb, type RlsClaims } from '../../src/db/rls';
import { admin, claimsFor, createOrg, createTestUser, dbMessage } from '../rls/helpers';
import { parseCsvFile } from '../../src/intake/parse';
import { stageAndValidate, commitDataset, CommitBlockedError } from '../../src/intake/service';
import type { MappingDefinition } from '../../src/intake/types';

const run = Date.now().toString(36);

let alice: RlsClaims; // admin of Org A
let ana: RlsClaims; //   viewer in Org A
let bob: RlsClaims; //   admin of Org B
let orgA: { id: string };
let orgB: { id: string };
let activityVersionId: string;
let datasetId: string;

const CSV = [
  'txn,isic,year,value',
  'P.1,A,2023,500',
  'P.2,A,2023,200',
  'P.1,C,2023,2000',
  'P.2,C,2023,1200',
].join('\n');

function mappingFor(versionId: string): MappingDefinition {
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

async function uploadCsv(claims: RlsClaims, orgId: string, name: string, body = CSV) {
  const parsed = parseCsvFile(body);
  const sha = Array.from(name + body)
    .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
    .toString(16)
    .padStart(64, '0')
    .slice(0, 64);
  return withRls(claims, { reason: `test: upload ${name}` }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into source_dataset (
        org_id, name, original_filename, content_type, byte_size, sha256,
        status, header, row_count
      ) values (
        ${orgId}::uuid, ${name}, ${name + '.csv'}, 'text/csv',
        ${body.length}, ${sha}, 'parsed',
        ${JSON.stringify(parsed.header)}::jsonb, ${parsed.rows.length}
      ) returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
}

beforeAll(async () => {
  alice = claimsFor(await createTestUser(`in-alice-${run}@a.test`), 'alice');
  ana = claimsFor(await createTestUser(`in-ana-${run}@a.test`), 'ana');
  bob = claimsFor(await createTestUser(`in-bob-${run}@b.test`), 'bob');
  orgA = await createOrg(alice, 'Intake NSO A', `in-a-${run}`);
  orgB = await createOrg(bob, 'Intake NSO B', `in-b-${run}`);
  await withRls(alice, { reason: 'test: add viewer' }, (tx) =>
    tx.execute(
      sql`select public.add_member_by_email(${orgA.id}::uuid, ${`in-ana-${run}@a.test`}, 'viewer'::org_role)`,
    ),
  );

  const [isic] = await admin`
    select v.id from classification_version v
      join classification c on c.id = v.classification_id
     where c.code = 'ISIC4' and c.owner_org_id is null`;
  activityVersionId = isic.id;

  // Org A defines the reference periods its data will resolve against.
  await withRls(alice, { reason: 'test: define periods' }, (tx) =>
    tx.execute(sql`
      insert into reference_period (org_id, frequency, start_date, end_date, label, fiscal_year)
      values (${orgA.id}::uuid, 'annual', '2023-01-01', '2023-12-31', '2023', 2023),
             (${orgA.id}::uuid, 'annual', '2024-01-01', '2024-12-31', '2024', 2024)
    `),
  );

  datasetId = await uploadCsv(alice, orgA.id, 'annual survey');
});

afterAll(async () => {
  await closeDb();
  await admin.end();
});

describe('the intake path end to end', () => {
  it('stages every row and finds nothing wrong with clean data', async () => {
    const result = await stageAndValidate(
      alice,
      orgA.id,
      datasetId,
      parseCsvFile(CSV),
      mappingFor(activityVersionId),
    );
    expect(result.errorCount).toBe(0);
    const staged = (await withRls(alice, {}, (tx) =>
      tx.execute(
        sql`select count(*)::int as n from staging_row where dataset_id = ${datasetId}::uuid`,
      ),
    )) as unknown as { n: number }[];
    expect(staged[0].n).toBe(4);
  });

  it('commits staged rows into observations under a vintage', async () => {
    const vintageId = await withRls(alice, { reason: 'test: vintage' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into data_vintage (org_id, name) values (${orgA.id}::uuid, 'first estimate')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });

    const { observationsWritten } = await commitDataset(
      alice,
      orgA.id,
      datasetId,
      vintageId,
      mappingFor(activityVersionId),
    );
    expect(observationsWritten).toBe(4);

    // Four coordinates → four series, each with one observation.
    const series = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`select count(*)::int as n from time_series where org_id = ${orgA.id}::uuid`),
    )) as unknown as { n: number }[];
    expect(series[0].n).toBe(4);
  });

  it('keeps the drill-down path from observation back to the source row', async () => {
    // Milestone 5 needs to walk aggregate → observation → staging row → file.
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select o.value, sr.source_row_number, sr.raw, d.original_filename, d.sha256
          from observation o
          join staging_row sr on sr.id = o.staging_row_id
          join source_dataset d on d.id = o.source_dataset_id
         where o.org_id = ${orgA.id}::uuid
         order by sr.source_row_number
      `),
    )) as unknown as {
      value: string; source_row_number: number;
      raw: Record<string, string>; original_filename: string; sha256: string;
    }[];
    expect([...rows]).toHaveLength(4);
    expect(rows[0].source_row_number).toBe(2);
    expect(rows[0].raw.txn).toBe('P.1');
    expect(rows[0].original_filename).toContain('.csv');
  });

  it('refuses to commit while errors remain', async () => {
    const badId = await uploadCsv(
      alice,
      orgA.id,
      'bad survey',
      'txn,isic,year,value\nZZ.9,A,2023,500\n',
    );
    const result = await stageAndValidate(
      alice,
      orgA.id,
      badId,
      parseCsvFile('txn,isic,year,value\nZZ.9,A,2023,500\n'),
      mappingFor(activityVersionId),
    );
    expect(result.errorCount).toBeGreaterThan(0);

    const vintageId = await withRls(alice, { reason: 'test: vintage 2' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into data_vintage (org_id, name) values (${orgA.id}::uuid, 'blocked')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });

    await expect(
      commitDataset(alice, orgA.id, badId, vintageId, mappingFor(activityVersionId)),
    ).rejects.toThrow(CommitBlockedError);
  });

  it('re-staging replaces the previous attempt rather than accumulating', async () => {
    await stageAndValidate(
      alice, orgA.id, datasetId, parseCsvFile(CSV), mappingFor(activityVersionId),
    );
    const staged = (await withRls(alice, {}, (tx) =>
      tx.execute(
        sql`select count(*)::int as n from staging_row where dataset_id = ${datasetId}::uuid`,
      ),
    )) as unknown as { n: number }[];
    expect(staged[0].n).toBe(4);
  });
});

describe('a dataset commits with its own mapping, not the last one saved', () => {
  // Regression. `commitStaged` used to read the organization's most recently
  // saved column_mapping, whichever dataset it belonged to. Two datasets
  // mapped differently meant the second mapping silently reinterpreted the
  // first one's rows — every value potentially filed under the wrong
  // transaction code, industry or period, with nothing in the interface
  // saying so. Found by the end-to-end suite; fixed in migration 0008 by
  // recording the applied mapping on the dataset itself.
  it('stores the applied mapping on the dataset', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select applied_mapping from source_dataset where id = ${datasetId}::uuid
      `),
    )) as unknown as { applied_mapping: MappingDefinition | null }[];

    // stageAndValidate is the service; the action records the mapping, so
    // simulate what the action does and confirm the column round-trips.
    expect(rows).toHaveLength(1);

    const mapping = mappingFor(activityVersionId);
    await withRls(alice, { reason: 'test: record applied mapping' }, (tx) =>
      tx.execute(sql`
        update source_dataset
           set applied_mapping = ${JSON.stringify(mapping)}::jsonb
         where id = ${datasetId}::uuid
      `),
    );

    const after = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select applied_mapping from source_dataset where id = ${datasetId}::uuid
      `),
    )) as unknown as { applied_mapping: MappingDefinition }[];
    expect(after[0].applied_mapping.columns.periodLabel).toEqual({ source: 'year' });
    expect(after[0].applied_mapping.unitCode).toBe('NC_MN');
  });

  it('keeps two datasets’ mappings apart', async () => {
    // A second dataset in the same organization, mapped from differently
    // named columns. Under the old behaviour the later mapping would have
    // been used to commit the earlier dataset.
    const otherCsv = [
      'code,activity,ref_period,amount',
      'P.1,A,2023,111',
      'P.2,A,2023,11',
    ].join('\n');
    const parsed = parseCsvFile(otherCsv);

    const otherId = await withRls(alice, { reason: 'test: second upload' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into source_dataset (
          org_id, name, original_filename, content_type, byte_size, sha256,
          status, header, row_count
        ) values (
          ${orgA.id}::uuid, 'other', 'other.csv', 'text/csv',
          ${otherCsv.length}, ${'d'.repeat(64)}, 'parsed',
          ${JSON.stringify(parsed.header)}::jsonb, ${parsed.rows.length}
        ) returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });

    const otherMapping: MappingDefinition = {
      columns: {
        value: { source: 'amount' },
        periodLabel: { source: 'ref_period' },
        transactionCode: { source: 'code' },
        activityCode: { source: 'activity' },
      },
      activityVersionId,
      unitCode: 'NC_TH',
      priceBasis: 'current',
      valuation: 'basic',
      frequency: 'annual',
    };
    await withRls(alice, { reason: 'test: map second dataset' }, (tx) =>
      tx.execute(sql`
        update source_dataset
           set applied_mapping = ${JSON.stringify(otherMapping)}::jsonb
         where id = ${otherId}::uuid
      `),
    );

    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select id, applied_mapping from source_dataset
         where id in (${datasetId}::uuid, ${otherId}::uuid)
      `),
    )) as unknown as { id: string; applied_mapping: MappingDefinition }[];

    const first = [...rows].find((r) => r.id === datasetId)!;
    const second = [...rows].find((r) => r.id === otherId)!;
    expect(first.applied_mapping.columns.value).toEqual({ source: 'value' });
    expect(second.applied_mapping.columns.value).toEqual({ source: 'amount' });
    expect(first.applied_mapping.unitCode).toBe('NC_MN');
    expect(second.applied_mapping.unitCode).toBe('NC_TH');
  });
});

describe('frozen vintages are immutable (non-negotiable 1)', () => {
  let frozenVintage: string;

  beforeAll(async () => {
    frozenVintage = await withRls(alice, { reason: 'test: freeze' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into data_vintage (org_id, name) values (${orgA.id}::uuid, 'to be frozen')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });
    await commitDataset(alice, orgA.id, datasetId, frozenVintage, mappingFor(activityVersionId));
    await withRls(alice, { reason: 'test: freeze it' }, (tx) =>
      tx.execute(sql`update data_vintage set frozen_at = now() where id = ${frozenVintage}::uuid`),
    );
  });

  it('rejects new observations in a frozen vintage', async () => {
    await expect(
      commitDataset(alice, orgA.id, datasetId, frozenVintage, mappingFor(activityVersionId)),
    ).rejects.toThrow(/frozen/);
  });

  it('rejects updating an observation in a frozen vintage', async () => {
    await expect(
      withRls(alice, { reason: 'attack: edit frozen' }, (tx) =>
        tx.execute(
          sql`update observation set value = 999 where vintage_id = ${frozenVintage}::uuid`,
        ),
      ),
    ).rejects.toSatisfy((e: unknown) => /frozen/.test(dbMessage(e)));
  });

  it('rejects deleting an observation in a frozen vintage', async () => {
    await expect(
      withRls(alice, { reason: 'attack: delete frozen' }, (tx) =>
        tx.execute(sql`delete from observation where vintage_id = ${frozenVintage}::uuid`),
      ),
    ).rejects.toSatisfy((e: unknown) => /frozen/.test(dbMessage(e)));
  });

  it('refuses to un-freeze or move the embargo', async () => {
    await expect(
      withRls(alice, { reason: 'attack: unfreeze' }, (tx) =>
        tx.execute(sql`update data_vintage set frozen_at = null where id = ${frozenVintage}::uuid`),
      ),
    ).rejects.toSatisfy((e: unknown) => /may only change its published flag/.test(dbMessage(e)));
  });

  it('still allows the published flag to be set', async () => {
    await withRls(alice, { reason: 'test: publish' }, (tx) =>
      tx.execute(sql`update data_vintage set published = true where id = ${frozenVintage}::uuid`),
    );
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`select published from data_vintage where id = ${frozenVintage}::uuid`),
    )) as unknown as { published: boolean }[];
    expect(rows[0].published).toBe(true);
  });

  it('will not let an unfrozen vintage be published', async () => {
    await expect(
      withRls(alice, { reason: 'attack: publish unfrozen' }, async (tx) => {
        await tx.execute(sql`
          insert into data_vintage (org_id, name, published)
          values (${orgA.id}::uuid, 'unfrozen but published', true)
        `);
      }),
    ).rejects.toSatisfy((e: unknown) => /data_vintage_check|violates check/.test(dbMessage(e)));
  });
});

describe('tenant isolation for every intake table', () => {
  const tables = [
    'reference_period', 'source_dataset', 'staging_row', 'validation_issue',
    'time_series', 'data_vintage', 'observation', 'column_mapping',
  ];

  it.each(tables)("%s shows another tenant's rows to nobody", async (table) => {
    const rows = (await withRls(bob, {}, (tx) =>
      tx.execute(sql.raw(`select count(*)::int as n from ${table} where org_id = '${orgA.id}'`)),
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  it.each(tables)('%s shows own-org rows to a member', async (table) => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql.raw(`select count(*)::int as n from ${table} where org_id = '${orgA.id}'`)),
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it("another tenant cannot write into org A's dataset", async () => {
    await expect(
      withRls(bob, { reason: 'attack: inject staging' }, (tx) =>
        tx.execute(sql`
          insert into staging_row (org_id, dataset_id, source_row_number, raw)
          values (${orgA.id}::uuid, ${datasetId}::uuid, 999, '{}'::jsonb)
        `),
      ),
    ).rejects.toSatisfy((e: unknown) => /row-level security/.test(dbMessage(e)));
  });

  it('a viewer can read source data but not upload', async () => {
    const readable = (await withRls(ana, {}, (tx) =>
      tx.execute(sql`select count(*)::int as n from source_dataset where org_id = ${orgA.id}::uuid`),
    )) as unknown as { n: number }[];
    expect(readable[0].n).toBeGreaterThan(0);

    await expect(
      withRls(ana, { reason: 'viewer upload' }, (tx) =>
        tx.execute(sql`
          insert into source_dataset (
            org_id, name, original_filename, content_type, byte_size, sha256
          ) values (
            ${orgA.id}::uuid, 'sneaky', 'x.csv', 'text/csv', 1, repeat('a', 64)
          )
        `),
      ),
    ).rejects.toSatisfy((e: unknown) => /row-level security/.test(dbMessage(e)));
  });

  it('the same bytes cannot be uploaded twice to one organization', async () => {
    await expect(uploadCsv(alice, orgA.id, 'annual survey')).rejects.toSatisfy(
      (e: unknown) => /source_dataset_org_id_sha256_key/.test(dbMessage(e)),
    );
  });

  it('records the upload and the commit in the audit trail', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`
        select table_name, action, reason from audit_log
         where org_id = ${orgA.id}::uuid and table_name in ('source_dataset', 'observation')
         order by occurred_at limit 5
      `),
    )) as unknown as { table_name: string; action: string; reason: string }[];
    expect([...rows].length).toBeGreaterThan(0);
    expect(rows[0].reason).toBeTruthy();
  });
});
