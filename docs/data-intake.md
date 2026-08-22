# Data intake

Milestone 4: getting source data in correctly. Upload a file, map its columns
onto SNA coordinates, see what is wrong with it, and commit the rows that pass
into observations under a vintage.

The lifecycle is deliberate: **nothing reaches the observation table without
passing through staging**, so a compiler always sees exactly what will be
committed before it is.

```
upload → parse → map → validate → stage → commit → observations (in a vintage)
```

## Files

`.csv` (also `.tsv`, `.txt`) and `.xlsx`/`.xlsm`, up to 10 MB. Legacy `.xls` is
not supported — the error says to re-save as `.xlsx` rather than failing
obscurely.

Spreadsheet cells are converted to text and interpreted by our own parser, not
by Excel's type inference. That inference is what turns the ISIC code `01` into
the number `1` and a period label into a date serial; re-deriving text keeps
the mapping in charge of interpretation. Date cells come back as ISO
(`2023-01-01`), formula cells as their cached result, rich text as plain text.

Each upload stores the file bytes and a SHA-256, so any committed figure can be
traced to the exact bytes it came from. Re-uploading identical bytes to the
same organization is rejected rather than silently duplicated.

## Numbers

Statistical extracts are full of conventions that corrupt figures when read
naively. The parser handles them explicitly:

| Input | Read as | Why |
|---|---|---|
| `1 234 567`, `1'234'567` | 1234567 | Space and apostrophe grouping |
| `1,234.56` / `1.234,56` | 1234.56 | Last separator wins |
| `(1 234)` | −1234 | Accounting negatives |
| `1,25` | 1.25 | Two-digit tail is a decimal |
| `1.234.567` | 1234567 | Repeated separator groups |
| `:`, `..`, `-`, `n/a`, `c`, `x` | **missing, not zero** | Publication conventions for unavailable/confidential |
| `1,234` | **refused as ambiguous** | 1234 or 1.234 depending on locale |

That last row is the important one. `1,234` is 1234 to an English reader and
1.234 to a German one — a factor of a thousand, and the wrong reading looks
entirely plausible in the output table. Rather than guess, the row is rejected
with both interpretations shown, and the mapping's `decimalSeparator` settles
it. `inferDecimalSeparator` proposes a value from a sample when the sample is
decisive, and returns null rather than guess when it is not.

## Mapping

A mapping says which column holds what. `value` and `periodLabel` are always
required; a transaction code can come from a column or be a constant for the
whole file. Dimensions are optional because they are not all meaningful at
once — a household consumption series has a COICOP purpose and no activity.

Classification codes resolve against the version named in the mapping, so the
same file can be loaded against a national classification or a standard one.
Mappings are saved per organization: a recurring monthly extract is mapped
once, not every month.

## Validation

Every rule below exists because it catches something that would otherwise
reach a published figure.

**Errors block the commit:**

| Code | Catches |
|---|---|
| `missing_required_field` | No value, period or transaction code; or a mapping naming a column the file lacks |
| `unknown_transaction_code` | A code that is not an SNA code |
| `unknown_classification_code` | An industry/product/sector code absent from the mapped version |
| `unknown_period` | A period with no matching reference period |
| `unknown_unit` | A unit outside the registry |
| `unparseable_number` | Text where a number belongs |
| `ambiguous_decimal_separator` | The `1,234` problem above |
| `duplicate_coordinate` | Two rows for the same series and period — one would silently overwrite the other |
| `inconsistent_unit` | One series carrying two units — a silent factor-of-1000 error |

**Warnings do not block**, because each is legitimately possible and a
compiler who has checked should not be stopped by the tool:

| Code | Catches |
|---|---|
| `negative_where_positive_expected` | A negative P.1, or a pre-negated import/subsidy that the engine would add back (see `docs/engine.md`, "Signs") |
| `value_added_exceeds_output` | P.2 above P.1 for the same activity and period — occasionally genuine, usually a scale mismatch between two sources |
| `suspicious_magnitude_jump` | A value 50× its neighbour in the same series — the shape of a thousands/millions mismatch |
| `coverage_gap` | A series covering some expected periods and not others — usually a truncated extract |

`blank_value` is informational: a blank is recorded as missing, which is **not**
the same as zero. Treating one as the other fabricates data.

Sign conventions follow the engine: P.52 (changes in inventories), P.53
(valuables) and the balancing items B.1g/B.2g/B.3g are legitimately signed and
are never flagged for being negative.

## Staging and commit

Staged rows hold what the file said, valid or not — including codes that do
not resolve, which is why `staging_row.transaction_code` and `unit_code` carry
no foreign keys (DECISIONS.md D21). Re-staging replaces the previous attempt
wholesale, so a compiler can adjust the mapping and re-validate freely.

Committing writes observations into an **open** vintage, creating series as
needed. Once a vintage is frozen its observations are immutable at the
database level: inserts, updates and deletes are all refused, and the vintage
itself can only have its `published` flag changed thereafter. Revisions go
into a new vintage. That is what makes a published figure reproducible
(non-negotiable 1).

Every committed observation keeps a link back to its staging row and source
dataset, so the drill-down from an aggregate to the contributing source
records — milestone 5's requirement — is already possible.

## Reference periods come first

Periods are defined per organization because fiscal years differ by country. A
file whose period labels do not match any defined period will fail validation
with `unknown_period` on every row, so define periods before the first upload.

## Institutional sectors

Final consumption is the one part of the expenditure account where the same
transaction is told apart by *who* did it. Map the sector column and choose a
sector classification version — the seeded `SNA_SECTOR` covers S.1 through
S.2 with their sub-sectors — and consumption resolves to the right component:

| Sector | Component |
|---|---|
| S.14 households (and S.141–S.144) | Household final consumption |
| S.15 NPISH | NPISH final consumption |
| S.13 general government (and S.1311–S.1314) | Government final consumption |

Any of P.3, P.31 and — for government — P.32 may carry it. Sub-sectors roll up
to the sector that owns them, so a compilation keeping central, state and
local government separately still produces one government figure.

A compilation that keeps no sector dimension is fully supported: leave the
column unmapped and the transaction code resolves it, but only where the code
names a sector unambiguously — **P.31** for households, **P.32** for
government. Two consequences follow, and both are reported rather than
guessed at:

- **An unqualified `P.3` is not read as any sector's consumption.** With no
  sector it is households, NPISH and government together, so reading it as
  government's double-counts it against the household figure beside it.
- **`P.32` alone understates government consumption.** It is collective
  consumption only; government also provides individual services to
  households, chiefly health and education. The figure is used and the
  shortfall stated. File against S.13 to have both parts counted.

Supplying both a sector split and a total-economy figure for the same sector
is refused outright: one is a double count and the other a residual, and only
the compiler knows which.

### Production rows can carry a sector too

Where `P.1` and `P.2` rows carry an institutional sector as well as an
activity, the run compiles a second cut of value added by sector (D49). It is
value added only — taxes on products are not attributable to a sector — and it
is computed before the FISIM and imputed-rent adjustments, which have no
sector to go to. Partial coverage is reported rather than published as though
it were complete.

## Supplying FISIM and imputed rent

Two production-side adjustments are supplied as ordinary observations, on
codes this system defines rather than lifts from the manual (D45). They are
marked `kind = 'adjustment'` in `transaction_code`, and the engine applies
them rather than summing them into a total.

| Code | Carries an industry? | What it is |
|---|---|---|
| `FISIM.P1` | no | Total FISIM produced by financial corporations, already inside their `P.1` |
| `FISIM.P2` | **yes** | FISIM consumed by that industry as an input |
| `FISIM.P31` | no | FISIM in household final consumption |
| `FISIM.P3` | no | FISIM in government final consumption |
| `FISIM.P6` | no | FISIM supplied to non-residents |
| `IMPRENT.P1` | **yes** | Imputed output of owner-occupied dwelling services, typically ISIC division 68 |
| `IMPRENT.P2` | **yes**, the same one | Inputs to that imputed production |

Two rules follow from how the engine uses them, and breaking either produces a
figure that looks reasonable and is wrong:

- **Do not include FISIM in the `P.2` you upload.** The industry's ordinary
  intermediate consumption must exclude the FISIM allocated to it; the engine
  adds that from `FISIM.P2`. Supplying it in both double-counts.
- **The FISIM allocations must sum to `FISIM.P1`.** A shortfall is reported as
  `fisim_allocation_mismatch` rather than absorbed.

A half-specified adjustment is refused at assembly, not compiled: a total with
nothing allocated, an allocation with no total, an intermediate allocation
with no industry to attach it to, or imputed rent whose output and inputs name
two different industries. The rest of the account still compiles; the
adjustment simply is not applied, and the run reports why.

Both settings on the run — the FISIM treatment, and whether the household
consumption figure already includes imputed rent — are chosen when the run is
created and pinned into its method version. "Not stated" is offered for the
second and is its own answer: it produces an informational diagnostic asking
the compiler to check, rather than being read as "no".
