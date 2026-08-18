// Applies supabase/migrations/*.sql in filename order, tracking applied
// migrations in public._migrations. Used by CI and local test databases;
// against a real Supabase project you can equally use `supabase db push`.
// Runs with a privileged (migration) connection — never from app runtime.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const dir = new URL('../supabase/migrations', import.meta.url).pathname;
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

try {
  await sql`create table if not exists public._migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await sql`select name from public._migrations`).map((r) => r.name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into public._migrations (name) values (${file})`;
    });
    console.log(`applied ${file}`);
  }
  console.log('migrations up to date');
} finally {
  await sql.end();
}
