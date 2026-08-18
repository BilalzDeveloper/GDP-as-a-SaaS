# DECISIONS.md — methodological and architectural choices

Append-only record, per the working agreement. Each entry: the decision, why,
and the alternatives considered. Engine-methodology entries will also cite the
SNA 2008 paragraph or the standard practice implemented.

## D1 — Supabase over Neon
**Decision:** Supabase for Postgres, Auth, and file storage.
**Why:** JWT claims flow natively into RLS policies (`auth.uid()`); uploaded
source files (milestone 4) get tenant isolation from the same policy model via
Storage bucket policies; `supabase start` gives CI a real local stack for the
isolation test suite.
**Alternatives:** Neon + Auth.js (more claim-plumbing in the most
safety-critical layer, separate story needed for file storage).

## D2 — Shared schema multi-tenancy with `org_id` + RLS
**Decision:** One schema; every tenant row carries `org_id`; RLS with
`FORCE ROW LEVEL SECURITY` on all tenant tables.
**Why:** One migration path, works on free tiers, and RLS gives
defense-in-depth independent of application code (non-negotiable 3).
**Alternatives:** schema-per-tenant (migration fan-out, connection-pool and
free-tier hostile); database-per-tenant (out of budget).

## D3 — Numeric handling: NUMERIC at rest, doubles in the engine
**Decision:** Values stored as `NUMERIC(20,6)`. The pure calculation engine
computes in IEEE-754 doubles; tests assert with explicit tolerances; rounding
happens once, at publication/export, per series precision rules.
**Why:** Doubles carry ~15–16 significant digits — beyond published
national-accounts precision — and are standard in official compilation
software; a decimal library complicates the dependency-free pure module for no
auditable gain. Chained-volume non-additivity is methodological, not
floating-point, and is handled as UI messaging (see milestone 6).
**Alternatives:** decimal.js/big.js throughout — revisit if an NSO customer
mandates exact decimal arithmetic; the engine's numeric boundary is isolated
enough to swap.

## D4 — Append-only vintages; freeze makes observations immutable
**Decision:** Observations belong to a `data_vintage`. Open vintages accept
corrections; freezing (`frozen_at`) makes their observations immutable at the
database level (trigger-enforced). Revisions are new vintages linked via
`supersedes_vintage_id`. Publication requires a frozen vintage; embargo lives
on the vintage.
**Why:** Non-negotiables 1–2: any published figure = frozen vintage + pinned
`method_version` (engine semver + config), so it is re-computable and every
change has an audit row with a required reason.
**Alternatives:** temporal tables / full history on every row (heavier, and
the vintage is the natural statistical unit of revision anyway — it matches
how NSOs think about releases).

## D5 — Institutional sectors, COICOP, COFOG are classifications, not enums
**Decision:** One generic classification structure (classification → version →
hierarchical items) covers ISIC, CPC, COICOP, COFOG, and S.11–S.2 sectors;
tenants add national variants and map them to standards with weighted entries.
**Why:** Non-negotiable 4 — a 10-industry and a 400-industry compilation are
just different classification versions; national adaptations are first-class,
not special cases.
**Alternatives:** enum/dedicated tables per classification (simpler queries,
fails the requirement the moment a country's national variant shows up).

## D6 — Series identity is the full dimensional tuple
**Decision:** `time_series` uniqueness = (org, transaction, activity, product,
sector, purpose, price basis, valuation, frequency) with
`UNIQUE NULLS NOT DISTINCT`; unused dimensions are NULL.
**Why:** Fixed, indexable columns keep drill-down queries fast and the model
comprehensible to auditors, while classifications-as-data keeps it flexible.
**Alternatives:** EAV/JSON dimension bags (unindexable, unauditable);
one table per SNA account (hardcodes the very breakdowns that vary by country).

## D7 — SECURITY DEFINER helpers for RLS membership checks
**Decision:** Policy predicates call `private.is_org_member` /
`private.has_org_role`, SECURITY DEFINER, owned by a BYPASSRLS role.
**Why:** Direct subqueries on `membership` inside `membership`'s own policies
recurse. The helpers are the standard Supabase pattern; each is a trivial,
reviewable EXISTS query. Every future SECURITY DEFINER function must get its
own entry here — this is the sharpest tool in the box.
**Alternatives:** duplicating membership into JWT claims (stale-claims problem
on role changes — rejected for a system where roles gate publication).

## D9 — Organizations are created by RPC, not by a direct INSERT
**Decision:** `public.create_organization(name, slug, fiscal_year_start_month)`
(SECURITY DEFINER) inserts the organization and the creator's `admin`
membership in one call. `authenticated` holds no INSERT grant on
`organization`, and there is no INSERT policy.
**Why:** The planned design (permissive INSERT policy + AFTER trigger granting
the creator admin) fails in a way worth recording, because it looks correct
and passes a naive test: `INSERT ... RETURNING` must satisfy the SELECT policy
too, and at RETURNING time the trigger's membership row does not yet exist, so
the whole statement is rejected with "new row violates row-level security
policy". Found by the milestone-1 isolation suite before any UI existed. The
RPC also makes creation atomic and lets us deny raw INSERTs outright, which is
a smaller attack surface — a test now asserts direct INSERT is refused.
**Alternatives:** insert without RETURNING and re-select the row (two
round-trips, still needs the trigger, and the ordering subtlety stays latent);
a BEFORE trigger (cannot insert the membership before the org row exists).

## D10 — Reading member emails goes through a narrow SECURITY DEFINER RPC
**Decision:** `public.org_members(org)` joins `membership` to `auth.users` and
re-checks membership internally; `public.add_member_by_email(org, email, role)`
re-checks the admin role internally. Both are revoked from `public`/`anon` and
granted only to `authenticated`.
**Why:** App roles cannot read `auth.users` (correctly — it would expose every
user on the instance). These two functions are the entire authorized surface
for user-directory access, each a few lines with its own permission check.
**Alternatives:** mirroring emails into a `profiles` table (a second copy of
personal data to keep in sync and protect — rejected for now; revisit if we
need to display members without a round-trip to `auth`).

## D11 — Audit `org_id` for `organization` rows is the row's own id
**Decision:** The audit trigger records `org_id = new.id` when the audited
table is `organization`, and `new.org_id` for every other tenant table.
**Why:** Without it, creating an organization writes an audit row with a null
`org_id`, which the `audit_select` policy then hides from everyone — the
creation of a tenant would be the one event missing from its own audit trail.
Caught by the isolation suite's audit assertions.

## D8 — Correctness fixtures
**Decision:** Milestone 3 primary fixture: the SNA 2008 manual's integrated
numerical example (the consistent illustrative economy in its tables; GDP at
market prices 1,854), transcribed with per-number table citations. Secondary:
Statistics Denmark official accounts (real-world cross-check; later the
chain-linking fixture — Denmark uses annual overlap). Denton benchmarking:
IMF QNA Manual (2017) worked examples. Deflation/chain-linking edge cases:
Eurostat Handbook on Price and Volume Measures.
**Why:** The SNA example is the exact reference users will audit us against
and is internally consistent across all three approaches (zero discrepancy by
construction); Denmark adds non-round real numbers and an English-documented
methodology.
**Alternatives:** a large country (UK/US) — heavier data, methodological
special cases too early.

## D12 — Reference data records its provenance, and seeds are marked unverified
**Decision:** Every `classification_version` carries a `provenance` of
`official_file`, `transcribed_pending_verification` or `tenant_defined`, plus
`source_url`, `source_file_sha256`, `source_retrieved_at` and
`seeded_to_level`. A check constraint (`official_needs_evidence`) forbids
claiming official provenance without the URL, checksum and retrieval date.
Everything shipped in `seeds/` is `transcribed_pending_verification`, and the
UI says so.
**Why:** The development environment's network policy blocks
`unstats.un.org`, so the seeds were transcribed from the published structures
rather than downloaded. An NSO must be able to distinguish data verified
against the official publication from data that merely looks right — silently
presenting transcribed codes as official would be exactly the kind of
unfounded authority this product cannot afford. Recording depth
(`seeded_to_level`) serves the same purpose: ISIC is present to division
level, and nothing should imply it holds classes.
**Alternatives:** waiting for network access before seeding anything (blocks
milestone 3, which needs codes to compile against); seeding silently and
fixing later (the failure mode is a compiler trusting an unverified code).

## D13 — The official-file loader diffs before it writes
**Decision:** `scripts/load-classification.mjs` parses the published UN
structure file, reports new codes, name differences and codes stored but
absent from the file, and exits. It writes only with `--apply`, and applying
stamps provenance, checksum and true depth.
**Why:** The moment the official file arrives it becomes the arbiter, and the
interesting output is the *diff* — that is where a transcription error shows
up. A loader that just upserted would repair the database and destroy the
evidence that our seed file was wrong, leaving the same error to reappear on
the next fresh database. Verified with a synthetic file carrying a deliberate
error: the loader reported it and refused to write.
**Alternatives:** straight upsert (loses the signal); a separate verify
command (two code paths over the same parser, easy to skip).

## D14 — Hierarchy self-joins must constrain both sides by version
**Decision:** Read classification hierarchies through
`classification_tree(version_id)`, which joins `parent.version_id =
child.version_id` as well as `parent.id = child.parent_id`.
**Why:** The parent is guaranteed to be in the same version (enforced by
`classification_item_parent_guard`), but the planner cannot infer that, so the
obvious self-join hash-joins against every item of every tenant. The risk-3
spike measured 3.98 ms with a 12,368-row sequential scan versus 0.59 ms
through the index — a 4.5x gap at 25 tenants that widens linearly as tenants
are added. This is the "drill-down UI can't perform" risk arriving early and
cheaply, exactly where the spike was meant to catch it.
**Alternatives:** documenting the convention and trusting callers (the wrong
version is the easy one to write); a materialised closure table (premature —
revisit if hierarchies get deep enough that recursive walks hurt).

## D15 — COICOP 1999 seeded, not COICOP 2018
**Decision:** The seeded COICOP version is 1999 (12 divisions), as
`COICOP1999`.
**Why:** SNA 2008 is written against COICOP 1999, and this product implements
SNA 2008. COICOP 2018 restructures into 13 divisions and is a genuinely
different classification, not a revision to fold in silently.
**Alternatives:** seeding 2018 instead (mismatches the manual we implement);
seeding both now (no consumer yet — add it as a second
`classification_version` when a tenant needs it, which the model already
supports).
