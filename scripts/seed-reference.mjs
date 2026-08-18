// Seeds system-wide reference data (milestone 2). Idempotent: safe to re-run,
// and re-running never downgrades a version whose contents were later loaded
// from an official file (see scripts/load-classification.mjs).
//
// Runs with a privileged migration connection, never from app runtime.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { parseCsvRecords } from './lib/csv.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const seedDir = new URL('../seeds', import.meta.url).pathname;
const read = (f) => parseCsvRecords(readFileSync(join(seedDir, f), 'utf8'));
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

// classification and classification_mapping are audited, so every write needs
// a reason. Seeding is a system action with no acting user; the audit row
// records that plainly rather than the trigger being bypassed. Session-scoped
// (max: 1, so one connection for the whole run).
await sql`select set_config('app.reason', 'reference-data seed script', false)`;

// Classifications seeded by hand from the published structures. Depth is
// recorded per version so nothing implies more coverage than is present;
// provenance stays 'transcribed_pending_verification' until the official file
// is loaded and diffed. See docs/reference-data.md.
const CLASSIFICATIONS = [
  {
    code: 'ISIC4',
    name: 'International Standard Industrial Classification of All Economic Activities, Rev.4',
    kind: 'activity',
    version: 'Rev.4',
    file: 'isic-rev4.csv',
    seededToLevel: 2,
    sourceUrl: 'https://unstats.un.org/unsd/classifications/Econ/isic',
    notes: 'Sections and divisions only. The official file continues to group (3-digit) and class (4-digit) level.',
  },
  {
    code: 'CPC21',
    name: 'Central Product Classification, Ver.2.1',
    kind: 'product',
    version: 'Ver.2.1',
    file: 'cpc-21.csv',
    seededToLevel: 1,
    sourceUrl: 'https://unstats.un.org/unsd/classifications/Econ/cpc',
    notes: 'Sections only. Load the official file for divisions through subclasses.',
  },
  {
    code: 'COICOP1999',
    name: 'Classification of Individual Consumption According to Purpose (1999)',
    kind: 'consumption_purpose',
    version: '1999',
    file: 'coicop-1999.csv',
    seededToLevel: 1,
    sourceUrl: 'https://unstats.un.org/unsd/classifications/Family/Detail/5',
    notes: 'Divisions only. COICOP 2018 is a separate version with 13 divisions; add it as its own classification_version when needed.',
  },
  {
    code: 'COFOG',
    name: 'Classification of the Functions of Government',
    kind: 'government_function',
    version: '1999',
    file: 'cofog.csv',
    seededToLevel: 1,
    sourceUrl: 'https://unstats.un.org/unsd/classifications/Family/Detail/4',
    notes: 'Divisions only. The official structure continues to group and class level.',
  },
  {
    code: 'SNA_SECTOR',
    name: 'SNA 2008 institutional sectors',
    kind: 'institutional_sector',
    version: '2008',
    file: 'institutional-sectors.csv',
    seededToLevel: 3,
    sourceUrl: 'https://unstats.un.org/unsd/nationalaccount/sna2008.asp',
    notes: 'Complete to subsector level as set out in SNA 2008 chapter 4.',
  },
];

async function seedFlatTables() {
  for (const c of read('currencies.csv')) {
    await sql`insert into currency (code, name, minor_units)
              values (${c.code}, ${c.name}, ${Number(c.minor_units)})
              on conflict (code) do update
                set name = excluded.name, minor_units = excluded.minor_units`;
  }
  for (const c of read('countries.csv')) {
    await sql`insert into country (iso3, iso2, name, currency_code)
              values (${c.iso3}, ${c.iso2}, ${c.name},
                      ${c.currency_code || null})
              on conflict (iso3) do update
                set iso2 = excluded.iso2, name = excluded.name,
                    currency_code = excluded.currency_code`;
  }
  for (const u of read('units.csv')) {
    await sql`insert into unit (code, name, unit_type, currency_code, multiplier)
              values (${u.code}, ${u.name}, ${u.unit_type},
                      ${u.currency_code || null}, ${u.multiplier})
              on conflict (code) do update
                set name = excluded.name, unit_type = excluded.unit_type,
                    currency_code = excluded.currency_code,
                    multiplier = excluded.multiplier`;
  }
  for (const t of read('transaction-codes.csv')) {
    // ref_verified is deliberately not touched on conflict: once a human has
    // checked a reference against the manual, re-seeding must not reset it.
    await sql`insert into transaction_code
                (code, name, sna2008_ref, description, sort_order)
              values (${t.code}, ${t.name}, ${t.sna2008_ref},
                      ${t.description || null}, ${Number(t.sort_order)})
              on conflict (code) do update
                set name = excluded.name, sna2008_ref = excluded.sna2008_ref,
                    description = excluded.description,
                    sort_order = excluded.sort_order`;
  }
}

async function seedClassification(spec) {
  const [cls] = await sql`
    insert into classification (code, name, kind, owner_org_id)
    values (${spec.code}, ${spec.name}, ${spec.kind}, null)
    on conflict (code, owner_org_id) do update set name = excluded.name
    returning id`;

  const [existing] = await sql`
    select id, provenance from classification_version
     where classification_id = ${cls.id} and version_label = ${spec.version}`;

  // Never downgrade a version already loaded from the official file.
  if (existing?.provenance === 'official_file') {
    console.log(`  ${spec.code} ${spec.version}: official file already loaded, skipping`);
    return;
  }

  const [ver] = await sql`
    insert into classification_version
      (classification_id, version_label, is_current, provenance,
       source_url, seeded_to_level, notes)
    values (${cls.id}, ${spec.version}, true,
            'transcribed_pending_verification',
            ${spec.sourceUrl}, ${spec.seededToLevel}, ${spec.notes})
    on conflict (classification_id, version_label) do update
      set is_current = true, source_url = excluded.source_url,
          seeded_to_level = excluded.seeded_to_level, notes = excluded.notes
    returning id`;

  const rows = read(spec.file);
  // Two passes: insert every item, then attach parents, so ordering in the
  // CSV cannot break the hierarchy.
  for (const r of rows) {
    await sql`insert into classification_item
                (version_id, code, name, level, sort_order)
              values (${ver.id}, ${r.code}, ${r.name},
                      ${Number(r.level)}, ${Number(r.sort_order)})
              on conflict (version_id, code) do update
                set name = excluded.name, level = excluded.level,
                    sort_order = excluded.sort_order`;
  }
  for (const r of rows.filter((x) => x.parent_code)) {
    await sql`update classification_item child
                 set parent_id = parent.id
                from classification_item parent
               where child.version_id = ${ver.id}
                 and child.code = ${r.code}
                 and parent.version_id = ${ver.id}
                 and parent.code = ${r.parent_code}`;
  }
  console.log(`  ${spec.code} ${spec.version}: ${rows.length} items (to level ${spec.seededToLevel})`);
}

try {
  console.log('seeding reference data');
  await seedFlatTables();
  console.log(`  currencies, countries, units, transaction codes`);
  for (const spec of CLASSIFICATIONS) await seedClassification(spec);
  console.log('reference data up to date');
} finally {
  await sql.end();
}
