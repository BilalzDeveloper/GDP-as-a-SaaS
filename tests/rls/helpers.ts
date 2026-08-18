// Helpers for the database test suites. `admin` is a privileged connection
// used only to seed auth.users and inspect state — the code under test always
// goes through withRls(), the exact path production uses.
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { withRls, type RlsClaims } from '../../src/db/rls';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:54329/gdp_test';

// The app's db client reads DATABASE_URL at first use; pin it for the suite.
process.env.DATABASE_URL = TEST_DATABASE_URL;

export const admin = postgres(TEST_DATABASE_URL, {
  max: 1,
  prepare: false,
  onnotice: () => {},
});

export async function createTestUser(email: string): Promise<string> {
  const [row] = await admin`
    insert into auth.users (email) values (${email})
    on conflict (email) do update set email = excluded.email
    returning id
  `;
  return row.id as string;
}

export function claimsFor(userId: string, email: string) {
  return { sub: userId, role: 'authenticated' as const, email };
}

/** Create an organization through the production RPC and return id + slug. */
export async function createOrg(
  claims: RlsClaims,
  name: string,
  slug: string,
): Promise<{ id: string; slug: string }> {
  return withRls(claims, { reason: `test: create ${slug}` }, async (tx) => {
    const rows = (await tx.execute(
      sql`select id, slug from public.create_organization(${name}, ${slug})`,
    )) as unknown as { id: string; slug: string }[];
    return rows[0];
  });
}

/**
 * Drizzle wraps database errors (the PostgresError sits in `cause`); assert
 * the underlying database message so tests fail loudly on the wrong error.
 */
export function dbMessage(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } };
  return err?.cause?.message ?? err?.message ?? String(e);
}
