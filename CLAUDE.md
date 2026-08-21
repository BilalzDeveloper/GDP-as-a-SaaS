# Claude Code Kickstart Prompt — SNA-Compliant GDP Compilation SaaS

## Project

Build a multi-tenant SaaS web application that lets National Statistical Offices (NSOs) and researchers compile Gross Domestic Product for any country or sub-national territory, following the **UN System of National Accounts (SNA 2008)**.

The core value: an NSO uploads source data (surveys, administrative records, trade statistics, government accounts), maps it to standard classifications, and the system computes GDP by all three approaches with full audit trails and reproducible vintages.

**Do not scaffold the whole application in one pass.** Read the milestones below, then propose a plan and wait for my approval before writing code.

## Non-negotiable requirements

1. **Reproducibility.** Any published GDP figure must be re-computable from stored inputs plus a stored method version. Never mutate historical data in place — use append-only vintages/revisions.
2. **Auditability.** Every value change records who, when, what changed, and why. NSOs are accountable to parliaments and international bodies.
3. **Tenant isolation.** Pre-release GDP estimates are market-sensitive and legally protected in most jurisdictions. Cross-tenant leakage is a catastrophic failure, not a bug.
4. **Classification-driven, not hardcoded.** Countries use different industry breakdowns and detail levels. The engine must work for a 10-industry aggregate and a 400-industry detailed compilation alike.

## Suggested stack (challenge it if you disagree, but justify)

- Next.js (App Router) + TypeScript, React Server Components
- PostgreSQL via Supabase or Neon (both have usable free tiers)
- Drizzle ORM with SQL migrations checked into the repo
- Row-Level Security enforced at the database layer, not only in application code
- Auth: Supabase Auth or Auth.js, with organization membership and roles
- Deployment: Vercel (app) + Supabase/Neon (database), free tier throughout
- Testing: Vitest for the calculation engine, Playwright for critical user flows

## Domain model — get this right first

**Reference data (system-wide, seeded):**
- Classifications: ISIC Rev.4 (activities), CPC Ver.2.1 (products), COICOP (household consumption), COFOG (government function), institutional sectors (S.11 non-financial corporations, S.12 financial corporations, S.13 general government, S.14 households, S.15 NPISH, S.2 rest of world)
- SNA transaction codes (P.1 output, P.2 intermediate consumption, B.1g gross value added, D.21 taxes on products, D.31 subsidies on products, P.3 final consumption expenditure, P.51g gross fixed capital formation, P.52 changes in inventories, P.53 acquisitions less disposals of valuables, P.6 exports, P.7 imports, D.1 compensation of employees, B.2g operating surplus, B.3g mixed income, D.2 taxes on production and imports, D.3 subsidies)
- Countries/territories, currencies, unit-of-measure registry
- Allow tenants to define **custom classification versions and mappings** to the standard codes — many countries use national adaptations (e.g. a national ISIC variant).

**Tenant data:**
- Organizations, users, memberships, roles: `admin`, `compiler`, `reviewer`, `viewer`
- Compilation runs (a named exercise, e.g. "2024 Annual Estimates, first release")
- Reference periods: annual and quarterly, with fiscal-year support (not every country runs a January–December year)
- Source datasets: uploaded files, their provenance, the mapping applied, validation status
- Time series and observations: series keyed by (transaction, activity/product, sector, period, price basis, valuation)
- Price basis: current prices vs previous-year prices vs chain-linked volume
- Valuation: basic prices, producers' prices, purchasers' prices — conversions must be explicit
- Revisions/vintages, with a published-flag and an embargo timestamp

## Calculation engine — the heart of the product

Build this as a **pure, dependency-free TypeScript module** with no database imports. It takes structured inputs and returns structured outputs. This makes it testable and portable.

**Production approach:**
- By activity: Output (P.1) − Intermediate Consumption (P.2) = Gross Value Added (B.1g)
- GDP = Σ GVA at basic prices + Taxes on products (D.21) − Subsidies on products (D.31)
- Handle FISIM allocation, and imputed rent for owner-occupied dwellings

**Expenditure approach:**
- GDP = Household final consumption + NPISH final consumption + Government final consumption + Gross fixed capital formation + Changes in inventories + Acquisitions less disposals of valuables + Exports − Imports

**Income approach:**
- GDP = Compensation of employees + Gross operating surplus + Gross mixed income + Taxes on production and imports − Subsidies

**Cross-cutting:**
- Statistical discrepancy calculation and configurable balancing (which approach is the anchor?)
- Deflation: series-level deflators, Laspeyres/Paasche/Fisher index options
- Chain-linking with the **annual overlap** method; document the non-additivity of chained volumes clearly in the UI, because users will report it as a bug
- Quarterly compilation with benchmarking to annual totals (Denton proportional method)
- Per-capita GDP and growth rates, both period-on-period and year-on-year

**Every function must cite the SNA 2008 paragraph or standard practice it implements in a code comment.** I will be checking these against the manual.

## Milestones — build and let me review in this order

1. **Foundations.** Repo, migrations, auth, organizations, RLS policies, and a test proving one tenant cannot read another's data. Deploy to Vercel with a live URL at this stage, not at the end.
2. **Reference data.** Classification tables seeded from official UN sources, with the tenant-level mapping layer.
3. **Calculation engine.** Pure module, all three approaches, current prices only. Comprehensive unit tests against a worked example — use the published SNA numerical example or a small real country's official accounts as a fixture, and tell me which you chose.
4. **Data intake.** CSV/XLSX upload, column mapping UI, validation rules (balance checks, sign conventions, coverage gaps), staging before commit.
5. **Compilation workflow.** Create a run, attach source data, execute, view results, see the discrepancy between approaches, drill from an aggregate down to contributing source records.
6. **Volume measures.** Deflators, constant prices, chain-linking.
7. **Review and publication.** Reviewer approval step, vintage freezing, embargo, export to SDMX-CSV and Excel.
8. **Quarterly accounts and benchmarking.**

Stop after each milestone. Show me what changed and what you'd do next.

## Working agreement

- Write tests before or alongside the calculation code, never after.
- Prefer boring, obvious implementations over clever ones — statisticians will audit this.
- If a statistical method has legitimate variants, implement the common one, make it configurable, and note the alternatives in the code.
- If a requirement above is ambiguous or you think it's wrong, say so before implementing rather than guessing.
- Keep a `DECISIONS.md` recording methodological choices and why.

## Repo context for sessions

The plan responding to this brief lives in [`PLAN.md`](PLAN.md) (stack
assessment, milestone 1–3 schema in [`db/schema-proposal.sql`](db/schema-proposal.sql),
risk analysis, fixture choice). It was **approved on 2026-08-18** and
**all eight milestones are complete** — see the "Milestone N — delivered"
sections in `PLAN.md`. Recorded choices live in
[`DECISIONS.md`](DECISIONS.md); add to it whenever you make a methodological
or architectural decision.

Working rules for sessions on this repo:

- **The milestones are done; work now is extension or correction.** Three
  caveats are outstanding and are marked in the data and the code, not just in
  prose: classification seeds are transcribed rather than downloaded (D12), the
  engine is internally consistent but has never been checked against published
  national accounts (D16), and the SDMX-CSV output has not been through a
  validator (D31). Removing any of them needs network access this environment
  does not have. Do not quietly drop the caveats.
- **`supabase/migrations/*.sql` is the schema source of truth.** Never edit an
  applied migration; add a new numbered one. Keep `src/db/schema.ts` in sync.
- **All tenant queries go through `withRls()`** (`src/db/rls.ts`). No app
  runtime code may open its own connection or use the `service_role` key.
- **The isolation suite is not optional.** `tests/rls/isolation.test.ts` must
  stay green, and new tenant tables need matching policies and tests in the
  same change.
- Local test database: `bash scripts/test-db.sh`, then
  `DATABASE_URL=... npm test`. See [`README.md`](README.md).
- **The browser suite runs the real stack.** `npm run test:e2e` needs a build
  and the test database; only the identity provider is stubbed
  (`tests/e2e/auth-stub.mjs`, D38). See
  [`docs/end-to-end-tests.md`](docs/end-to-end-tests.md).
- **The engine stays pure.** `src/engine/` imports nothing outside itself —
  no database, no npm dependency, no I/O. `tests/engine/purity.test.ts`
  enforces it. Every function cites the SNA 2008 paragraph or standard
  practice it implements.
