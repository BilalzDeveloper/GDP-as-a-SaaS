import { sql } from 'drizzle-orm';
import { withRls, closeDb } from './src/db/rls';
import { admin, claimsFor, createOrg, createTestUser } from './tests/rls/helpers';
import { executeRun } from './src/compile/execute';

const run = 'dbg' + Date.now().toString(36);
const alice = claimsFor(await createTestUser(`${run}@a.test`), 'alice');
const orgA = await createOrg(alice, 'Dbg', run);
await withRls(alice, { reason: 'p' }, (tx) => tx.execute(sql`
  insert into reference_period (org_id, frequency, start_date, end_date, label, fiscal_year)
  values (${orgA.id}::uuid, 'annual', '2023-01-01', '2023-12-31', '2023', 2023)`));
const vid = await withRls(alice, { reason: 'v' }, async (tx) => {
  const r = (await tx.execute(sql`insert into data_vintage (org_id, name) values (${orgA.id}::uuid, 'v') returning id`)) as any;
  return r[0].id;
});
const rid = await withRls(alice, { reason: 'r' }, async (tx) => {
  const r = (await tx.execute(sql`insert into compilation_run (org_id, name, frequency, input_vintage_id) values (${orgA.id}::uuid, 'r', 'annual', ${vid}::uuid) returning id`)) as any;
  return r[0].id;
});
// put one observation in
await withRls(alice, { reason: 'o' }, async (tx) => {
  const [p] = (await tx.execute(sql`select id from reference_period where org_id = ${orgA.id}::uuid`)) as any;
  const s = (await tx.execute(sql`insert into time_series (org_id, transaction_code, price_basis, frequency, unit_code) values (${orgA.id}::uuid, 'D.21', 'current', 'annual', 'NC_MN') returning id`)) as any;
  await tx.execute(sql`insert into observation (org_id, series_id, period_id, vintage_id, value) values (${orgA.id}::uuid, ${s[0].id}::uuid, ${p.id}::uuid, ${vid}::uuid, 100)`);
});
try {
  const out = await executeRun(alice, orgA.id, rid);
  console.log('OK', out);
} catch (e: any) {
  console.log('FAILED:', e.message);
  console.log('cause:', e.cause?.message ?? '(none)');
}
await closeDb(); await admin.end();
