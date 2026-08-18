// Milestone-1 acceptance suite (PLAN.md, risk 1): adversarial tenant
// isolation. Two organizations are seeded through the app's own withRls()
// path; every assertion then attacks the boundary from the outside.
//
// Non-negotiable 3: cross-tenant leakage is a catastrophic failure. If any
// test here fails, the build is red — no exceptions, no skips.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withRls, closeDb, schema, type RlsClaims } from '../../src/db/rls';
import { admin, claimsFor, createTestUser } from './helpers';

let alice: RlsClaims; // admin of Org A
let ana: RlsClaims; //   viewer in Org A
let bob: RlsClaims; //   admin of Org B
let mallory: RlsClaims; // authenticated, member of nothing
let orgA: { id: string; slug: string };
let orgB: { id: string; slug: string };

const run = Date.now().toString(36);

/**
 * Drizzle wraps database errors (the PostgresError sits in `cause`); assert
 * the underlying database message so tests fail loudly on the wrong error.
 */
async function expectDbError(p: Promise<unknown>, re: RegExp) {
  await expect(p).rejects.toSatisfy((e: unknown) => {
    const err = e as { message?: string; cause?: { message?: string } };
    const message = err?.cause?.message ?? err?.message ?? String(e);
    if (!re.test(message)) {
      throw new Error(`expected error matching ${re}, got: ${message}`);
    }
    return true;
  });
}

beforeAll(async () => {
  alice = claimsFor(await createTestUser(`alice-${run}@a.test`), 'alice');
  ana = claimsFor(await createTestUser(`ana-${run}@a.test`), 'ana');
  bob = claimsFor(await createTestUser(`bob-${run}@b.test`), 'bob');
  mallory = claimsFor(await createTestUser(`mallory-${run}@m.test`), 'mallory');

  const createOrg = (claims: RlsClaims, name: string, slug: string) =>
    withRls(claims, { reason: `test: create ${slug}` }, async (tx) => {
      const rows = (await tx.execute(
        sql`select id, slug from public.create_organization(${name}, ${slug})`,
      )) as unknown as { id: string; slug: string }[];
      return rows[0];
    });

  orgA = await createOrg(alice, 'NSO Atlantis', `atlantis-${run}`);
  await withRls(alice, { reason: 'test: add ana as viewer' }, (tx) =>
    tx.execute(
      sql`select public.add_member_by_email(${orgA.id}::uuid, ${`ana-${run}@a.test`}, 'viewer'::org_role)`,
    ),
  );
  orgB = await createOrg(bob, 'NSO Borduria', `borduria-${run}`);
});

afterAll(async () => {
  await closeDb();
  await admin.end();
});

describe('organization bootstrap', () => {
  it('makes the creator admin of the new org', async () => {
    const rows = await withRls(alice, {}, (tx) =>
      tx
        .select()
        .from(schema.membership)
        .where(eq(schema.membership.orgId, orgA.id)),
    );
    const me = rows.find((r) => r.userId === alice.sub);
    expect(me?.role).toBe('admin');
  });
});

describe('cross-tenant reads return nothing', () => {
  it('each admin lists only their own organization', async () => {
    const aSees = await withRls(alice, {}, (tx) =>
      tx.select({ id: schema.organization.id }).from(schema.organization),
    );
    const bSees = await withRls(bob, {}, (tx) =>
      tx.select({ id: schema.organization.id }).from(schema.organization),
    );
    expect(aSees.map((r) => r.id)).toContain(orgA.id);
    expect(aSees.map((r) => r.id)).not.toContain(orgB.id);
    expect(bSees.map((r) => r.id)).toContain(orgB.id);
    expect(bSees.map((r) => r.id)).not.toContain(orgA.id);
  });

  it('a direct primary-key probe of another org returns zero rows, not an error', async () => {
    const probe = await withRls(bob, {}, (tx) =>
      tx
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, orgA.id)),
    );
    expect(probe).toHaveLength(0); // existence must not leak either
  });

  it('memberships of another org are invisible', async () => {
    const probe = await withRls(bob, {}, (tx) =>
      tx
        .select()
        .from(schema.membership)
        .where(eq(schema.membership.orgId, orgA.id)),
    );
    expect(probe).toHaveLength(0);
  });

  it("another org's audit trail is invisible", async () => {
    const probe = await withRls(bob, {}, (tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgA.id)),
    );
    expect(probe).toHaveLength(0);
  });

  it('the member-listing RPC returns nothing for non-members', async () => {
    const probe = await withRls(bob, {}, (tx) =>
      tx.execute(sql`select * from public.org_members(${orgA.id}::uuid)`),
    );
    expect([...(probe as unknown as unknown[])]).toHaveLength(0);
  });

  it('an authenticated user with no memberships sees nothing at all', async () => {
    const orgs = await withRls(mallory, {}, (tx) =>
      tx.select().from(schema.organization),
    );
    const memberships = await withRls(mallory, {}, (tx) =>
      tx.select().from(schema.membership),
    );
    const audit = await withRls(mallory, {}, (tx) =>
      tx.select().from(schema.auditLog),
    );
    expect(orgs).toHaveLength(0);
    expect(memberships).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
});

describe('cross-tenant writes are rejected or affect zero rows', () => {
  it('direct INSERT into organization is denied — creation is RPC-only', async () => {
    await expectDbError(
      withRls(bob, { reason: 'attack: raw insert' }, (tx) =>
        tx
          .insert(schema.organization)
          .values({ name: 'Raw', slug: `raw-${run}` }),
      ),
      /permission denied|row-level security/,
    );
  });

  it("cannot update another org's row", async () => {
    const updated = await withRls(
      bob,
      { reason: 'attack: rename org A' },
      (tx) =>
        tx
          .update(schema.organization)
          .set({ name: 'Owned' })
          .where(eq(schema.organization.id, orgA.id))
          .returning(),
    );
    expect(updated).toHaveLength(0);
    const [check] = await admin`
      select name from organization where id = ${orgA.id}`;
    expect(check.name).toBe('NSO Atlantis');
  });

  it('cannot insert a membership into another org', async () => {
    await expectDbError(
      withRls(bob, { reason: 'attack: join org A' }, (tx) =>
        tx.insert(schema.membership).values({
          orgId: orgA.id,
          userId: bob.sub,
          role: 'admin',
        }),
      ),
      /row-level security/,
    );
  });

  it("cannot delete another org's membership rows", async () => {
    const deleted = await withRls(bob, { reason: 'attack: purge org A' }, (tx) =>
      tx
        .delete(schema.membership)
        .where(eq(schema.membership.orgId, orgA.id))
        .returning(),
    );
    expect(deleted).toHaveLength(0);
  });

  it('non-admins cannot use the add-member RPC', async () => {
    await expectDbError(
      withRls(bob, { reason: 'attack: rpc into org A' }, (tx) =>
        tx.execute(
          sql`select public.add_member_by_email(${orgA.id}::uuid, ${`bob-${run}@b.test`}, 'admin'::org_role)`,
        ),
      ),
      /only organization admins/,
    );
  });
});

describe('role enforcement inside a tenant', () => {
  it('a viewer cannot update the organization', async () => {
    const updated = await withRls(ana, { reason: 'viewer edit' }, (tx) =>
      tx
        .update(schema.organization)
        .set({ name: 'Renamed by viewer' })
        .where(eq(schema.organization.id, orgA.id))
        .returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('a viewer cannot grant memberships', async () => {
    await expectDbError(
      withRls(ana, { reason: 'viewer invite' }, (tx) =>
        tx.execute(
          sql`select public.add_member_by_email(${orgA.id}::uuid, ${`mallory-${run}@m.test`}, 'viewer'::org_role)`,
        ),
      ),
      /only organization admins/,
    );
  });

  it('a viewer can still read their org', async () => {
    const orgs = await withRls(ana, {}, (tx) =>
      tx.select().from(schema.organization),
    );
    expect(orgs.map((o) => o.id)).toContain(orgA.id);
  });
});

describe('audit trail (non-negotiable 2)', () => {
  it('recorded who, what and why for the org creation', async () => {
    const rows = await withRls(alice, {}, (tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgA.id)),
    );
    const orgInsert = rows.find(
      (r) => r.tableName === 'organization' && r.action === 'INSERT',
    );
    expect(orgInsert).toBeDefined();
    expect(orgInsert?.actorId).toBe(alice.sub);
    expect(orgInsert?.reason).toBe(`test: create atlantis-${run}`);
    const bootstrap = rows.find(
      (r) => r.tableName === 'membership' && r.action === 'INSERT',
    );
    expect(bootstrap).toBeDefined();
  });

  it('rejects audited writes that carry no reason', async () => {
    // An UPDATE alice is fully entitled to make — the only thing missing is
    // the reason, so the audit trigger must be what rejects it.
    await expectDbError(
      withRls(alice, {}, (tx) =>
        tx
          .update(schema.organization)
          .set({ name: 'Renamed without reason' })
          .where(eq(schema.organization.id, orgA.id)),
      ),
      /requires app\.reason/,
    );
    const [check] = await admin`
      select name from organization where id = ${orgA.id}`;
    expect(check.name).toBe('NSO Atlantis');
  });

  it('is append-only even for privileged connections', async () => {
    await expect(
      admin`update audit_log set reason = 'tampered' where org_id = ${orgA.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      admin`delete from audit_log where org_id = ${orgA.id}`,
    ).rejects.toThrow(/append-only/);
  });
});

describe('connection-role hygiene', () => {
  it('the anon role has no access to tenant tables', async () => {
    await expect(
      admin.begin(async (tx) => {
        await tx`set local role anon`;
        await tx`select * from organization`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('withRls really runs as the authenticated role', async () => {
    const rows = await withRls(alice, {}, (tx) =>
      tx.execute(sql`select current_user as role`),
    );
    expect((rows as unknown as { role: string }[])[0].role).toBe(
      'authenticated',
    );
  });
});
