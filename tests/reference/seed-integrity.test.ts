// Guards the seed FILES, independently of the database. These are transcribed
// from published structures (see docs/reference-data.md), so the failure mode
// worth catching early is a malformed or internally inconsistent file — a
// broken parent reference, a duplicated code, a row with the wrong number of
// columns after someone edits a title containing a comma.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRecords } from '../../scripts/lib/csv.mjs';

const seedDir = join(process.cwd(), 'seeds');
const read = (f: string) => readFileSync(join(seedDir, f), 'utf8');
const records = (f: string) => parseCsvRecords(read(f)) as Record<string, string>[];

const hierarchical = [
  'isic-rev4.csv',
  'cpc-21.csv',
  'coicop-1999.csv',
  'cofog.csv',
  'institutional-sectors.csv',
];

describe('every seed file is well formed', () => {
  it.each(readdirSync(seedDir).filter((f) => f.endsWith('.csv')))(
    '%s has a consistent column count',
    (file) => {
      const rows = parseCsv(read(file)) as string[][];
      const width = rows[0].length;
      const bad = rows
        .map((r, i) => ({ line: i + 1, n: r.length }))
        .filter((r) => r.n !== width);
      expect(bad).toEqual([]);
    },
  );
});

describe.each(hierarchical)('%s forms a valid hierarchy', (file) => {
  const rows = records(file);

  it('has no duplicate codes', () => {
    const seen = new Set<string>();
    const dupes = rows.map((r) => r.code).filter((c) => seen.size === seen.add(c).size);
    expect(dupes).toEqual([]);
  });

  it('every parent_code exists in the same file', () => {
    const codes = new Set(rows.map((r) => r.code));
    const orphans = rows
      .filter((r) => r.parent_code && !codes.has(r.parent_code))
      .map((r) => `${r.code} → ${r.parent_code}`);
    expect(orphans).toEqual([]);
  });

  it('a child sits exactly one level below its parent', () => {
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const wrong = rows
      .filter((r) => r.parent_code)
      .filter((r) => Number(r.level) !== Number(byCode.get(r.parent_code)!.level) + 1)
      .map((r) => r.code);
    expect(wrong).toEqual([]);
  });

  it('top-level rows have no parent, deeper rows do', () => {
    const bad = rows.filter((r) =>
      Number(r.level) === 1 ? r.parent_code !== '' : r.parent_code === '',
    );
    expect(bad.map((r) => r.code)).toEqual([]);
  });
});

describe('ISIC Rev.4 matches the published structure', () => {
  const rows = records('isic-rev4.csv');

  it('has all 21 sections, A through U', () => {
    const sections = rows.filter((r) => r.level === '1').map((r) => r.code);
    expect(sections).toEqual('ABCDEFGHIJKLMNOPQRSTU'.split(''));
  });

  it('has 88 divisions', () => {
    expect(rows.filter((r) => r.level === '2')).toHaveLength(88);
  });

  it('places divisions under the expected sections', () => {
    const byCode = new Map(rows.map((r) => [r.code, r]));
    // Spot-checks across the structure; the full file load verifies the rest.
    expect(byCode.get('01')!.parent_code).toBe('A');
    expect(byCode.get('10')!.parent_code).toBe('C');
    expect(byCode.get('35')!.parent_code).toBe('D');
    expect(byCode.get('41')!.parent_code).toBe('F');
    expect(byCode.get('64')!.parent_code).toBe('K');
    expect(byCode.get('84')!.parent_code).toBe('O');
    expect(byCode.get('99')!.parent_code).toBe('U');
  });
});

describe('institutional sectors follow SNA 2008 chapter 4', () => {
  const rows = records('institutional-sectors.csv');
  const byCode = new Map(rows.map((r) => [r.code, r]));

  it('has the five resident sectors and the rest of the world', () => {
    for (const code of ['S.11', 'S.12', 'S.13', 'S.14', 'S.15', 'S.2']) {
      expect(byCode.has(code)).toBe(true);
    }
  });

  it('nests the resident sectors under the total economy', () => {
    for (const code of ['S.11', 'S.12', 'S.13', 'S.14', 'S.15']) {
      expect(byCode.get(code)!.parent_code).toBe('S.1');
    }
    // The rest of the world is outside the total economy, by definition.
    expect(byCode.get('S.2')!.parent_code).toBe('');
  });

  it('includes the general government subsectors', () => {
    for (const code of ['S.1311', 'S.1312', 'S.1313', 'S.1314']) {
      expect(byCode.get(code)!.parent_code).toBe('S.13');
    }
  });
});

describe('transaction codes', () => {
  const rows = records('transaction-codes.csv');

  it('covers every code named in the project brief', () => {
    const required = [
      'P.1', 'P.2', 'B.1g', 'D.21', 'D.31', 'P.3', 'P.51g', 'P.52', 'P.53',
      'P.6', 'P.7', 'D.1', 'B.2g', 'B.3g', 'D.2', 'D.3',
    ];
    const have = new Set(rows.map((r) => r.code));
    expect(required.filter((c) => !have.has(c))).toEqual([]);
  });

  it('cites an SNA 2008 reference for every code', () => {
    const missing = rows.filter((r) => !/SNA 2008/.test(r.sna2008_ref));
    expect(missing.map((r) => r.code)).toEqual([]);
  });

  it('has no duplicate codes', () => {
    expect(new Set(rows.map((r) => r.code)).size).toBe(rows.length);
  });
});

describe('countries and currencies', () => {
  const countries = records('countries.csv');
  const currencies = records('currencies.csv');

  it('has unique ISO codes', () => {
    expect(new Set(countries.map((c) => c.iso3)).size).toBe(countries.length);
    expect(new Set(countries.map((c) => c.iso2)).size).toBe(countries.length);
    expect(new Set(currencies.map((c) => c.code)).size).toBe(currencies.length);
  });

  it('uses well-formed ISO code shapes', () => {
    expect(countries.filter((c) => !/^[A-Z]{3}$/.test(c.iso3))).toEqual([]);
    expect(countries.filter((c) => !/^[A-Z]{2}$/.test(c.iso2))).toEqual([]);
    expect(currencies.filter((c) => !/^[A-Z]{3}$/.test(c.code))).toEqual([]);
  });

  it('never references a currency that is not seeded', () => {
    const known = new Set(currencies.map((c) => c.code));
    const dangling = countries
      .filter((c) => c.currency_code && !known.has(c.currency_code))
      .map((c) => `${c.iso3}:${c.currency_code}`);
    expect(dangling).toEqual([]);
  });

  it('includes the milestone-3 fixture country', () => {
    // Statistics Denmark is the engine's real-world cross-check (PLAN.md §4).
    const dk = countries.find((c) => c.iso3 === 'DNK');
    expect(dk?.currency_code).toBe('DKK');
  });
});

describe('units', () => {
  const units = records('units.csv');

  it('gives every currency unit an explicit multiplier', () => {
    const bad = units.filter(
      (u) => u.unit_type === 'currency' && !(Number(u.multiplier) > 0),
    );
    expect(bad).toEqual([]);
  });

  it('never attaches a currency to a non-currency unit', () => {
    const bad = units.filter((u) => u.unit_type !== 'currency' && u.currency_code);
    expect(bad.map((u) => u.code)).toEqual([]);
  });
});
