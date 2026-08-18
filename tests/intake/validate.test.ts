// Validation rules. These are the checks that stand between a source file and
// a published figure, so each rule gets a test that shows what it catches AND
// a test that shows it stays quiet when the data is fine — a rule that fires
// on everything is as useless as one that never fires.
import { describe, expect, it } from 'vitest';
import { resolveRows } from '../../src/intake/mapping';
import { canCommit, validateRows } from '../../src/intake/validate';
import type {
  MappingDefinition,
  ParsedFile,
  ReferenceContext,
} from '../../src/intake/types';

const ACTIVITY_VERSION = 'ver-isic';

const context: ReferenceContext = {
  transactionCodes: new Set(['P.1', 'P.2', 'P.7', 'D.31', 'P.52', 'B.1g']),
  unitCodes: new Set(['NC_MN', 'NC_TH']),
  periodsByLabel: new Map([
    ['2022', 'p-2022'],
    ['2023', 'p-2023'],
    ['2024', 'p-2024'],
  ]),
  itemIdsByVersion: new Map([
    [ACTIVITY_VERSION, new Map([['A', 'item-A'], ['C', 'item-C']])],
  ]),
  itemCodesByVersion: new Map([[ACTIVITY_VERSION, new Set(['A', 'C'])]]),
};

const mapping: MappingDefinition = {
  columns: {
    value: { source: 'value' },
    periodLabel: { source: 'year' },
    transactionCode: { source: 'txn' },
    activityCode: { source: 'isic' },
  },
  activityVersionId: ACTIVITY_VERSION,
  unitCode: 'NC_MN',
  priceBasis: 'current',
  frequency: 'annual',
};

function file(rows: Record<string, string>[], header?: string[]): ParsedFile {
  return {
    header: header ?? ['txn', 'isic', 'year', 'value'],
    rows: rows.map((cells, i) => ({ rowNumber: i + 2, cells })),
  };
}

function run(
  rows: Record<string, string>[],
  overrides: Partial<MappingDefinition> = {},
  options = {},
) {
  const m = { ...mapping, ...overrides } as MappingDefinition;
  const f = file(rows);
  return validateRows(f, m, resolveRows(f, m, context), context, options);
}

const codes = (r: ReturnType<typeof run>) => r.issues.map((i) => i.code);

describe('a clean file passes', () => {
  const result = run([
    { txn: 'P.1', isic: 'A', year: '2023', value: '500' },
    { txn: 'P.2', isic: 'A', year: '2023', value: '200' },
    { txn: 'P.1', isic: 'C', year: '2023', value: '2000' },
  ]);

  it('raises no issues', () => {
    expect(result.issues).toEqual([]);
  });

  it('can be committed', () => {
    expect(canCommit(result)).toBe(true);
  });
});

describe('unknown codes', () => {
  it('rejects a transaction code that is not an SNA code', () => {
    const result = run([{ txn: 'ZZ.9', isic: 'A', year: '2023', value: '1' }]);
    expect(codes(result)).toContain('unknown_transaction_code');
    expect(canCommit(result)).toBe(false);
  });

  it('rejects a classification code absent from the mapped version', () => {
    const result = run([{ txn: 'P.1', isic: 'ZZ', year: '2023', value: '1' }]);
    expect(codes(result)).toContain('unknown_classification_code');
  });

  it('rejects a period with no matching reference period', () => {
    const result = run([{ txn: 'P.1', isic: 'A', year: '1066', value: '1' }]);
    expect(codes(result)).toContain('unknown_period');
  });

  it('rejects a unit outside the registry', () => {
    const result = run(
      [{ txn: 'P.1', isic: 'A', year: '2023', value: '1' }],
      { unitCode: 'BANANAS' },
    );
    expect(codes(result)).toContain('unknown_unit');
  });

  it('reports a mapping that names a column the file lacks', () => {
    const m = {
      ...mapping,
      columns: { ...mapping.columns, value: { source: 'nope' } },
    } as MappingDefinition;
    const f = file([{ txn: 'P.1', isic: 'A', year: '2023', value: '1' }]);
    const result = validateRows(f, m, resolveRows(f, m, context), context);
    const issue = result.issues.find((i) => i.code === 'missing_required_field');
    expect(issue?.rowNumber).toBeNull();
    expect(issue?.field).toBe('nope');
  });
});

describe('sign conventions', () => {
  it('flags a negative output', () => {
    const result = run([{ txn: 'P.1', isic: 'A', year: '2023', value: '-500' }]);
    expect(codes(result)).toContain('negative_where_positive_expected');
  });

  it('explains the double-negation risk for subtracted codes', () => {
    // The engine takes imports positive and subtracts them, so a pre-negated
    // figure would be added back — worth saying explicitly.
    const result = run([{ txn: 'P.7', isic: 'A', year: '2023', value: '-100' }]);
    const issue = result.issues.find(
      (i) => i.code === 'negative_where_positive_expected',
    );
    expect(issue?.message).toMatch(/subtracts it/);
  });

  it('does not flag changes in inventories, which are legitimately signed', () => {
    const result = run([{ txn: 'P.52', isic: 'A', year: '2023', value: '-40' }]);
    expect(codes(result)).not.toContain('negative_where_positive_expected');
  });

  it('does not flag a negative balancing item', () => {
    const result = run([{ txn: 'B.1g', isic: 'A', year: '2023', value: '-10' }]);
    expect(codes(result)).not.toContain('negative_where_positive_expected');
  });

  it('warns rather than blocks, so a checked figure can still be committed', () => {
    const result = run([{ txn: 'P.1', isic: 'A', year: '2023', value: '-500' }]);
    expect(canCommit(result)).toBe(true);
  });
});

describe('duplicate coordinates', () => {
  it('rejects two rows for the same series and period', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2023', value: '500' },
      { txn: 'P.1', isic: 'A', year: '2023', value: '600' },
    ]);
    const issue = result.issues.find((i) => i.code === 'duplicate_coordinate');
    expect(issue?.rowNumber).toBe(3);
    expect(issue?.message).toContain('row 2');
    expect(canCommit(result)).toBe(false);
  });

  it('allows the same activity in different periods', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2023', value: '500' },
      { txn: 'P.1', isic: 'A', year: '2024', value: '520' },
    ]);
    expect(codes(result)).not.toContain('duplicate_coordinate');
  });

  it('allows different transactions for the same activity and period', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2023', value: '500' },
      { txn: 'P.2', isic: 'A', year: '2023', value: '200' },
    ]);
    expect(codes(result)).not.toContain('duplicate_coordinate');
  });
});

describe('balance checks', () => {
  it('flags intermediate consumption above output', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2023', value: '500' },
      { txn: 'P.2', isic: 'A', year: '2023', value: '900' },
    ]);
    const issue = result.issues.find((i) => i.code === 'value_added_exceeds_output');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('scale mismatch');
  });

  it('stays quiet when value added is positive', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2023', value: '500' },
      { txn: 'P.2', isic: 'A', year: '2023', value: '200' },
    ]);
    expect(codes(result)).not.toContain('value_added_exceeds_output');
  });

  it('compares only within the same activity and period', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2023', value: '500' },
      { txn: 'P.2', isic: 'C', year: '2023', value: '900' },
    ]);
    expect(codes(result)).not.toContain('value_added_exceeds_output');
  });
});

describe('magnitude jumps — the scale-error detector', () => {
  it('flags a thousandfold jump between periods', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2022', value: '500' },
      { txn: 'P.1', isic: 'A', year: '2023', value: '500000' },
    ]);
    const issue = result.issues.find((i) => i.code === 'suspicious_magnitude_jump');
    expect(issue?.message).toMatch(/thousands\/millions/);
  });

  it('flags a collapse as well as a spike', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2022', value: '500000' },
      { txn: 'P.1', isic: 'A', year: '2023', value: '500' },
    ]);
    expect(codes(result)).toContain('suspicious_magnitude_jump');
  });

  it('ignores ordinary year-on-year growth', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2022', value: '500' },
      { txn: 'P.1', isic: 'A', year: '2023', value: '540' },
      { txn: 'P.1', isic: 'A', year: '2024', value: '600' },
    ]);
    expect(codes(result)).not.toContain('suspicious_magnitude_jump');
  });
});

describe('coverage gaps', () => {
  it('flags a series that stops halfway through the expected range', () => {
    const result = run(
      [
        { txn: 'P.1', isic: 'A', year: '2022', value: '500' },
        { txn: 'P.1', isic: 'A', year: '2023', value: '520' },
        { txn: 'P.1', isic: 'C', year: '2022', value: '900' },
        { txn: 'P.1', isic: 'C', year: '2023', value: '950' },
        { txn: 'P.1', isic: 'C', year: '2024', value: '980' },
      ],
      {},
      { expectedPeriodLabels: ['2022', '2023', '2024'] },
    );
    const issue = result.issues.find((i) => i.code === 'coverage_gap');
    expect(issue?.message).toContain('2024');
  });

  it('does not flag a series absent from every expected period', () => {
    // Wholly absent is a different situation from partially covered, and
    // flagging it here would fire on every file that covers one year.
    const result = run(
      [{ txn: 'P.1', isic: 'A', year: '2022', value: '500' }],
      {},
      { expectedPeriodLabels: ['2022'] },
    );
    expect(codes(result)).not.toContain('coverage_gap');
  });

  it('is off unless expected periods are supplied', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2022', value: '500' },
      { txn: 'P.1', isic: 'C', year: '2023', value: '900' },
    ]);
    expect(codes(result)).not.toContain('coverage_gap');
  });
});

describe('unit consistency within a series', () => {
  it('rejects a series carrying two different units', () => {
    const f = file(
      [
        { txn: 'P.1', isic: 'A', year: '2022', value: '500', unit: 'NC_MN' },
        { txn: 'P.1', isic: 'A', year: '2023', value: '520000', unit: 'NC_TH' },
      ],
      ['txn', 'isic', 'year', 'value', 'unit'],
    );
    const m = {
      ...mapping,
      columns: { ...mapping.columns, unitCode: { source: 'unit' } },
    } as MappingDefinition;
    const result = validateRows(f, m, resolveRows(f, m, context), context);
    expect(result.issues.map((i) => i.code)).toContain('inconsistent_unit');
    expect(canCommit(result)).toBe(false);
  });
});

describe('value parsing surfaces through validation', () => {
  it('blocks on an ambiguous decimal separator', () => {
    const result = run([{ txn: 'P.1', isic: 'A', year: '2023', value: '1,234' }]);
    const issue = result.issues.find((i) => i.code === 'ambiguous_decimal_separator');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toMatch(/1234 or 1.234/);
  });

  it('accepts it once the mapping declares the separator', () => {
    const result = run(
      [{ txn: 'P.1', isic: 'A', year: '2023', value: '1,234' }],
      { decimalSeparator: ',' },
    );
    expect(codes(result)).not.toContain('ambiguous_decimal_separator');
  });

  it('records a blank as missing rather than zero', () => {
    const result = run([{ txn: 'P.1', isic: 'A', year: '2023', value: ':' }]);
    const issue = result.issues.find((i) => i.code === 'blank_value');
    expect(issue?.severity).toBe('info');
    expect(issue?.message).toMatch(/not the same as zero/);
    expect(canCommit(result)).toBe(true);
  });

  it('blocks on text where a number belongs', () => {
    const result = run([{ txn: 'P.1', isic: 'A', year: '2023', value: 'approx 500' }]);
    expect(codes(result)).toContain('unparseable_number');
    expect(canCommit(result)).toBe(false);
  });
});

describe('missing required fields', () => {
  it('rejects a row with no transaction code', () => {
    const result = run([{ txn: '', isic: 'A', year: '2023', value: '1' }]);
    expect(codes(result)).toContain('missing_required_field');
  });

  it('rejects a row with no period', () => {
    const result = run([{ txn: 'P.1', isic: 'A', year: '', value: '1' }]);
    expect(codes(result)).toContain('missing_required_field');
  });

  it('marks exactly the offending rows invalid', () => {
    const result = run([
      { txn: 'P.1', isic: 'A', year: '2023', value: '500' },
      { txn: '', isic: 'A', year: '2023', value: '600' },
      { txn: 'P.1', isic: 'C', year: '2023', value: '700' },
    ]);
    expect([...result.invalidRowNumbers]).toEqual([3]);
  });
});
