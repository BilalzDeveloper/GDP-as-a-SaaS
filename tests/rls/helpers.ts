// Helpers for the RLS isolation suite. `admin` is a privileged connection
// used only to seed auth.users and inspect state — the code under test always
// goes through withRls(), the exact path production uses.
import postgres from 'postgres';

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
