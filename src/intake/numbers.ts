// Parsing numbers out of statistical source files.
//
// Pure, and deliberately fussy. The failure this module exists to prevent is
// silent: "1,5" read as 15 rather than 1.5 misstates a figure by a factor of
// ten and looks perfectly reasonable in the resulting table. Rather than
// guess, ambiguous input is reported so a human decides.

/**
 * Markers meaning "no observation", used across statistical publications:
 * Eurostat writes ':', many national releases use '..' or '-', and 'n/a'
 * appears in hand-maintained spreadsheets. These are NOT zeros — treating a
 * missing value as zero fabricates data.
 */
const MISSING_MARKERS = new Set([
  '', '-', '–', '—', '..', '...', ':', '.', 'n/a', 'na', 'nan', 'null',
  'not available', 'x', 'c', // 'c' = confidential in several releases
]);

export interface NumberParseOptions {
  decimalSeparator?: '.' | ',';
  thousandsSeparators?: string[];
}

export type NumberParseResult =
  | { kind: 'value'; value: number }
  | { kind: 'blank' }
  | { kind: 'ambiguous'; text: string; interpretations: number[] }
  | { kind: 'unparseable'; text: string };

const DEFAULT_THOUSANDS = [' ', ' ', ' ', "'", '`'];

/**
 * Parse one cell. Handles accounting negatives — (1 234) means −1234 in
 * exports from finance systems — and both decimal conventions.
 */
export function parseNumericCell(
  raw: string,
  options: NumberParseOptions = {},
): NumberParseResult {
  const trimmed = (raw ?? '').trim();
  if (MISSING_MARKERS.has(trimmed.toLowerCase())) return { kind: 'blank' };

  let text = trimmed;
  let negative = false;

  // Accounting parentheses.
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  // Leading sign.
  if (/^[+-]/.test(text)) {
    negative = negative !== text.startsWith('-');
    text = text.slice(1).trim();
  }
  // Trailing percent or currency symbols are stripped; the unit registry, not
  // the cell, is what says what a figure is denominated in.
  text = text.replace(/[%£€$¥]/g, '').trim();

  const separators = options.thousandsSeparators ?? DEFAULT_THOUSANDS;
  for (const sep of separators) text = text.split(sep).join('');

  if (text === '') return { kind: 'unparseable', text: trimmed };

  const hasDot = text.includes('.');
  const hasComma = text.includes(',');

  const finish = (n: number): NumberParseResult =>
    Number.isFinite(n)
      ? { kind: 'value', value: negative ? -n : n }
      : { kind: 'unparseable', text: trimmed };

  // Both present: the last one is the decimal separator, the other groups.
  if (hasDot && hasComma) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    const grouping = decimal === '.' ? ',' : '.';
    const cleaned = text.split(grouping).join('').replace(decimal, '.');
    return /^\d*\.?\d+$/.test(cleaned)
      ? finish(Number(cleaned))
      : { kind: 'unparseable', text: trimmed };
  }

  const only = hasDot ? '.' : hasComma ? ',' : null;
  if (only) {
    const declared = options.decimalSeparator;
    if (declared) {
      const cleaned =
        declared === only
          ? text.replace(only, '.')
          : text.split(only).join('');
      return /^\d*\.?\d+$/.test(cleaned)
        ? finish(Number(cleaned))
        : { kind: 'unparseable', text: trimmed };
    }

    const parts = text.split(only);
    const tail = parts[parts.length - 1];
    // Exactly three trailing digits with no other separator is the classic
    // ambiguity: "1,234" is 1234 to an English reader and 1.234 to a German
    // one. Both readings are plausible, so neither is chosen silently.
    if (parts.length === 2 && /^\d{3}$/.test(tail) && /^\d{1,3}$/.test(parts[0])) {
      const asGrouping = Number(parts.join(''));
      const asDecimal = Number(`${parts[0]}.${tail}`);
      return {
        kind: 'ambiguous',
        text: trimmed,
        interpretations: negative
          ? [-asGrouping, -asDecimal]
          : [asGrouping, asDecimal],
      };
    }
    // More than one separator, or a tail that is not three digits, resolves
    // it: "1,234,567" groups; "1,25" is decimal.
    if (parts.length > 2 || tail.length !== 3) {
      const cleaned =
        parts.length > 2 ? parts.join('') : `${parts[0]}.${tail}`;
      return /^\d*\.?\d+$/.test(cleaned)
        ? finish(Number(cleaned))
        : { kind: 'unparseable', text: trimmed };
    }
    const cleaned = parts.join('');
    return /^\d+$/.test(cleaned)
      ? finish(Number(cleaned))
      : { kind: 'unparseable', text: trimmed };
  }

  return /^\d+$/.test(text) ? finish(Number(text)) : { kind: 'unparseable', text: trimmed };
}

/**
 * Infer the decimal separator from a sample of cells, so the mapping UI can
 * propose one rather than making the compiler work it out. Returns null when
 * the sample does not settle it — in which case the compiler is asked.
 */
export function inferDecimalSeparator(samples: readonly string[]): '.' | ',' | null {
  let dotDecimal = 0;
  let commaDecimal = 0;
  for (const sample of samples) {
    const text = (sample ?? '').trim();
    if (!text || MISSING_MARKERS.has(text.toLowerCase())) continue;
    const dot = text.lastIndexOf('.');
    const comma = text.lastIndexOf(',');
    if (dot >= 0 && comma >= 0) {
      if (dot > comma) dotDecimal++;
      else commaDecimal++;
      continue;
    }
    // A single separator with anything other than three trailing digits is
    // decisive; three trailing digits stays ambiguous and is not counted.
    if (dot >= 0 && !/\.\d{3}$/.test(text)) dotDecimal++;
    if (comma >= 0 && !/,\d{3}$/.test(text)) commaDecimal++;
  }
  if (dotDecimal > 0 && commaDecimal === 0) return '.';
  if (commaDecimal > 0 && dotDecimal === 0) return ',';
  return null;
}
