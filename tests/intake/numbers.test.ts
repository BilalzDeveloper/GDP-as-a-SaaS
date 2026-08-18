// Number parsing. The failures worth catching here are silent ones: a value
// read ten or a thousand times too large still looks like a plausible figure
// in the published table.
import { describe, expect, it } from 'vitest';
import { inferDecimalSeparator, parseNumericCell } from '../../src/intake/numbers';

const value = (raw: string, opts = {}) => parseNumericCell(raw, opts);

describe('unambiguous numbers', () => {
  it.each([
    ['1234', 1234],
    ['1234.56', 1234.56],
    ['0', 0],
    ['-42', -42],
    ['+42', 42],
    ['  17  ', 17],
  ])('parses %s', (raw, expected) => {
    expect(value(raw)).toEqual({ kind: 'value', value: expected });
  });

  it('reads accounting parentheses as negative', () => {
    // Finance-system exports write negatives this way.
    expect(value('(1234)')).toEqual({ kind: 'value', value: -1234 });
    expect(value('(1 234.50)')).toEqual({ kind: 'value', value: -1234.5 });
  });

  it('strips grouping separators used across locales', () => {
    expect(value('1 234 567')).toEqual({ kind: 'value', value: 1234567 });
    expect(value("1'234'567")).toEqual({ kind: 'value', value: 1234567 });
  });

  it('resolves both separators by position', () => {
    expect(value('1,234.56')).toEqual({ kind: 'value', value: 1234.56 });
    expect(value('1.234,56')).toEqual({ kind: 'value', value: 1234.56 });
    expect(value('1,234,567.89')).toEqual({ kind: 'value', value: 1234567.89 });
  });

  it('treats a two-digit tail as decimal regardless of separator', () => {
    expect(value('1,25')).toEqual({ kind: 'value', value: 1.25 });
    expect(value('1.25')).toEqual({ kind: 'value', value: 1.25 });
  });

  it('treats repeated separators as grouping', () => {
    expect(value('1.234.567')).toEqual({ kind: 'value', value: 1234567 });
  });
});

describe('the ambiguous case is reported, never guessed', () => {
  it.each(['1,234', '12,345', '999,000'])(
    '%s is ambiguous without a declared separator',
    (raw) => {
      const result = value(raw);
      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') {
        expect(result.interpretations).toHaveLength(2);
        // The two readings differ by a factor of a thousand — exactly the
        // error this exists to prevent.
        const [a, b] = result.interpretations;
        expect(Math.abs(a / b)).toBeCloseTo(1000, 6);
      }
    },
  );

  it('is resolved once the mapping declares the separator', () => {
    expect(value('1,234', { decimalSeparator: ',' })).toEqual({
      kind: 'value',
      value: 1.234,
    });
    expect(value('1,234', { decimalSeparator: '.' })).toEqual({
      kind: 'value',
      value: 1234,
    });
  });

  it('keeps the sign on both interpretations', () => {
    const result = value('-1,234');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.interpretations.every((n) => n < 0)).toBe(true);
    }
  });
});

describe('missing values are not zeros', () => {
  it.each(['', '-', '..', '...', ':', 'n/a', 'NA', 'c', 'x'])(
    '%s is blank, not zero',
    (raw) => {
      expect(value(raw)).toEqual({ kind: 'blank' });
    },
  );

  it('distinguishes a real zero from a missing value', () => {
    expect(value('0')).toEqual({ kind: 'value', value: 0 });
  });
});

describe('unparseable input', () => {
  it.each(['abc', '12abc', '1.2.3.4a'])('rejects %s', (raw) => {
    expect(value(raw).kind).toBe('unparseable');
  });
});

describe('inferring the decimal separator', () => {
  it('infers a dot from decisive samples', () => {
    expect(inferDecimalSeparator(['1.5', '2.25', '100'])).toBe('.');
  });

  it('infers a comma from decisive samples', () => {
    expect(inferDecimalSeparator(['1,5', '2,25', '100'])).toBe(',');
  });

  it('declines to guess when the sample is only ambiguous forms', () => {
    expect(inferDecimalSeparator(['1,234', '5,678'])).toBeNull();
  });

  it('declines to guess when both conventions appear', () => {
    expect(inferDecimalSeparator(['1.5', '2,25'])).toBeNull();
  });

  it('ignores blanks and missing markers', () => {
    expect(inferDecimalSeparator(['', ':', '..', '3.7'])).toBe('.');
  });
});
