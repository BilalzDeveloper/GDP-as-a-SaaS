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
**Superseded in part by D16.** The GDP figure of 1,854 quoted below was
recalled, not verified, and must not be used as a fixture. The choice of
sources stands; the number does not.
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

## D16 — The engine is validated for internal consistency, not against published accounts
**Decision:** Milestone 3 ships with synthetic fixtures only. Every fixture
declares `provenance`, and a test refuses to let a fixture claim `official`
provenance without per-figure citations.
**Why:** Neither planned fixture could be obtained — the network policy denies
`unstats.un.org`, `dst.dk` and `ec.europa.eu`. **This corrects D8 and the
planning document, which quoted the SNA example's GDP as 1,854: that figure
was recalled, not verified, and must not be used as a fixture.** Building an
"official" test around a remembered number produces a suite that looks
authoritative and proves nothing, which is worse than having no official
fixture at all — a statistician checking against the manual would find it
immediately, and rightly stop trusting everything around it.
What the synthetic fixtures do establish: the three approaches agree exactly
on consistent inputs (discrepancy exactly zero, not merely small), the
identities hold, sign conventions are right, FISIM behaves as SNA 2008
requires under both treatments, and results are invariant to industry count
and ordering. What they cannot establish is that our reading of the standard
matches a real publication.
**Consequence:** until an official fixture passes, the engine is described as
internally consistent, never as validated. Loading one is the first task of
milestone 4, and if the engine disagrees with published figures, the engine is
wrong until proven otherwise.
**Alternatives:** transcribing the numbers from memory (rejected above);
delaying the engine until network access exists (blocks everything downstream
for an external dependency with no timeline).

## D17 — The balancing anchor is configurable; the engine never forces agreement
**Decision:** `compileGdp` takes `anchor: 'production' | 'expenditure' |
'income' | 'none'`, defaulting to production when available (and to the sole
approach supplied when only one is). The headline is that approach's estimate;
every other approach is reported with its discrepancy. An explicitly requested
anchor with no matching input is an error, never a silent substitution.
**Why:** There is no universally correct anchor — many NSOs anchor annual
estimates on production, others on expenditure, and some publish a figure
balanced through supply-and-use tables. More importantly, the engine must not
reconcile by adjusting: the statistical discrepancy is the most informative
diagnostic a compiler has, and averaging or forcing agreement would destroy
it. `'none'` exists for compilers who want all three reported with no headline
chosen.
**Alternatives:** hardcoding production (fails the countries that do not);
averaging the approaches (invents a figure no source supports); automatic
supply-and-use balancing (a genuine feature, but it belongs with the
compilation workflow in milestone 5+, not buried in the engine).

## D18 — FISIM allocated by default, unallocated available as a variant
**Decision:** `treatment: 'allocated'` (default) puts the producer-consumed
portion into intermediate consumption — GDP-neutral, since it offsets the
financial corporations' output — and lets the household, government and
export portions raise GDP. `treatment: 'unallocated'` routes the whole of
FISIM to a nominal industry's intermediate consumption so it contributes
nothing.
**Why:** SNA 2008 ch.6 and ch.17 require allocation; the unallocated
convention was permitted under SNA 1993 and is still encountered, so the
working agreement ("implement the common one, make it configurable, note the
alternatives") applies. Interface consequence worth stating: industry
intermediate consumption must be supplied EXCLUDING allocated FISIM, or it is
double-counted. The engine warns when allocations do not exhaust FISIM output
and when FISIM is allocated to an industry that was not supplied.
**Alternatives:** inferring the allocation from industry shares (invents data
the compiler is responsible for); supporting only the SNA 2008 treatment
(unhelpful to anyone migrating an existing compilation).

## D19 — Producers'-price output is refused, not converted silently
**Decision:** `computeProductionApproach` throws when `outputValuation` is
`'producers'`, directing the caller to `basicPricesFromProducers()`.
**Why:** The brief requires valuation conversions to be explicit. The
conversion needs the taxes and subsidies embedded in the output figure, which
the caller has and the engine does not; guessing them would silently
misstate GDP in a way no test on our side would catch.
**Alternatives:** accepting producers' prices and adjusting with the
economy-wide D.21/D.31 totals (wrong whenever the product tax mix differs by
industry, and invisible when it is wrong).

## D20 — Uploaded files are stored in the database, with a 10 MB cap
**Decision:** `source_dataset.file_bytes` holds the uploaded file, capped at
10 MB, rather than an object store.
**Why:** The plan (D1) assumed Supabase Storage, whose bucket policies would
have to mirror our RLS policies. Storing the bytes as a column puts them under
the policies that already exist and that the isolation suite already tests —
`source_dataset` is covered by exactly the same cross-tenant assertions as
every other tenant table. Given that milestone 1's risk analysis singled out
"a storage bucket without policies" as a way tenant isolation fails quietly,
using the mechanism we can actually verify here is the safer trade.
**Trade-off:** free-tier Postgres storage is limited and large files in a
database is not a long-term pattern. The migration path is deliberately open:
`storage_path` semantics can be added alongside `file_bytes`, moving old rows
lazily. Revisit when either the cap or the total becomes a real constraint.
**Alternatives:** Supabase Storage now (correct destination, but bucket
policies are untestable in this environment, so isolation would rest on
review rather than a test); storing only the checksum and discarding the file
(loses the ability to re-parse with a corrected mapping, which is a routine
need).

## D21 — Staging rows carry no foreign keys on source-supplied codes
**Decision:** `staging_row.transaction_code` and `staging_row.unit_code` are
plain text with no foreign key. The resolved `*_item_id` columns keep theirs
and are simply left null when resolution fails.
**Why:** Found by the intake test suite. Staging exists to hold rows that are
WRONG so a compiler can be shown what is wrong with them; a foreign key makes
it impossible to store `transaction code ZZ.9 is not an SNA code`, which is
precisely the message the compiler needs. Validity lives in `is_valid` and
`validation_issue`, and the foreign keys sit on `time_series` and
`observation`, which only ever receive rows that passed validation.
**Alternatives:** storing invalid codes only in the `raw` JSON (the resolved
columns then lie by omission, and every query has to know which is which);
rejecting invalid rows at parse time (defeats the purpose of a review step,
and gives the compiler no list of what to fix).

## D22 — Errors block a commit; warnings never do
**Decision:** `canCommit` requires zero error-severity issues. Warnings and
info are reported and ignored for gating.
**Why:** Several findings are legitimately possible — negative value added in
a bad year, a genuine order-of-magnitude change, a series that really does
stop. A tool that blocks on those trains its users to bypass it, which is
worse than not checking. Errors are reserved for things that would corrupt
data outright: unresolvable codes, unparseable or ambiguous numbers, duplicate
coordinates, mixed units within a series.
**Alternatives:** blocking on warnings with an override (an override that is
always used is just a slower commit button); making everything a warning (then
a typo'd transaction code silently becomes a missing series).
