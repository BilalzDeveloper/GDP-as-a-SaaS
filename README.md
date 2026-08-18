# GDP-as-a-SaaS

Multi-tenant SaaS for compiling Gross Domestic Product under the UN System of
National Accounts (SNA 2008): National Statistical Offices and researchers
upload source data, map it to standard classifications, and compute GDP by all
three approaches with full audit trails and reproducible vintages.

**Status: milestone 1 (Foundations) complete, pending a live deployment.**
Auth, organizations, roles, the audit trail and Row-Level Security are in
place, with an adversarial two-tenant isolation suite (20 tests) running in
CI. No compilation features yet — those start at milestone 3.

## Documentation

- [`PLAN.md`](PLAN.md) — stack assessment, risk analysis, fixture choice,
  milestone plan
- [`db/schema-proposal.sql`](db/schema-proposal.sql) — the full milestone 1–3
  schema design (milestone 1's part is live in `supabase/migrations/`)
- [`DECISIONS.md`](DECISIONS.md) — append-only record of methodological and
  architectural choices
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — Supabase + Vercel setup (needs owner
  credentials)
- [`CLAUDE.md`](CLAUDE.md) — the original project brief

## Layout

```
src/app/            Next.js App Router pages and server actions
src/db/rls.ts       the ONE tenant-scoped database path — see below
src/db/schema.ts    Drizzle mirror of the SQL schema
src/lib/supabase/   auth clients (sessions only, never tenant data)
supabase/migrations/  SQL migrations — the source of truth for the schema
tests/rls/          adversarial tenant-isolation suite
```

## Tenant isolation

Every tenant query goes through `withRls()` in `src/db/rls.ts`, which opens a
transaction, installs the verified JWT claims, sets the audit reason, and
drops to the low-privilege `authenticated` role before any query runs. Nothing
in app runtime may query tenant tables any other way. Policies use
`FORCE ROW LEVEL SECURITY`, so even the table owner is subject to them, and
the `service_role` key never enters app runtime environment.

## Local development

```bash
npm install
cp .env.example .env      # fill in from your Supabase project
npm run dev
```

## Tests

The isolation suite needs a Postgres. Locally:

```bash
bash scripts/test-db.sh   # starts a throwaway cluster, applies shim + migrations
DATABASE_URL=postgresql://postgres:postgres@localhost:54329/gdp_test npm test
```

`tests/rls/shim.sql` recreates the Supabase preconditions (the `auth` schema,
`auth.uid()`, the `anon`/`authenticated` roles) on plain Postgres. Never apply
it to a real Supabase project.
