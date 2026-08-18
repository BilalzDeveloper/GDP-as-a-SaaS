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
