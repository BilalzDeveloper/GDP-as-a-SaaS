// Loads an official classification structure file into a classification
// version, recording its URL, SHA-256 and retrieval date, and upgrading the
// version's provenance to 'official_file'.
//
// This is the path that turns transcribed reference data into audited data.
// It never silently overwrites: by default it DIFFS the file against what is
// already stored and prints every discrepancy, so a transcription error is
// surfaced rather than quietly corrected. Pass --apply to write.
//
// Usage:
//   node scripts/load-classification.mjs \
//     --classification ISIC4 --version Rev.4 \
//     --file ./ISIC_Rev_4_english_structure.txt \
//     --url https://unstats.un.org/unsd/classifications/Econ/Download/In%20Text/ISIC_Rev_4_english_structure.Txt \
//     [--apply]
//
// File format: the UN publishes these as CSV with a "Code","Description"
// header (ISIC Rev.4, CPC Ver.2.1 and the COICOP/COFOG structure files all
// follow this shape). Hierarchy is derived from code length, which is how the
// published structures encode it.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { parseCsvRecords } from './lib/csv.mjs';

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) {
      console.error(`missing --${name}`);
      process.exit(1);
    }
    return undefined;
  }
  return process.argv[i + 1];
}

const apply = process.argv.includes('--apply');
const classificationCode = arg('classification');
const versionLabel = arg('version');
const filePath = arg('file');
const sourceUrl = arg('url');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const raw = readFileSync(filePath);
const sha256 = createHash('sha256').update(raw).digest('hex');
const records = parseCsvRecords(raw.toString('utf8'));

// Accept the UN header spellings; fall back to positional if unrecognised.
function pick(rec, names) {
  for (const n of names) {
    const key = Object.keys(rec).find((k) => k.toLowerCase() === n);
    if (key !== undefined) return rec[key];
  }
  return undefined;
}

const items = records
  .map((r) => {
    const code = (pick(r, ['code', 'isic', 'cpc']) ?? Object.values(r)[0] ?? '').trim();
    const name = (pick(r, ['description', 'title', 'name']) ?? Object.values(r)[1] ?? '').trim();
    return { code, name };
  })
  .filter((r) => r.code && r.name);

if (items.length === 0) {
  console.error('no usable rows parsed from the file — check its format');
  process.exit(1);
}

// Hierarchy from code shape. ISIC: letter section, then 2/3/4 digits. CPC and
// COICOP/COFOG: digits, one level per additional character (COICOP codes are
// dotted, e.g. 01.1.1).
function levelOf(code) {
  if (/^[A-Za-z]$/.test(code)) return 1;
  const digits = code.replace(/[^0-9]/g, '');
  if (/^[A-Za-z]/.test(code)) return digits.length; // e.g. section-prefixed
  return Math.max(1, digits.length - 1);
}

function parentOf(code, byCode) {
  const digits = code.replace(/[^0-9]/g, '');
  for (let cut = digits.length - 1; cut >= 1; cut--) {
    const candidate = digits.slice(0, cut);
    if (byCode.has(candidate)) return candidate;
    // Dotted forms (COICOP 01.1.1 → 01.1)
    const dotted = code.split('.').slice(0, -1).join('.');
    if (dotted && byCode.has(dotted)) return dotted;
  }
  return null;
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
await sql`select set_config('app.reason', ${'official classification file load: ' + classificationCode}, false)`;

try {
  const [cls] = await sql`
    select id from classification
     where code = ${classificationCode} and owner_org_id is null`;
  if (!cls) {
    console.error(`no system classification with code ${classificationCode}`);
    process.exit(1);
  }
  const [ver] = await sql`
    select id, provenance, seeded_to_level from classification_version
     where classification_id = ${cls.id} and version_label = ${versionLabel}`;
  if (!ver) {
    console.error(`no version ${versionLabel} for ${classificationCode}`);
    process.exit(1);
  }

  const stored = await sql`
    select code, name from classification_item where version_id = ${ver.id}`;
  const storedByCode = new Map(stored.map((r) => [r.code, r.name]));
  const fileByCode = new Map(items.map((r) => [r.code, r.name]));

  // Diff: report anything the transcription got wrong or is missing.
  const nameMismatches = [];
  for (const [code, name] of fileByCode) {
    const have = storedByCode.get(code);
    if (have !== undefined && have !== name) nameMismatches.push({ code, have, want: name });
  }
  const notInFile = [...storedByCode.keys()].filter((c) => !fileByCode.has(c));
  const newCodes = [...fileByCode.keys()].filter((c) => !storedByCode.has(c));

  console.log(`file:     ${filePath}`);
  console.log(`sha256:   ${sha256}`);
  console.log(`parsed:   ${items.length} items`);
  console.log(`stored:   ${stored.length} items (provenance ${ver.provenance})`);
  console.log(`new:      ${newCodes.length}`);
  console.log(`mismatch: ${nameMismatches.length}`);
  console.log(`stored but absent from the file: ${notInFile.length}`);

  if (nameMismatches.length) {
    console.log('\nname differences (stored → official):');
    for (const m of nameMismatches.slice(0, 50)) {
      console.log(`  ${m.code}\n    stored:   ${m.have}\n    official: ${m.want}`);
    }
    if (nameMismatches.length > 50) {
      console.log(`  … and ${nameMismatches.length - 50} more`);
    }
  }
  if (notInFile.length) {
    console.log(`\ncodes present in the database but not in the file: ${notInFile.join(', ')}`);
    console.log('(these are transcription errors or belong to another version)');
  }

  if (!apply) {
    console.log('\ndry run — pass --apply to write these changes');
    process.exit(0);
  }

  const byCode = new Set(fileByCode.keys());
  const maxLevel = Math.max(...items.map((r) => levelOf(r.code)));

  await sql.begin(async (tx) => {
    for (const it of items) {
      await tx`insert into classification_item
                 (version_id, code, name, level, sort_order)
               values (${ver.id}, ${it.code}, ${it.name},
                       ${levelOf(it.code)}, ${items.indexOf(it) * 10})
               on conflict (version_id, code) do update
                 set name = excluded.name, level = excluded.level,
                     sort_order = excluded.sort_order`;
    }
    for (const it of items) {
      const parent = parentOf(it.code, byCode);
      if (!parent) continue;
      await tx`update classification_item child
                  set parent_id = p.id
                 from classification_item p
                where child.version_id = ${ver.id} and child.code = ${it.code}
                  and p.version_id = ${ver.id} and p.code = ${parent}`;
    }
    await tx`update classification_version
                set provenance = 'official_file',
                    source_url = ${sourceUrl},
                    source_file_sha256 = ${sha256},
                    source_retrieved_at = now(),
                    seeded_to_level = ${maxLevel}
              where id = ${ver.id}`;
  });

  console.log(`\napplied. ${classificationCode} ${versionLabel} is now provenance=official_file, depth ${maxLevel}.`);
} finally {
  await sql.end();
}
