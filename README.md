# GDP-as-a-SaaS

Multi-tenant SaaS for compiling Gross Domestic Product under the UN System of
National Accounts (SNA 2008): National Statistical Offices and researchers
upload source data, map it to standard classifications, and compute GDP by all
three approaches with full audit trails and reproducible vintages.

**Status: all eight milestones complete, pending a live deployment.**

- **Foundations** — auth, organizations, roles, the audit trail and Row-Level
  Security enforced in the database.
- **Reference data** — ISIC, CPC, COICOP, COFOG and the SNA institutional
  sectors, with a tenant mapping layer for national adaptations.
- **Calculation engine** — all three GDP approaches at current prices, pure
  and dependency-free, every function citing what it implements.
- **Data intake** — CSV/XLSX upload, column mapping, validation and staged
  commit into append-only vintages.
- **Compilation workflow** — runs that pin their vintage and method version,
  execute the engine, report the discrepancy between approaches, and drill
  down from an aggregate to the source records behind it.
- **Volume measures** — deflation, Laspeyres/Paasche/Fisher indices, and
  chain-linking by annual overlap.
- **Review and publication** — reviewer approval with separation of duties,
  vintage freezing, embargo, and SDMX-CSV and Excel export.
- **Quarterly accounts** — quarterly compilation benchmarked to the annual
  accounts by the Denton method, with the reconciliation stored and the
  extrapolated quarters flagged.

456 tests run in CI.

Three caveats worth knowing before relying on output, each marked in the data
or the code rather than only here: the classification seeds are transcribed
rather than downloaded ([`docs/reference-data.md`](docs/reference-data.md)),
the engine is internally consistent but not yet validated against published
national accounts ([`docs/engine.md`](docs/engine.md)), and SDMX-CSV
conformance has not been checked against an official validator
([`docs/publication.md`](docs/publication.md)). All three need network access
to close.

## Documentation

- [`PLAN.md`](PLAN.md) — stack assessment, risk analysis, fixture choice,
  milestone plan
- [`db/schema-proposal.sql`](db/schema-proposal.sql) — the full milestone 1–3
  schema design (milestone 1's part is live in `supabase/migrations/`)
- [`DECISIONS.md`](DECISIONS.md) — append-only record of methodological and
  architectural choices
- [`docs/reference-data.md`](docs/reference-data.md) — classification
  provenance, loading the official UN files, the mapping layer
- [`docs/engine.md`](docs/engine.md) — the calculation engine: identities,
  conventions, methodological variants, and what validation remains
- [`docs/data-intake.md`](docs/data-intake.md) — file formats, number
  conventions, the mapping model, every validation rule, staging and commit
- [`docs/compilation.md`](docs/compilation.md) — runs, method pinning, what
  the assembler refuses to guess, results and drill-down
- [`docs/volume-measures.md`](docs/volume-measures.md) — index formulas,
  chain-linking, and why chained volumes do not add up
- [`docs/publication.md`](docs/publication.md) — the review workflow, who can
  do what, embargo handling and the export formats
- [`docs/quarterly-accounts.md`](docs/quarterly-accounts.md) — quarterly
  compilation, why benchmarking exists, the Denton variants, and what is
  deliberately not done (seasonal adjustment)
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
seeds/              reference data as CSV (classifications, codes, countries)
scripts/            migrations, seeding, official-file loader, scale spike
src/engine/         pure SNA 2008 calculation engine (no DB, no deps)
src/intake/         upload parsing, column mapping, validation rules
src/compile/        assembler, run execution, quarterly benchmarking
src/export/         SDMX-CSV and Excel exporters
src/components/     the application shell (identity bar, section nav, panels)
tests/rls/          adversarial tenant-isolation suite
tests/reference/    reference-data isolation and seed integrity
tests/engine/       engine identities, invariants, fixtures and purity
tests/intake/       number parsing, xlsx/csv, validation rules, intake end-to-end
tests/compile/      assembler, execution, reproducibility, drill-down,
                    quarterly benchmarking end to end
tests/review/       review workflow, role gating, embargo, exports
```

## Interface

`src/app/globals.css` is the whole visual system: a token block for light,
redefined for dark under both `prefers-color-scheme` and an explicit
`[data-theme]`, then a small component vocabulary built on those tokens —
panels, callouts, pills, severity stripes, the workflow stepper, and numeric
table cells set in a mono face with tabular figures. Fonts are system stacks
by deliberate choice (`DECISIONS.md` D32).

To see every screen without a live database:

```bash
python3 scripts/build-preview.py preview.html
```

It reads `globals.css` at build time and re-scopes it, so the preview cannot
drift from the application it is showing.

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
export DATABASE_URL=postgresql://postgres:postgres@localhost:54329/gdp_test
npm run db:seed           # reference data — the suite asserts against it
npm test
```

`tests/rls/shim.sql` recreates the Supabase preconditions (the `auth` schema,
`auth.uid()`, the `anon`/`authenticated` roles) on plain Postgres. Never apply
it to a real Supabase project.
