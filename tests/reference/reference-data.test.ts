// Milestone-2 acceptance suite: the reference data layer and the tenant
// mapping layer.
//
// Two concerns, both load-bearing:
//   1. Non-negotiable 3 again — a tenant's national classification is
//      commercially and politically sensitive. New tables mean new policies,
//      and new policies mean new isolation tests (CLAUDE.md working rules).
//   2. Non-negotiable 4 — classifications are data. The seeds must actually
//      form a valid hierarchy, and the mapping layer must refuse to activate
//      a mapping that would silently lose or double-count values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withRls, closeDb, type RlsClaims } from '../../src/db/rls';
import {
  admin,
  claimsFor,
  createOrg,
  createTestUser,
  dbMessage,
} from '../rls/helpers';

const run = Date.now().toString(36);

let alice: RlsClaims; // admin of Org A
let ana: RlsClaims; //   viewer in Org A
let bob: RlsClaims; //   admin of Org B
let orgA: { id: string };
let orgB: { id: string };
let isicVersionId: string;
let natVersionId: string; // Org A's national classification version
let natClassificationId: string;

async function expectDbError(p: Promise<unknown>, re: RegExp) {
  await expect(p).rejects.toSatisfy((e: unknown) => {
    const message = dbMessage(e);
    if (!re.test(message)) {
      throw new Error(`expected error matching ${re}, got: ${message}`);
    }
    return true;
  });
}

beforeAll(async () => {
  alice = claimsFor(await createTestUser(`ref-alice-${run}@a.test`), 'alice');
  ana = claimsFor(await createTestUser(`ref-ana-${run}@a.test`), 'ana');
  bob = claimsFor(await createTestUser(`ref-bob-${run}@b.test`), 'bob');

  orgA = await createOrg(alice, 'Ref NSO A', `ref-a-${run}`);
  orgB = await createOrg(bob, 'Ref NSO B', `ref-b-${run}`);
  await withRls(alice, { reason: 'test: add viewer' }, (tx) =>
    tx.execute(
      sql`select public.add_member_by_email(${orgA.id}::uuid, ${`ref-ana-${run}@a.test`}, 'viewer'::org_role)`,
    ),
  );

  const [isic] = await admin`
    select v.id from classification_version v
      join classification c on c.id = v.classification_id
     where c.code = 'ISIC4' and c.owner_org_id is null`;
  isicVersionId = isic.id;

  // Org A defines a national activity classification with two industries.
  const created = await withRls(
    alice,
    { reason: 'test: national classification' },
    async (tx) => {
      const cls = (await tx.execute(
        sql`insert into classification (code, name, kind, owner_org_id)
            values ('NAT-A', 'National activities A', 'activity', ${orgA.id}::uuid)
            returning id`,
      )) as unknown as { id: string }[];
      const ver = (await tx.execute(
        sql`insert into classification_version
              (classification_id, version_label, provenance, seeded_to_level, is_current)
            values (${cls[0].id}::uuid, 'v1', 'tenant_defined', 1, true)
            returning id`,
      )) as unknown as { id: string }[];
      await tx.execute(
        sql`insert into classification_item (version_id, code, name, level, sort_order)
            values (${ver[0].id}::uuid, 'A01', 'National farming', 1, 10),
                   (${ver[0].id}::uuid, 'A02', 'National forestry', 1, 20)`,
      );
      return { classificationId: cls[0].id, versionId: ver[0].id };
    },
  );
  natClassificationId = created.classificationId;
  natVersionId = created.versionId;
});

afterAll(async () => {
  await closeDb();
  await admin.end();
});

describe('shared reference data is readable by every tenant', () => {
  it('both orgs see the seeded standard classifications', async () => {
    for (const who of [alice, bob]) {
      const rows = (await withRls(who, {}, (tx) =>
        tx.execute(
          sql`select code from classification where owner_org_id is null order by code`,
        ),
      )) as unknown as { code: string }[];
      const codes = [...rows].map((r) => r.code);
      expect(codes).toEqual(
        expect.arrayContaining(['ISIC4', 'CPC21', 'COICOP1999', 'COFOG', 'SNA_SECTOR']),
      );
    }
  });

  it('ISIC items are readable and form the published shape', async () => {
    const rows = (await withRls(bob, {}, (tx) =>
      tx.execute(
        sql`select level, count(*)::int as n from classification_item
             where version_id = ${isicVersionId}::uuid group by level order by level`,
      ),
    )) as unknown as { level: number; n: number }[];
    const byLevel = Object.fromEntries([...rows].map((r) => [r.level, r.n]));
    expect(byLevel[1]).toBe(21); // sections A–U
    expect(byLevel[2]).toBe(88); // divisions
  });

  it('transaction codes required by the brief are all present', async () => {
    const required = [
      'P.1', 'P.2', 'B.1g', 'D.21', 'D.31', 'P.3', 'P.51g', 'P.52', 'P.53',
      'P.6', 'P.7', 'D.1', 'B.2g', 'B.3g', 'D.2', 'D.3',
    ];
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`select code from transaction_code`),
    )) as unknown as { code: string }[];
    const have = new Set([...rows].map((r) => r.code));
    expect(required.filter((c) => !have.has(c))).toEqual([]);
  });

  it('institutional sectors cover S.11 through S.2', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(
        sql`select i.code from classification_item i
              join classification_version v on v.id = i.version_id
              join classification c on c.id = v.classification_id
             where c.code = 'SNA_SECTOR'`,
      ),
    )) as unknown as { code: string }[];
    const have = new Set([...rows].map((r) => r.code));
    for (const code of ['S.11', 'S.12', 'S.13', 'S.14', 'S.15', 'S.2']) {
      expect(have.has(code)).toBe(true);
    }
  });

  it('no tenant can write shared classifications', async () => {
    // The write policy requires an owning org, so a standard classification
    // simply matches no rows — RLS filters rather than errors on UPDATE.
    await withRls(alice, { reason: 'attack: edit ISIC' }, (tx) =>
      tx.execute(
        sql`update classification set name = 'Hijacked' where code = 'ISIC4'`,
      ),
    );
    const [row] = await admin`select name from classification where code = 'ISIC4'`;
    expect(row.name).toMatch(/^International Standard Industrial/);

    await expectDbError(
      withRls(alice, { reason: 'attack: delete ISIC' }, (tx) =>
        tx.execute(sql`insert into classification (code, name, kind, owner_org_id)
                       values ('ROGUE', 'Rogue standard', 'activity', null)`),
      ),
      /row-level security/,
    );
  });

  it('no tenant can write the shared code tables at all', async () => {
    // These have no write grant for app roles, so the failure is a hard
    // permission error rather than a filtered-away row.
    await expectDbError(
      withRls(alice, { reason: 'attack: edit transaction codes' }, (tx) =>
        tx.execute(sql`update transaction_code set name = 'Nope' where code = 'P.1'`),
      ),
      /permission denied/,
    );
    await expectDbError(
      withRls(alice, { reason: 'attack: edit currency' }, (tx) =>
        tx.execute(sql`update currency set name = 'Nope' where code = 'GBP'`),
      ),
      /permission denied/,
    );
    // The benchmarks are the same kind of table: public figures, seeded, and
    // writable by no application role. A tenant that could edit them could
    // move the yardstick its own compilation is judged against.
    await expectDbError(
      withRls(alice, { reason: 'attack: edit a benchmark figure' }, (tx) =>
        tx.execute(sql`update benchmark_observation set value = 1
                        where country_iso3 = 'USA'`),
      ),
      /permission denied/,
    );
    await expectDbError(
      withRls(alice, { reason: 'attack: claim a source is verified' }, (tx) =>
        tx.execute(sql`update benchmark_source set verified = true`),
      ),
      /permission denied/,
    );
  });

  it('every tenant reads the same benchmark figures', async () => {
    // Reference data, not tenant data: two organizations see one set.
    const forAlice = (await withRls(alice, {}, (tx) =>
      tx.execute(sql`select count(*)::int as n from benchmark_observation`),
    )) as unknown as { n: number }[];
    const forBob = (await withRls(bob, {}, (tx) =>
      tx.execute(sql`select count(*)::int as n from benchmark_observation`),
    )) as unknown as { n: number }[];
    expect(forAlice[0].n).toBeGreaterThan(0);
    expect(forBob[0].n).toBe(forAlice[0].n);
  });
});

describe('tenant classifications are isolated', () => {
  it("another tenant cannot see Org A's national classification", async () => {
    const rows = (await withRls(bob, {}, (tx) =>
      tx.execute(
        sql`select id from classification where id = ${natClassificationId}::uuid`,
      ),
    )) as unknown as unknown[];
    expect([...rows]).toHaveLength(0);
  });

  it("another tenant cannot see its versions or items", async () => {
    const versions = (await withRls(bob, {}, (tx) =>
      tx.execute(
        sql`select id from classification_version where id = ${natVersionId}::uuid`,
      ),
    )) as unknown as unknown[];
    const items = (await withRls(bob, {}, (tx) =>
      tx.execute(
        sql`select id from classification_item where version_id = ${natVersionId}::uuid`,
      ),
    )) as unknown as unknown[];
    expect([...versions]).toHaveLength(0);
    expect([...items]).toHaveLength(0);
  });

  it('another tenant cannot add items to it', async () => {
    await expectDbError(
      withRls(bob, { reason: 'attack: inject item' }, (tx) =>
        tx.execute(
          sql`insert into classification_item (version_id, code, name, level)
              values (${natVersionId}::uuid, 'X99', 'Injected', 1)`,
        ),
      ),
      /row-level security/,
    );
  });

  it('a viewer in the owning org can read but not write', async () => {
    const items = (await withRls(ana, {}, (tx) =>
      tx.execute(
        sql`select code from classification_item where version_id = ${natVersionId}::uuid`,
      ),
    )) as unknown as { code: string }[];
    expect([...items].map((r) => r.code).sort()).toEqual(['A01', 'A02']);

    await expectDbError(
      withRls(ana, { reason: 'viewer write' }, (tx) =>
        tx.execute(
          sql`insert into classification_item (version_id, code, name, level)
              values (${natVersionId}::uuid, 'A03', 'Viewer added', 1)`,
        ),
      ),
      /row-level security/,
    );
  });

  it('the hierarchy cannot span two versions', async () => {
    const [isicItem] = await admin`
      select id from classification_item
       where version_id = ${isicVersionId} and code = '01'`;
    await expectDbError(
      withRls(alice, { reason: 'attack: cross-version parent' }, (tx) =>
        tx.execute(
          sql`insert into classification_item (version_id, code, name, level, parent_id)
              values (${natVersionId}::uuid, 'A99', 'Bad parent', 2, ${isicItem.id}::uuid)`,
        ),
      ),
      /different classification version/,
    );
  });
});

describe('mapping layer validation', () => {
  let mappingId: string;
  let itemA01: string;
  let itemA02: string;
  let isicDiv01: string;
  let isicDiv02: string;

  beforeAll(async () => {
    const [a01] = await admin`select id from classification_item
      where version_id = ${natVersionId} and code = 'A01'`;
    const [a02] = await admin`select id from classification_item
      where version_id = ${natVersionId} and code = 'A02'`;
    const [d01] = await admin`select id from classification_item
      where version_id = ${isicVersionId} and code = '01'`;
    const [d02] = await admin`select id from classification_item
      where version_id = ${isicVersionId} and code = '02'`;
    itemA01 = a01.id; itemA02 = a02.id; isicDiv01 = d01.id; isicDiv02 = d02.id;

    const rows = (await withRls(alice, { reason: 'test: mapping' }, (tx) =>
      tx.execute(
        sql`insert into classification_mapping
              (owner_org_id, name, from_version_id, to_version_id)
            values (${orgA.id}::uuid, 'NAT-A → ISIC', ${natVersionId}::uuid,
                    ${isicVersionId}::uuid)
            returning id`,
      ),
    )) as unknown as { id: string }[];
    mappingId = rows[0].id;
  });

  it('flags source items that are not mapped at all', async () => {
    const problems = (await withRls(alice, {}, (tx) =>
      tx.execute(
        sql`select problem, item_code from validate_classification_mapping(${mappingId}::uuid)`,
      ),
    )) as unknown as { problem: string; item_code: string }[];
    const kinds = [...problems].map((p) => p.problem);
    expect(kinds).toContain('unmapped_source_item');
    expect([...problems].map((p) => p.item_code).sort()).toEqual(['A01', 'A02']);
  });

  it('refuses to activate a mapping with problems', async () => {
    await expectDbError(
      withRls(alice, { reason: 'test: premature activation' }, (tx) =>
        tx.execute(sql`select activate_classification_mapping(${mappingId}::uuid)`),
      ),
      /validation problem/,
    );
  });

  it('flags weights that do not sum to one', async () => {
    // A01 split across two ISIC divisions, but only 70% allocated.
    await withRls(alice, { reason: 'test: partial split' }, (tx) =>
      tx.execute(
        sql`insert into classification_mapping_entry
              (mapping_id, from_item_id, to_item_id, weight)
            values (${mappingId}::uuid, ${itemA01}::uuid, ${isicDiv01}::uuid, 0.5),
                   (${mappingId}::uuid, ${itemA01}::uuid, ${isicDiv02}::uuid, 0.2),
                   (${mappingId}::uuid, ${itemA02}::uuid, ${isicDiv02}::uuid, 1)`,
      ),
    );
    const problems = (await withRls(alice, {}, (tx) =>
      tx.execute(
        sql`select problem, item_code, detail
              from validate_classification_mapping(${mappingId}::uuid)`,
      ),
    )) as unknown as { problem: string; item_code: string; detail: string }[];
    const weight = [...problems].find((p) => p.problem === 'weights_do_not_sum_to_one');
    expect(weight?.item_code).toBe('A01');
    expect(weight?.detail).toContain('0.7');
  });

  it('activates once the 1-to-many split is complete', async () => {
    await withRls(alice, { reason: 'test: complete the split' }, (tx) =>
      tx.execute(
        sql`update classification_mapping_entry set weight = 0.5
             where mapping_id = ${mappingId}::uuid
               and from_item_id = ${itemA01}::uuid
               and to_item_id = ${isicDiv02}::uuid`,
      ),
    );
    const problems = (await withRls(alice, {}, (tx) =>
      tx.execute(
        sql`select * from validate_classification_mapping(${mappingId}::uuid)`,
      ),
    )) as unknown as unknown[];
    expect([...problems]).toHaveLength(0);

    await withRls(alice, { reason: 'test: activate' }, (tx) =>
      tx.execute(sql`select activate_classification_mapping(${mappingId}::uuid)`),
    );
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(
        sql`select activated_at from classification_mapping where id = ${mappingId}::uuid`,
      ),
    )) as unknown as { activated_at: string | null }[];
    expect(rows[0].activated_at).not.toBeNull();
  });

  it("another tenant cannot see or validate the mapping", async () => {
    const visible = (await withRls(bob, {}, (tx) =>
      tx.execute(
        sql`select id from classification_mapping where id = ${mappingId}::uuid`,
      ),
    )) as unknown as unknown[];
    expect([...visible]).toHaveLength(0);

    const entries = (await withRls(bob, {}, (tx) =>
      tx.execute(
        sql`select id from classification_mapping_entry where mapping_id = ${mappingId}::uuid`,
      ),
    )) as unknown as unknown[];
    expect([...entries]).toHaveLength(0);

    // The validation function is SECURITY INVOKER, so RLS still applies: a
    // non-member gets an empty result rather than another tenant's structure.
    const problems = (await withRls(bob, {}, (tx) =>
      tx.execute(
        sql`select * from validate_classification_mapping(${mappingId}::uuid)`,
      ),
    )) as unknown as unknown[];
    expect([...problems]).toHaveLength(0);
  });
});

describe('provenance is recorded honestly', () => {
  it('seeded versions are marked as awaiting verification, not official', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(
        sql`select c.code, v.provenance, v.seeded_to_level
              from classification_version v
              join classification c on c.id = v.classification_id
             where c.owner_org_id is null order by c.code`,
      ),
    )) as unknown as { code: string; provenance: string; seeded_to_level: number }[];
    for (const r of [...rows]) {
      expect(r.provenance).toBe('transcribed_pending_verification');
      expect(r.seeded_to_level).toBeGreaterThanOrEqual(1);
    }
  });

  it('a version cannot claim official provenance without its evidence', async () => {
    await expect(
      admin`update classification_version set provenance = 'official_file'
             where id = ${isicVersionId}`,
    ).rejects.toThrow(/official_needs_evidence/);
  });
});

describe('drill-down helper', () => {
  it('returns the hierarchy with parent codes attached', async () => {
    const rows = (await withRls(alice, {}, (tx) =>
      tx.execute(
        sql`select code, parent_code, level from classification_tree(${isicVersionId}::uuid)
             where code in ('C', '10', '35')`,
      ),
    )) as unknown as { code: string; parent_code: string | null; level: number }[];
    const byCode = Object.fromEntries([...rows].map((r) => [r.code, r]));
    expect(byCode['C'].parent_code).toBeNull();
    expect(byCode['10'].parent_code).toBe('C');
    expect(byCode['35'].parent_code).toBe('D');
  });

  it('respects RLS — a non-member gets nothing for a tenant version', async () => {
    const rows = (await withRls(bob, {}, (tx) =>
      tx.execute(sql`select * from classification_tree(${natVersionId}::uuid)`),
    )) as unknown as unknown[];
    expect([...rows]).toHaveLength(0);
  });
});
