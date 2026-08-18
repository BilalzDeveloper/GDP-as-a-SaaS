# Engine fixtures

Every fixture declares its `provenance`. Two values matter:

| `provenance` | Meaning |
|---|---|
| `synthetic` | Constructed for this repository. Tests the engine's internal consistency and arithmetic. Proves nothing about agreement with published national accounts. |
| `official` | Transcribed from a named published source, with the table or page cited per figure. |

**Everything here today is `synthetic`.** That is a real gap, and it is the
one thing milestone 3 could not close.

## Why there is no official fixture yet

The plan named two: the SNA 2008 manual's integrated numerical example as the
primary fixture, and Statistics Denmark's published accounts as a real-world
cross-check. Neither could be obtained — this environment's network policy
denies `unstats.un.org`, `dst.dk` and `ec.europa.eu` alike.

The planning document also quoted a GDP figure of 1,854 for the SNA example.
That figure was recalled, not verified, and **must not be used as a fixture**.
Building an "official" test around a remembered number would produce a suite
that looks authoritative and proves nothing — the precise failure this
product cannot afford, since a statistician checking against the manual would
find it immediately.

## What the synthetic fixtures do establish

- The three approaches agree exactly when fed mutually consistent inputs, and
  the statistical discrepancy is zero rather than merely small.
- The identities hold: `B.1g = P.1 − P.2`, GDP = ΣB.1g + D.21 − D.31, and the
  expenditure and income identities in full.
- Sign conventions are right: imports and subsidies reduce GDP, negative
  changes in inventories reduce it, and the engine catches double-negated
  inputs.
- FISIM behaves as SNA 2008 requires: the intermediate portion is GDP-neutral,
  the final-use portion raises GDP, and the unallocated variant contributes
  nothing.
- Results are invariant to industry count and ordering, so a 10-industry
  aggregate and a 400-industry compilation take the same code path.

What they cannot establish is that our reading of the standard matches an
actual national accounts publication. Only an official fixture does that.

## Adding an official fixture

1. Obtain the source (the SNA 2008 manual's example tables, or a small
   country's published accounts — Denmark remains a good choice: all three
   approaches published, English documentation, annual-overlap chain-linking
   for milestone 6).
2. Add a JSON file alongside these with `"provenance": "official"`, a `source`
   naming the publication, table and retrieval date, and a `citations` object
   mapping each figure to where it came from.
3. Add it to the fixture-driven test in `tests/engine/fixtures.test.ts`, which
   already runs every fixture in this directory through the engine.
4. If the engine disagrees with the published figures, **the engine is wrong
   until proven otherwise.** Record the resolution in `DECISIONS.md`.

Until step 4 has been done at least once against a real publication, the
engine should be described as internally consistent, not as validated.
