# GDP-as-a-SaaS

Multi-tenant SaaS for compiling Gross Domestic Product under the UN System of
National Accounts (SNA 2008): National Statistical Offices and researchers
upload source data, map it to standard classifications, and compute GDP by all
three approaches with full audit trails and reproducible vintages.

**Current status: planning.** No application code yet, by design — the build
proceeds milestone by milestone with owner review between each.

- [`PLAN.md`](PLAN.md) — stack assessment, risk analysis, fixture choice, and
  the milestone-1 scope awaiting approval
- [`db/schema-proposal.sql`](db/schema-proposal.sql) — proposed schema for
  milestones 1–3, RLS policies included
- [`DECISIONS.md`](DECISIONS.md) — append-only record of methodological and
  architectural choices
