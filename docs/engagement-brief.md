# Brief — worldwide collaboration, competition, and Rally Mode

*A prompt to paste into a fresh Claude Code session on this repository.*

Everything from the line below to the end of the file is the prompt. It assumes
the session starts with `CLAUDE.md` loaded and the repository checked out, and
it asks for **a plan, not an implementation**.

---

## Your task

I want to make this application enjoyable to use, and informative, for
statisticians anywhere in the world. I want them to be able to **compete or
collaborate on compiling the GDP of the world**, and I want a **Rally Mode**
that pushes a team to get data in faster and more accurately, so that they land
on a GDP that is balanced across all three approaches.

Produce a comprehensive plan for that. **Write no feature code in this session.**
The deliverable is a written plan I will read, argue with, and approve — the same
gate the original brief in `CLAUDE.md` set, and the same one `PLAN.md` went
through on 2026-08-18.

## First, read the ground you are building on

Do not design against your memory of what a statistics product looks like. Read
these before you write a word of plan, because several of them make ideas in
this brief impossible as stated:

- `CLAUDE.md` — the working rules for this repository. All eight original
  milestones are delivered; this is milestone 9 and onward.
- `PLAN.md` — the approved plan and the "Milestone N — delivered" sections.
- `DECISIONS.md` — 51 recorded decisions, D1 through D51. Yours start at **D52**.
- `src/engine/reconcile.ts` — read `compileGdp` and the comment at the top of
  the file in full. It is the single most important file for this brief.
- `src/compile/measures.ts` (the `MEASURE` vocabulary), `src/compile/sources.ts`
  (what every figure was summed from), `src/compile/execute.ts`.
- `src/db/rls.ts` and `supabase/migrations/0001_foundations.sql` — the tenancy
  model, `withRls()`, and the role enum (`admin`, `compiler`, `reviewer`,
  `viewer`).
- `supabase/migrations/0006_review_publication.sql` — the
  `computed → under_review → approved → published` path, `published_at`,
  `embargo_until`, and `run_review`.
- `supabase/migrations/0013_international_benchmarks.sql` and
  `src/insights/benchmarks.ts` — the only cross-country surface that exists
  today, and the only reference table holding figures about other economies.
- `src/intake/validate.ts` — the validation codes (`coverage_gap`,
  `suspicious_magnitude_jump`, `value_added_exceeds_output`,
  `duplicate_coordinate`, and the rest). Rally Mode will almost certainly be
  built on these; know what they actually check.
- `tests/rls/isolation.test.ts` and `tests/engine/purity.test.ts` — the two
  suites that will veto a bad design.

Tell me in your plan which of my assumptions below turned out to be wrong once
you had read the code.

## Four hazards. Resolve each one explicitly before you design a feature

These are not risks to list in a table at the end. Each one can kill a whole
category of design, so settle them first and let the answers shape everything
after.

**1. A leaderboard and tenant isolation are in direct conflict.**
Non-negotiable requirement 3 in `CLAUDE.md` says cross-tenant leakage is a
catastrophic failure, not a bug, because pre-release GDP estimates are
market-sensitive and legally protected in most jurisdictions. A ranking is, by
construction, a channel that carries information out of one tenant and into
another's browser. Even a ranking that shows no figures leaks: *"Office X just
finished compiling Q3"* is itself pre-release information, and a position that
moves on a Tuesday tells you something happened on a Tuesday. Decide what a
competitive surface is allowed to read — published-and-past-embargo vintages
only, non-figure process metadata, a shared fixture dataset that belongs to
nobody, or a dedicated sandbox tenancy — and justify the choice against the
specific leak I just described. If your answer needs a new table, it needs a
policy and a case in `tests/rls/isolation.test.ts` in the same change.

**2. Scoring accuracy by the size of the statistical discrepancy is a trap.**
Read the header comment of `src/engine/reconcile.ts`: the module deliberately
refuses to force the approaches to agree, because "silently averaging would
destroy the very signal a compiler needs." A gap between three independently
sourced approaches is the most informative diagnostic in a compilation. If you
award points for a small discrepancy, you have paid people to make that signal
disappear — by tuning a residual, by anchoring everything on one approach, by
deriving the second approach from the first instead of sourcing it
independently. The `approaches_diverge` warning becomes a thing to suppress
rather than to read. So: how does Rally Mode reward *a well-sourced compilation*
rather than *a tidy-looking one*? Say what a team could do to game each metric
you propose, and what stops them. If a metric cannot be defended, do not propose
it.

**3. Statisticians are accountable to parliaments, and rankings are
reputational.** A national statistician cannot be shown a public table with
their office below another country's. That is not squeamishness; it is a real
constraint on adoption, and it is the difference between a product NSOs use and
one they are forbidden to log into. Work out who is actually competing — an
individual compiler against their own past self, a training cohort, an
anonymous institution, a named volunteer team — and what is opt-in versus
default-off. Consider that the same feature may need to be genuinely fun for a
university class and completely invisible to a central bank.

**4. D16 is still open, and it undercuts any claim of accuracy.** The engine is
internally consistent but has never been checked against published national
accounts. Until that holds, "accuracy" in this product can only mean *internal
consistency, source coverage and validation cleanliness* — never *closeness to
the truth*. Do not let a score imply an authority the system has not earned. The
same goes for D12 (transcribed classification seeds), D31 (unvalidated
SDMX-CSV), and D51 (transcribed benchmarks, `verified = false`). Do not quietly
drop any of them, and do not build a feature whose value proposition depends on
one of them being resolved. Note that D16 also makes a leaderboard against
`benchmark_observation` figures dishonest today, and say what would have to be
true to make it honest.

## What to design

Three strands. Treat them as one product, not three features bolted together.

### Fun and informative, for a statistician

The audience is a professional who will audit this system. "Prefer boring,
obvious implementations over clever ones — statisticians will audit this" is
still the working agreement, and it applies to the interface too. Confetti
insults them; a diagnostic that finally explains *why* the expenditure side is
short does not.

Work out what "fun" actually means here — my guess is mastery, visible progress,
a fast feedback loop, and seeing your own economy in a world context — and
design for that rather than for arcade mechanics. Consider what the existing
surfaces already almost do: `src/app/insights/` puts a compiled figure beside
what the world has published, `src/app/orgs/[slug]/runs/[runId]/` shows the
discrepancy between approaches, and drill-down through `result_source` already
walks from an aggregate to the source records. Something informative and
motivating may be one page away from what exists.

Constraints that bind here: a skin is a palette and nothing else (D50) — five of
them, and anything you add must work in all five and pass
`npm run check:contrast` plus `tests/ui/contrast.test.ts`, WCAG AA and AAA for
Contrast. No badge, animation or celebration may change a figure, a layout or a
piece of text.

### Compete or collaborate on the GDP of the world

Take "the GDP of the world" literally and work out what it would mean to compile
it. World GDP is not a sum of national figures in national currencies. At
minimum you have to face:

- **Conversion.** Market exchange rates or purchasing power parity? They give
  materially different world totals and different country shares, and the choice
  is itself a methodological decision worth a D-entry.
- **The rest of the world sector.** S.2 nets out globally in principle: every
  export is somebody's import. In practice world exports have never equalled
  world imports, and the global current-account asymmetry is a well-known,
  genuinely interesting artifact. A collaborative world compilation that
  *surfaces* that asymmetry is more valuable, and more honest, than one that
  hides it.
- **Coverage and vintage mismatch.** Countries publish on different calendars,
  different fiscal years (already supported), and different revision cycles.
  What does a world total even mean when a third of it is provisional?

Then design the collaboration: how two or more organizations work on a shared
compilation without either one seeing the other's unpublished detail, who owns
the result, how membership and the four roles extend across an organizational
boundary, and how the audit trail stays coherent when the actors are in
different tenants. Reproducibility and append-only vintages apply to a shared
compilation exactly as they do to a national one.

Say plainly whether competition and collaboration are the same surface with a
switch, or two different products that should not be conflated.

### Rally Mode

This is the piece I care most about and the piece most likely to go wrong. My
intent: a focused, time-boxed push where a team gets source data in quickly,
validation clean, and the three approaches close to each other — with the state
of play visible while it happens, so people can see the gap narrowing.

Answer at least these:

- **What is the unit of a rally?** A reference period, a compilation run, a
  fixture exercise, a training scenario? Does it run against real tenant data —
  with everything hazard 1 implies — or against a shared dataset?
- **What is live during a rally, and how does it update?** A live-updating board
  over tenant data is a much bigger commitment than a page you refresh, and it
  is also a much bigger leak surface. Decide, and cost it honestly.
- **What is measured?** Elapsed time to first executed run, share of the
  classification covered, validation errors outstanding by severity, the
  discrepancy trajectory across successive runs — propose the set, and for each
  one write the sentence explaining how a lazy team would cheat it.
- **How does speed not eat accuracy?** Getting figures in fast and getting them
  right pull against each other; that tension is the whole point of the feature.
  Does a rally have a quality gate that a fast-but-dirty run cannot pass? Does
  the reviewer step (`run_review`) participate, or is it out of scope for a
  timed exercise? Note that official statistics already has a name for
  fast-and-provisional — flash estimates — with real methodology behind it, and
  say whether Rally Mode should align with that concept or stay a practice mode.
- **What happens to a rally's output?** A rally run that becomes a published
  vintage is a serious thing. A rally run that is a scratch exercise is not.
  These need different treatment in `compilation_run`, and possibly a status the
  enum does not yet have.

## How to write the plan

- Put it in a new top-level document, and link it from `PLAN.md` and `README.md`
  the way the existing milestone documents are linked. Do not rewrite `PLAN.md`;
  it is the record of work already approved and delivered.
- Break the work into milestones in the style already used here, smallest
  defensible first, each one reviewable on its own, each one ending in something
  I can look at. Say what you would build first if I only approved one
  milestone.
- For each milestone: what changes in the schema (next migration is **0014**;
  never edit an applied one), what changes in `src/engine/` if anything — and
  remember `src/engine/` imports nothing outside itself, enforced by
  `tests/engine/purity.test.ts` — what changes in the app, what tests prove it,
  and what `src/app/help/page.tsx` has to say about it, since the user guide
  ships with the behaviour that changes it (D48).
- Every new measure needs an entry in `src/compile/sources.ts` or it gets no
  drill-down (D47). Every new transaction code needs its `kind` set deliberately
  (D45). Every new tenant table needs an RLS policy and an isolation test in the
  same change.
- Draft the D52-onward entries for the methodological choices — conversion
  basis, what a score means, what a rally's output is — as part of the plan, not
  after the fact.
- Flag anything that needs network access. This environment has none, which is
  why D12, D31 and D51 are still open; a plan that assumes a live data feed
  needs to say so up front rather than fail at implementation time.

## Push back

If part of this brief is wrong, say so before planning around it. I would rather
hear "a public leaderboard cannot be reconciled with requirement 3, here is what
you can have instead" than get a design that technically satisfies both and
serves neither. The working agreement asks you to say when a requirement is
ambiguous or mistaken rather than guess, and that applies to everything above,
including the phrase "Rally Mode" itself if you have a better shape for it.

End with the two or three decisions you most want me to make before you write
any code.
