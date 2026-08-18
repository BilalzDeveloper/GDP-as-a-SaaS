# SNA-Compliant GDP Compilation SaaS — Planning Proposal

Status: **approved 2026-08-18.** Milestones 1–5 are built — see
[Milestone 1](#milestone-1--delivered), [Milestone 2](#milestone-2--delivered),
[Milestone 3](#milestone-3--delivered), [Milestone 4](#milestone-4--delivered)
and [Milestone 5](#milestone-5--delivered) at the end of this document.
Milestones 6–8 stand as planned below.

> **Correction to §4 below.** That section names the SNA 2008 numerical
> example as the engine fixture and quotes its GDP as 1,854. That figure was
> recalled, not verified, and is not used anywhere in the code or tests. The
> choice of sources stands; see [Milestone 3](#milestone-3--delivered) and
> `DECISIONS.md` D16 for what was actually built and what validation remains.

This document answers the four "Start here" questions:

1. [Stack: confirmed, with three challenges](#1-stack-assessment)
2. [Database schema for milestones 1–3](#2-database-schema) — full SQL in
   [`db/schema-proposal.sql`](db/schema-proposal.sql)
3. [The three riskiest parts and de-risking](#3-risk-assessment)
4. [Reference fixture for engine correctness](#4-correctness-fixture)

---

## 1. Stack assessment

**Confirmed as proposed:** Next.js (App Router) + TypeScript + RSC; PostgreSQL;
Drizzle ORM with checked-in SQL migrations; RLS at the database layer; Vercel
deployment; Vitest for the engine, Playwright for critical flows.

**Decision within the proposal: Supabase over Neon.** Three reasons, all tied to
your non-negotiables:

- **Auth → RLS integration.** Supabase Auth issues JWTs whose claims are
  readable inside Postgres policies (`auth.uid()`). With Neon we'd pair Auth.js
  with hand-rolled claim plumbing into the database session — more moving parts
  in exactly the layer where a mistake is a catastrophic failure (requirement 3).
- **Storage.** Milestone 4 needs somewhere to keep uploaded source files with
  the *same* tenant isolation guarantees as the rows. Supabase Storage has
  bucket policies that can mirror our org policies; with Neon we'd add S3 + a
  second authorization model.
- **Local dev.** `supabase start` gives a full local stack (Postgres + Auth +
  Storage) in Docker, so the tenant-isolation test suite runs in CI against a
  real database, not a mock.

**Challenge 1 — Drizzle can silently bypass RLS.** RLS only applies to the role
the connection uses. If the app connects as the table owner or with the
`service_role` key, every policy is skipped without error. Non-negotiable
implementation rules, testable in CI:

- App runtime connects through the pooled connection (Supavisor, transaction
  mode — required on Vercel serverless anyway) as the `authenticated` role,
  never as `postgres`/`service_role`.
- Every tenant-scoped query runs inside a transaction that does
  `SET LOCAL request.jwt.claims = '<verified claims JSON>'` before Drizzle
  queries execute. `SET LOCAL` is transaction-scoped, so it is safe under
  transaction-mode pooling.
- All tenant tables get `FORCE ROW LEVEL SECURITY`, so even an owner-role
  connection cannot bypass policies.
- The `service_role` key exists only in migration/seed scripts, never in any
  environment variable available to app runtime code.

**Challenge 2 — numeric precision needs an explicit policy, not a default.**
Values are stored as `NUMERIC(20,6)` in Postgres. The pure engine uses IEEE-754
doubles internally with a documented rounding-at-publication policy and
tolerance-based test assertions. Rationale: doubles carry ~15–16 significant
digits, comfortably beyond published national-accounts precision, and this is
standard practice in official compilation systems; a decimal library would slow
the engine and complicate the pure-module contract for no auditable benefit.
The alternative (decimal.js throughout) is recorded in `DECISIONS.md` in case
an NSO customer mandates exact decimal arithmetic.

**Challenge 3 — free-tier limits shape milestone 5+, plan for it now.** Vercel
serverless functions cap execution time; a 400-industry compilation run or a
large XLSX parse may not fit in a request/response cycle. The engine being a
pure module keeps our options open (run it in a background job, a queue, or
even client-side for previews), but milestone 5 should assume runs execute
asynchronously with a status field — the schema below already models
`compilation_run.status` accordingly.

## 2. Database schema

Full proposal: [`db/schema-proposal.sql`](db/schema-proposal.sql) — runnable
Postgres/Supabase SQL covering milestones 1–3, with RLS policies inline. It
will be split into numbered Drizzle migrations once approved.

Design decisions embedded in it (details in `DECISIONS.md`):

- **Shared schema, `org_id` on every tenant row, RLS everywhere.**
  Schema-per-tenant was rejected: migration fan-out, free-tier limits, and RLS
  gives us defense-in-depth that per-schema search-path tricks don't.
- **Classifications are data, not enums** (requirement 4). One generic
  structure — `classification` → `classification_version` →
  `classification_item` (hierarchical) — holds ISIC Rev.4, CPC Ver.2.1, COICOP,
  COFOG, *and* institutional sectors. Tenants create their own classifications
  (`owner_org_id` set) and map them to standard versions via
  `classification_mapping_entry`, with weights to support 1-to-many splits.
  A 10-industry aggregate and a 400-industry compilation are just different
  classification versions.
- **A time series is a coordinate, an observation is a fact.** `time_series`
  is keyed by (transaction code, activity item, product item, sector item,
  price basis, valuation, frequency) — dimension columns nullable, uniqueness
  via `UNIQUE NULLS NOT DISTINCT`. `observation` is (series, period, vintage,
  value).
- **Vintages are append-only** (requirements 1–2). Observations belong to a
  `data_vintage`. While a vintage is open, its rows can be corrected; the
  moment it is frozen (`frozen_at` set), a trigger rejects any UPDATE/DELETE on
  its observations. Publication and embargo live on the vintage. Revisions =
  new vintage with `supersedes_vintage_id`. Re-computability = vintage +
  pinned `method_version` (engine semver + full config JSON).
- **Audit is a trigger, not a convention.** A generic row-level trigger writes
  who/when/what-changed to `audit_log`; the "why" comes from
  `set_config('app.reason', …)` which the app layer must set — writes without a
  reason are rejected on audited tables. `audit_log` itself accepts inserts
  only.
- **Periods are org-scoped** because fiscal years vary by country; each org has
  `fiscal_year_start_month`, and `reference_period` rows carry explicit start/
  end dates plus a fiscal-year label.
- **Roles**: `admin`, `compiler`, `reviewer`, `viewer` on `membership`. Write
  policies require compiler/admin; approval transitions will require
  reviewer/admin (enforced in milestone 7's workflow, the column is already
  there).

## 3. Risk assessment

**Risk 1 — tenant isolation fails in an unobvious way.** RLS is easy to enable
and easy to accidentally bypass: a service-role key in the wrong env var, a
`SECURITY DEFINER` helper that leaks, a storage bucket without policies, a
connection that never got the JWT claims set. *De-risk:* the milestone-1
deliverable is an adversarial CI test suite, not just "RLS enabled" — seed two
orgs, authenticate as each, and assert every tenant table and storage path
returns zero cross-tenant rows, including via the exact pooled connection path
production uses. `FORCE ROW LEVEL SECURITY` everywhere; every `SECURITY
DEFINER` function gets a written justification in `DECISIONS.md`. This suite
runs on every PR forever.

**Risk 2 — the engine is subtly wrong.** Chain-linking with annual overlap,
Denton benchmarking, valuation conversions, FISIM allocation — each has
variants and edge cases, our users are professional statisticians, and one
wrong published figure ends the product's credibility. *De-risk:* fixture-first
TDD (tests transcribed from published official numbers *before* implementing —
see §4); every function cites its SNA 2008 paragraph; every methodological
choice with variants goes in `DECISIONS.md` with the alternatives named; every
computed vintage pins the exact `method_version`, so a disputed figure can be
re-run and audited; known-confusing behaviour (non-additivity of chained
volumes) gets explicit UI copy, not a support ticket.

**Risk 3 — the dimensional model is over- or under-engineered.** The same
schema must serve a 10-industry aggregate and a 400-industry detailed
compilation (requirement 4). Hardcoding dimensions fails the requirement;
going fully generic (EAV-style) produces an unqueryable, unindexable swamp and
a drill-down UI that can't perform. *De-risk:* the chosen middle path — fixed,
indexed dimension columns that reference classification *items* — is validated
early: milestone 2 includes a spike seeding one synthetic 400-industry tenant
and one real national ISIC adaptation through the mapping layer, plus
prototype drill-down queries (aggregate → contributing series → source
records) with EXPLAIN output, *before* any UI is built on top.

Honorable mentions (tracked, not top-three): embargo enforcement semantics
(§ open questions), free-tier execution limits (stack challenge 3), and XLSX
parsing memory limits on serverless.

## 4. Correctness fixture

**Primary fixture (milestone 3): the SNA 2008 manual's own integrated numerical
example.** The manual runs one consistent illustrative economy through its
account tables (GDP at market prices = 1,854 in the example's units), with all
three approaches mutually consistent: production (output 3,604 − intermediate
consumption 1,883 + taxes less subsidies on products), expenditure (final
consumption + capital formation + exports − imports), and income (compensation
of employees + operating surplus + mixed income + taxes less subsidies on
production). It's the natural choice because it is *the* reference our users
will check us against, it exercises all three approaches from one input set,
and the discrepancy between approaches is exactly zero by construction — a
sharp test of the engine's internal consistency. The fixture will be
transcribed into a test data file with table/paragraph citations per number.

**Secondary fixture (milestones 3, 6): Denmark's official national accounts**
(Statistics Denmark, StatBank tables, English, machine-readable API). A small,
impeccably documented compiler that publishes all three approaches and
chain-linked volumes using the annual-overlap method — a real-world,
non-round-number cross-check, and later the chain-linking fixture.

**Method-specific fixtures:** IMF *Quarterly National Accounts Manual* (2017)
worked examples for Denton proportional benchmarking (milestone 8); Eurostat
*Handbook on Price and Volume Measures* examples for deflation and
chain-linking edge cases (milestone 6).

## Open questions

Still open, needed before the milestones that depend on them:

1. **Embargo semantics** (needed by milestone 7). Assumption: org members can
   see pre-release vintages (that's their job); the embargo governs
   *publication/export* and any future external sharing. Confirm, or should
   viewer-role users also be blocked pre-embargo?
2. **Quarterly periods under a fiscal year** (milestone 8): aligned to the
   fiscal year (FY-Q1 starts at `fiscal_year_start_month`) — assumed yes.
3. **Custom classifications are private per tenant** (milestone 2) — assumed
   yes (no cross-tenant sharing/marketplace for now).
4. **Provisioning** (blocking the milestone-1 live URL): a Vercel project and
   a Supabase project under accounts you control. Steps in
   [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Milestone 1 — delivered

Built and pushed on `claude/sna-gdp-saas-planning-ubafb4`:

- **Scaffold**: Next.js 15 App Router + TypeScript, Drizzle, `@supabase/ssr`
  auth, production build green (6 routes + middleware).
- **Migration** `supabase/migrations/0001_foundations.sql`: `organization`,
  `membership` (4 roles), append-only `audit_log`, RLS helper functions,
  policies with `FORCE ROW LEVEL SECURITY`, and the three member/org RPCs.
- **The one database path**: `withRls()` in `src/db/rls.ts` — per-transaction
  JWT claims, audit reason, and `SET LOCAL ROLE authenticated`. Nothing in app
  runtime touches tenant tables any other way.
- **UI**: sign-up, sign-in, sign-out, organization list and creation,
  per-organization member list, admin-only add-member-by-email.
- **Isolation suite**: `tests/rls/isolation.test.ts` — 20 tests across four
  users and two organizations, all passing. Cross-tenant reads return zero
  rows (existence never leaks), cross-tenant writes are refused, viewers
  cannot write, the audit trail records who/what/why and rejects writes
  without a reason, `audit_log` is append-only even for the table owner, and
  `withRls` is asserted to actually run as `authenticated`.
- **CI**: `.github/workflows/ci.yml` — Postgres 16 service, shim, migrations,
  typecheck, isolation suite, production build, on every push and PR.

**Not delivered: the live Vercel URL** — blocked on owner credentials (open
question 4). Everything needed is in [`DEPLOYMENT.md`](DEPLOYMENT.md); it is a
~10-minute click-through once the Supabase and Vercel projects exist.

### Deviations from the approved design

Two, both found by the isolation suite and recorded in `DECISIONS.md`:

- **D9** — organizations are created by a SECURITY DEFINER RPC instead of an
  INSERT policy plus a bootstrap trigger. The planned approach cannot work:
  `INSERT ... RETURNING` must also pass the SELECT policy, and the trigger's
  membership row does not exist yet at RETURNING time. `db/schema-proposal.sql`
  has been corrected to match.
- **D11** — the audit trigger records `org_id = new.id` for `organization`
  rows; otherwise a tenant's own creation event would be invisible in its
  audit trail.

## Milestone 2 — delivered

Migration `0002_reference_data.sql`, seeds, loader, spike and tests:

- **Reference tables**: `currency` (52), `country` (209, full ISO 3166-1 shape
  with currency links), `unit` (14, explicit multipliers so a source in
  thousands can never be added to a series in millions), `transaction_code`
  (26, covering every code named in the brief).
- **Classifications as data** (non-negotiable 4): one generic
  classification → version → hierarchical item structure holding ISIC Rev.4
  (21 sections + 88 divisions), CPC Ver.2.1 (10 sections), COICOP 1999 (12
  divisions), COFOG (10 divisions) and the SNA 2008 institutional sectors
  (complete to subsector level).
- **Provenance, recorded honestly** — see the caveat below and
  [`docs/reference-data.md`](docs/reference-data.md).
- **Tenant mapping layer**: weighted 1-to-many entries, a
  `validate_classification_mapping()` query reporting the three problems that
  would corrupt a compilation (weights not summing to 1, unmapped source items,
  entries outside the declared versions), and
  `activate_classification_mapping()` which refuses to activate until the
  mapping is sound.
- **UI**: a classifications page per organization showing each version's
  provenance and true depth, plus mapping status.
- **Tests**: 64 new (84 total, all green) — reference-data isolation across two
  tenants, tenant classifications and mappings invisible to other orgs,
  viewers read-only, shared reference data unwritable by any tenant, the
  cross-version hierarchy guard, mapping validation and activation, provenance
  constraints, and seed-file integrity checked independently of the database.

### Caveat: the seeds are transcribed, not downloaded

This environment's network policy blocks `unstats.un.org`, so the
classifications were transcribed from the published structures rather than
fetched. Every seeded version is therefore marked
`transcribed_pending_verification` in the database and labelled
"awaiting verification" in the UI, and a check constraint prevents any version
claiming `official_file` provenance without a URL, SHA-256 and retrieval date.

`scripts/load-classification.mjs` closes this out: point it at the official
file and it **diffs first**, reporting every name difference and missing code,
and writes only with `--apply`. Verified against a synthetic file containing a
deliberate error — the loader reported it and refused to write. Running it for
ISIC and CPC once you have network access is the first task of milestone 3's
setup, and it is the only way these versions become `official_file`.

Depth is recorded per version (`seeded_to_level`), so nothing implies coverage
that is not there: ISIC is present to division level, not class level.

### Risk-3 spike: result

Ran 25 synthetic tenants × 400 national industries (12,368 classification
items, 12,200 mapping entries), each mapped onto ISIC divisions through the
mapping layer, then measured the queries the compilation UI will run:

| Query | Result |
|---|---|
| Aggregate → contributing national industries | 0.48 ms, index-only, no sequential scans |
| Full national hierarchy (naive self-join) | 2.59 ms, **sequential scan over all 12,368 items** |
| Same hierarchy via `classification_tree()` | 0.58 ms, index scans — 4.5x faster |
| National → ISIC section rollup (400 → 21) | 1.34 ms, no sequential scans |

The finding worth having: a hierarchy self-join that constrains only
`parent.id = child.parent_id` scans every item belonging to *every tenant*, so
its cost grows with the customer count rather than the tenant's own data. The
parent is guaranteed to be in the same version, so constraining
`parent.version_id = child.version_id` restores the index. That is now baked
into `classification_tree()` rather than left to convention (DECISIONS.md D14).
The dimensional model itself needed no change: a 400-industry compilation and a
10-industry aggregate really are just two classification versions.

## Milestone 3 — delivered

`src/engine/` — pure, dependency-free, no database imports, no I/O, no
environment access, enforced by `tests/engine/purity.test.ts` rather than by
review.

- **Production approach** (SNA 2008 ch.6, ch.7): `B.1g = P.1 − P.2` by
  industry; GDP = Σ B.1g at basic prices + D.21 − D.31. Includes FISIM
  allocation and imputed rent for owner-occupied dwellings.
- **Expenditure approach** (ch.9, ch.10, ch.14): the full identity, with
  imports and subsidies supplied positive and subtracted in one place.
- **Income approach** (ch.7): D.1 + B.2g + B.3g + D.2 − D.3.
- **Reconciliation**: statistical discrepancy, configurable balancing anchor
  (`production` default, `expenditure`, `income`, or `none` for no headline).
  The engine never adjusts an estimate to make the approaches agree.
- **Diagnostics** returned rather than thrown: FISIM allocations that do not
  exhaust FISIM output, imputed rent missing from the expenditure side,
  negative value added, pre-negated imports or subsidies, and approaches
  diverging beyond a configurable threshold.
- **Derived measures**: GDP per capita, growth rates (period-on-period and
  year-on-year are the same arithmetic on differently chosen periods),
  annualised rates, and growth contributions that sum to the aggregate rate.
- **93 tests** (177 total, all green): identities, FISIM under both
  treatments, imputed rent, valuation refusal, sign conventions, publication
  rounding, scale from 1 to 1,200 industries, and algebraic invariants
  (homogeneity, additivity, order-independence, antisymmetric discrepancies).

### Caveat: internally consistent, not externally validated

Neither planned fixture could be obtained — the network policy denies
`unstats.un.org`, `dst.dk` and `ec.europa.eu` alike. **The 1,854 figure quoted
in §4 was recalled, not verified, and is used nowhere.** Fixtures therefore
declare `provenance`, everything shipped is `synthetic`, and a test refuses to
let a fixture claim `official` provenance without per-figure citations.

The synthetic fixtures establish that the three approaches agree exactly on
consistent inputs (discrepancy exactly zero, not merely small), that the
identities and sign conventions hold, that FISIM behaves as SNA 2008 requires
under both treatments, and that results are invariant to industry count and
ordering. They cannot establish that our reading of the standard matches a
real publication. Until an official fixture passes, the engine is described as
internally consistent, never as validated — and if it ever disagrees with
published figures, the engine is wrong until proven otherwise.

### Also outstanding: paragraph-level SNA citations

Every function names its SNA 2008 chapter and states the identity it
implements in full, but citations are chapter-level rather than
paragraph-level: the code was written without the manual, and a pinpoint
recalled from memory is exactly what a reader checking the text would catch.
Pinning paragraphs is a review pass with the manual open — the same convention
as `transaction_code.ref_verified` in the database.

## Milestone 4 — delivered

Migration `0003_data_intake.sql` plus `src/intake/`. "Staging before commit"
implies something to commit into, so the observation core lands here too:
milestone 4 is getting data in correctly, milestone 5 computes from it.

- **Upload**: `.csv`/`.tsv` and `.xlsx`/`.xlsm` up to 10 MB, stored with a
  SHA-256 so any committed figure traces to the exact bytes. Identical bytes
  cannot be uploaded twice to one organization. Legacy `.xls` is refused with
  advice rather than an obscure failure.
- **Parsing** treats spreadsheet cells as text rather than trusting Excel's
  type inference, which is what turns ISIC `01` into `1` and a period label
  into a date serial. Formula cells read their cached result; date cells come
  back as ISO; rich text as plain text.
- **Numbers**: grouping separators across locales, accounting negatives
  `(1 234)`, and publication markers for missing data (`:`, `..`, `n/a`, `c`)
  read as **missing, not zero**. `1,234` is *refused as ambiguous* — 1234 or
  1.234 depending on locale, a factor of a thousand — unless the mapping
  declares the separator.
- **Mapping**: columns onto SNA coordinates, resolved against any
  classification version, saved per organization so a recurring extract is
  mapped once.
- **Validation**: nine error rules that block a commit and four warning rules
  that do not, including the balance check (P.2 above P.1), sign conventions
  aligned with the engine, coverage gaps, and a magnitude-jump detector for
  thousands/millions mismatches.
- **Staging and commit**: nothing reaches `observation` without passing
  through staging. Committing writes into an open vintage; frozen vintages
  refuse inserts, updates and deletes at the database level, and can only have
  `published` flipped thereafter.
- **Drill-down** from observation → staging row → source dataset → file
  checksum is in place, which milestone 5 needs.
- **122 new tests** (299 total, green): number parsing including every
  ambiguity case, real `.xlsx` workbooks built with exceljs rather than mocks,
  each validation rule tested for what it catches *and* for staying quiet on
  good data, isolation across all eight new tenant tables, viewer-cannot-write,
  and the frozen-vintage guarantee from four angles.

### Two design corrections found by the tests

- **D21** — `staging_row` had foreign keys on the source-supplied code
  columns, which made it impossible to stage a row whose code was wrong. That
  is precisely the row a compiler needs to see. The foreign keys belong on
  `time_series`/`observation`, which only receive rows that passed.
- **D20** — uploaded files are stored in the database rather than object
  storage, so they fall under the RLS policies the isolation suite already
  tests. Milestone 1's risk analysis named "a storage bucket without policies"
  as a way isolation fails quietly; using the mechanism verifiable here is the
  safer trade, with the migration path left open.

### Still outstanding

The two milestone-3 caveats are unchanged: classification seeds are
transcribed rather than downloaded, and the engine is internally consistent
but not validated against published accounts. Both need network access to the
UN and national sources, still denied here. The Vercel deployment also remains
pending owner credentials.

## Milestone 5 — delivered

Migration `0004_compilation.sql` plus `src/compile/`.

- **Runs** pin their input vintage at creation and their `method_version` —
  engine semver, git SHA, full config — at execution. Those two plus the
  stored observations make any figure re-computable (non-negotiable 1).
  `method_version` rows are immutable; a trigger refuses updates and deletes.
- **Status** moves `draft → computing → computed | failed`, so moving
  execution to a background worker later is a change of caller, not of schema
  (stack challenge 3: Vercel caps function time).
- **The assembler** (`src/compile/assemble.ts`, pure, no database imports)
  turns observations into engine inputs and **withholds an approach rather
  than compiling it short** — see the correction below.
- **Results** are stored long-format `(run, period, approach, measure,
  activity)`, because breakdowns vary by country and a wide table would not
  survive the first customer with a different one. Per-industry rows keep the
  activity link the drill-down walks.
- **The discrepancy is reported, never removed.** The anchor decides the
  headline; every other approach is stored with its gap.
- **Drill-down** from a per-industry aggregate to the observations, the
  staging rows with their file line numbers, and the source file's SHA-256.
- **35 new tests** (334 total, green): the assembler's refusals, end-to-end
  upload → commit → compile, the reproducibility guarantee (re-execution and a
  second run over the same frozen vintage both reproduce the figure exactly),
  drill-down returning the real source rows, and isolation for the four new
  tables including a two-route attempt to fabricate results in another
  tenant's run.

### The design correction worth reading

**D24** — the assembler does not compile an approach whose required
components are missing. A GDP total assembled from an incomplete expenditure
account is not "approximately right": it is wrong by exactly the missing
component and looks entirely plausible in a published table. Withholding it
makes the gap visible. Genuinely optional components (NPISH consumption,
changes in inventories, valuables) are treated as zero with a diagnostic,
because each is genuinely zero or genuinely folded elsewhere in real
compilations.

**D23** — pinning a method version goes through a SECURITY DEFINER RPC. The
first attempt used a plain upsert, which tripped the immutability trigger on
the *second* run to use a given method: the guard was right, the upsert was
wrong.

### Still outstanding

Unchanged: classification seeds are transcribed rather than downloaded, the
engine is not validated against published accounts, and the Vercel deployment
awaits owner credentials.

### Next: milestone 6 (volume measures)

Deflators, constant prices and chain-linking with the annual-overlap method —
including the UI copy about non-additivity of chained volumes, which users
will otherwise report as a bug.
