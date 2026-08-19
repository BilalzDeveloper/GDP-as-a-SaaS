# Review and publication

Milestone 7: the path a figure takes from computed to published, and the
formats it leaves in.

```
computed → under_review → approved → published
                 ↓
        (changes requested, back to computed)
```

Every transition is a `SECURITY DEFINER` RPC rather than a bare UPDATE,
because each carries a rule a policy alone cannot express: who may make it,
what state the run must be in, and what must be true of the vintage.

## Who can do what

| Transition | Who | Rule |
|---|---|---|
| Submit for review | compiler, admin | The run must be `computed` and have results |
| Approve / request changes | reviewer, admin | The run must be `under_review` |
| Publish | admin | The run must be `approved` and its vintage frozen |

**Nobody can review their own run.** Separation of duties is the reason the
`reviewer` role exists; an NSO answering to a parliament needs it to be more
than a convention, so it is a database check, not UI politeness. The case that
matters is an admin — who can both create and review — and the test suite
covers it. A reviewer cannot create runs at all, which the RLS write policy
already enforced.

**A review must carry a note.** An approval with no reasoning is not a record
anyone can audit later, so the column is `not null` with a non-empty check.

## Approval freezes the inputs

Approving sets `frozen_at` on the run's input vintage. That is the point of
approval: from there the observations are immutable at the database level
(migration 0003's trigger), so what was reviewed is what gets published. A
revision goes into a new vintage and a new run.

Publication then requires a frozen vintage — a check constraint has demanded
that since migration 0003, and approval has already satisfied it.

## Embargo

An embargo is a release timestamp. The working assumption, first stated as
PLAN.md open question 1 and now implemented:

> Organization members can see pre-release figures — compiling them is the
> job. The embargo governs release to anyone else.

So members can still view and export an embargoed run, and **every export is
stamped** until the embargo lifts: SDMX-CSV gets a leading
`#EMBARGOED UNTIL … — NOT FOR RELEASE` line, and the Excel workbook opens on a
bright red `EMBARGOED` sheet. The CSV comment is deliberately not valid
SDMX-CSV: a parser that rejects it is doing the right thing, because an
embargoed extract should not load silently into a public database.

If you would rather viewers were blocked entirely before release, say so — it
is a one-line change in the export service, and the assumption above is still
just an assumption.

## Exports

Both formats carry the run's full provenance: input vintage, freeze time,
pinned engine version and method configuration, execution and publication
timestamps, and the SHA-256 of every source file behind the figures. A
recipient can therefore tell exactly what they are holding.

`GET /orgs/<slug>/runs/<id>/export/sdmx-csv`
`GET /orgs/<slug>/runs/<id>/export/xlsx`

Both read through `withRls()`, so an export can only ever contain data the
requesting user is entitled to see. Another tenant's run is not "forbidden" —
it does not exist as far as the query is concerned.

### SDMX-CSV: which variant, and an honest caveat

The exporter writes **SDMX-CSV 2.0** (the format accompanying SDMX 3.0): a
`STRUCTURE` / `STRUCTURE_ID` / `ACTION` prefix, then dimension columns, then
`OBS_VALUE`.

**Conformance has not been verified.** The implementation follows the format
as documented, but it has not been checked against an official SDMX validator
or a receiving institution's parser, because this environment has no network
access to reach one. Treat the output as *SDMX-CSV shaped* until somebody
validates it.

To close this out: take an exported file to the SDMX Global Registry's
validator (or your recipient's own intake), and if it rejects anything, fix
the exporter and record what changed in `DECISIONS.md`. This is the same rule
applied to the classification seeds and the engine fixtures — shipping
something labelled as a standard that has never been checked against the
standard is how a product loses an NSO's trust.

### Excel

One sheet per price basis, plus a `Provenance` sheet. Chain-linked sheets
carry the non-additivity note beside the figures, for the same reason the run
page does: the alternative is a support ticket.

Missing observations stay empty cells. A blank is not a zero, and writing one
as the other fabricates data.
