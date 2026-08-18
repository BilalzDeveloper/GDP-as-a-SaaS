// The single tenant-scoped database path (PLAN.md, stack challenge 1).
//
// Every tenant query runs inside a transaction that (1) installs the verified
// JWT claims where RLS policies and auth.uid() read them, (2) sets the audit
// reason when writing, and (3) drops to the low-privilege `authenticated`
// role. SET LOCAL/set_config(..., true) are transaction-scoped, so this is
// safe under Supavisor transaction-mode pooling. Nothing in app runtime may
// query tenant tables outside withRls().
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema';

export type RlsClaims = {
  /** auth.users.id of the verified user (JWT `sub`). */
  sub: string;
  role: 'authenticated';
  email?: string;
};

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

let client: ReturnType<typeof postgres> | undefined;
let db: Db | undefined;

function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    // prepare:false — required in transaction-mode pooling (Supavisor).
    client = postgres(url, { prepare: false, max: 4 });
    db = drizzle(client, { schema });
  }
  return db;
}

export interface WithRlsOptions {
  /**
   * Required for any write to an audited table: recorded as audit_log.reason.
   * The database rejects audited writes when it is absent.
   */
  reason?: string;
}

export async function withRls<T>(
  claims: RlsClaims,
  options: WithRlsOptions,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const claimsJson = JSON.stringify(claims);
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select
        set_config('request.jwt.claims', ${claimsJson}, true),
        set_config('request.jwt.claim.sub', ${claims.sub}, true),
        set_config('app.reason', ${options.reason ?? ''}, true)`,
    );
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}

/** Test-only: close the pool so vitest can exit cleanly. */
export async function closeDb(): Promise<void> {
  await client?.end();
  client = undefined;
  db = undefined;
}

export { schema };
