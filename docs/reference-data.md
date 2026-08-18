# Reference data

Milestone 2 delivers the classification layer: the standard classifications
every compilation is expressed in, and the mapping layer that lets a country
compile in its own national breakdown and still report on the standards.

## The provenance model — read this first

An NSO is accountable for every figure it publishes, which means it has to be
able to tell where each classification code came from. Every
`classification_version` therefore records how its contents got into the
database:

| `provenance` | Meaning |
|---|---|
| `official_file` | Parsed from the published source file. The URL, SHA-256 and retrieval date are stored alongside. |
| `transcribed_pending_verification` | Hand-entered from the published structure. Correct as far as we know, **not yet diffed against the official file**. |
| `tenant_defined` | A national adaptation created by an organization in the product. |

**Everything seeded by `npm run db:seed` is `transcribed_pending_verification`.**
The environment this repository is developed in cannot reach
`unstats.un.org` (the network policy denies it), so the seeds were transcribed
from the published structures rather than downloaded. They are accurate to the
best of our knowledge and covered by tests, but they have not been mechanically
verified, and the product says so — in the database, and on the
classifications page in the UI.

`seeded_to_level` records the deepest level actually present. ISIC Rev.4 is
seeded to division (2-digit) level, not to class (4-digit) level. The UI shows
this explicitly so a compiler is never misled into thinking detail exists that
does not.

A version cannot claim `official_file` provenance without its evidence: the
`official_needs_evidence` check constraint requires the URL, checksum and
retrieval date to be present.

## Loading the official files

Once you have network access to the UN sources, download the structure files
and load each one. The loader **diffs by default** and writes only with
`--apply`, so a transcription error is reported rather than silently patched:

```bash
# 1. Download (example: ISIC Rev.4)
curl -o isic4.txt \
  'https://unstats.un.org/unsd/classifications/Econ/Download/In%20Text/ISIC_Rev_4_english_structure.Txt'

# 2. Dry run — prints new codes, name differences and anything stored that is
#    absent from the file
node scripts/load-classification.mjs \
  --classification ISIC4 --version Rev.4 \
  --file ./isic4.txt \
  --url 'https://unstats.un.org/unsd/classifications/Econ/Download/In%20Text/ISIC_Rev_4_english_structure.Txt'

# 3. Review the diff, then apply
node scripts/load-classification.mjs ... --apply
```

Applying sets `provenance = 'official_file'`, records the checksum, and updates
`seeded_to_level` to the real depth of the file.

**Please review the diff rather than skipping to `--apply`.** Any name
difference it reports is either an error in our transcription (fix the seed
file in `seeds/` too, so a fresh database starts from the corrected text) or a
version mismatch between the file and the version you are loading into.

Sources, all under https://unstats.un.org/unsd/classifications/:

| Code | Classification | Currently seeded to |
|---|---|---|
| `ISIC4` | ISIC Rev.4 — activities | division (2-digit), 21 sections + 88 divisions |
| `CPC21` | CPC Ver.2.1 — products | section (10 sections) |
| `COICOP1999` | COICOP — household consumption purpose | division (12 divisions) |
| `COFOG` | COFOG — government function | division (10 divisions) |
| `SNA_SECTOR` | SNA 2008 institutional sectors | subsector — complete per SNA 2008 ch.4 |

`SNA_SECTOR` is the one classification seeded in full: the sector breakdown is
set out in the SNA manual itself and is small enough to transcribe completely.

## SNA transaction codes

`transaction_code` holds P.1, P.2, B.1g, D.21, D.31 and the rest. Each carries
an `sna2008_ref`. These references are **chapter-level** (`SNA 2008 ch.6`)
rather than paragraph-level, and `ref_verified` is `false` for all of them: a
paragraph number quoted from memory is exactly the sort of thing that erodes
trust with a statistician who has the manual open. Set `ref_verified` to true
as references are checked; re-seeding never resets the flag.

## The mapping layer

A tenant defines its own classification (`owner_org_id` set, provenance
`tenant_defined`) and maps it onto a standard version through
`classification_mapping` and `classification_mapping_entry`. Entry weights
support 1-to-many splits — one national industry contributing to several ISIC
divisions — and must sum to 1 per source item.

Validation is a query rather than a constraint, because partial drafts have to
be saveable:

```sql
select * from validate_classification_mapping('<mapping-id>');  -- empty = sound
select activate_classification_mapping('<mapping-id>');         -- refuses if not
```

It reports three problems, each of which would corrupt a compilation:

- `weights_do_not_sum_to_one` — values would be lost or double-counted.
- `unmapped_source_item` — that industry's values would silently vanish.
- `entry_outside_declared_versions` — the mapping does not mean what it says.

## Reading hierarchies

Use `classification_tree(version_id)` rather than writing the self-join by
hand. A hierarchy self-join must constrain **both** sides by `version_id`;
otherwise the planner scans every item of every tenant. Measured in the
risk-3 spike at 12,368 items: 3.98 ms with a full scan versus 0.59 ms using
the index, and the gap grows with every tenant added.

## Running the scale spike

```bash
DATABASE_URL=... npm run spike:scale          # 25 tenants × 400 industries
SPIKE_TENANTS=100 SPIKE_INDUSTRIES=400 npm run spike:scale
SPIKE_KEEP=1 npm run spike:scale              # keep the data for inspection
```
