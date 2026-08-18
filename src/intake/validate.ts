// Validation rules for staged data. Pure: no database, no I/O.
//
// The brief asks for balance checks, sign conventions and coverage gaps. The
// rules below are shaped by what actually goes wrong with national-accounts
// source data: a scale mismatch between two extracts, an intermediate
// consumption figure that exceeds output, a series that quietly stops
// halfway through the period range, a decimal comma read as a thousands
// separator.
//
// Severity is deliberate. `error` blocks a commit; `warning` does not, because
// several of these findings are legitimately possible and a compiler who has
// checked should not be stopped by the tool.
import type {
  MappingDefinition,
  ParsedFile,
  ReferenceContext,
  ResolvedRow,
  ValidationIssue,
  ValidationResult,
} from './types';
import { parseNumericCell } from './numbers';
import { missingColumns, readField } from './mapping';

/**
 * Transaction codes whose values are non-negative in normal compilation.
 *
 * Deliberately excluded, because they are legitimately signed:
 *   P.52  changes in inventories — negative when stocks are drawn down
 *   P.53  acquisitions less disposals of valuables — a net figure
 *   B.1g, B.2g, B.3g  balancing items — can be negative in a bad year
 */
const NON_NEGATIVE_CODES = new Set([
  'P.1', 'P.2', 'P.3', 'P.31', 'P.32', 'P.4', 'P.51g', 'P.51c',
  'P.6', 'P.7', 'D.1', 'D.11', 'D.12', 'D.2', 'D.21', 'D.29',
  'D.3', 'D.31', 'D.39',
]);

/**
 * Codes the engine expects as POSITIVE amounts and subtracts itself
 * (docs/engine.md, "Signs"). A negative figure here almost always means the
 * source already negated it, which would double-negate downstream.
 */
const SUBTRACTED_CODES = new Set(['P.7', 'D.3', 'D.31', 'D.39']);

/** Ratio at which a value looks like a unit or scale error rather than growth. */
const MAGNITUDE_JUMP_RATIO = 50;

function coordinateKey(row: ResolvedRow): string {
  return [
    row.transactionCode ?? '',
    row.activityItemId ?? '',
    row.productItemId ?? '',
    row.sectorItemId ?? '',
    row.purposeItemId ?? '',
    row.periodId ?? row.periodLabel ?? '',
  ].join('|');
}

/** Same coordinate ignoring the period — a series through time. */
function seriesKey(row: ResolvedRow): string {
  return [
    row.transactionCode ?? '',
    row.activityItemId ?? '',
    row.productItemId ?? '',
    row.sectorItemId ?? '',
    row.purposeItemId ?? '',
  ].join('|');
}

export interface ValidateOptions {
  /**
   * Period labels the compilation expects to cover. Supplying them turns on
   * the coverage-gap check: a series present for some of these and absent for
   * others is usually a truncated extract, not a real absence.
   */
  expectedPeriodLabels?: string[];
}

export function validateRows(
  file: ParsedFile,
  mapping: MappingDefinition,
  rows: readonly ResolvedRow[],
  context: ReferenceContext,
  options: ValidateOptions = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (issue: ValidationIssue) => issues.push(issue);

  // --- mapping-level -------------------------------------------------------
  for (const column of missingColumns(file, mapping)) {
    add({
      rowNumber: null,
      severity: 'error',
      code: 'missing_required_field',
      message: `The mapping refers to a column "${column}" that this file does not contain.`,
      field: column,
    });
  }

  // --- per row -------------------------------------------------------------
  const seenCoordinates = new Map<string, number>();

  for (const row of rows) {
    const rowNumber = row.rowNumber;

    if (!row.transactionCode) {
      add({
        rowNumber,
        severity: 'error',
        code: 'missing_required_field',
        message: 'No transaction code — the row cannot be placed in the accounts.',
        field: 'transactionCode',
      });
    } else if (!context.transactionCodes.has(row.transactionCode)) {
      add({
        rowNumber,
        severity: 'error',
        code: 'unknown_transaction_code',
        message: `Transaction code "${row.transactionCode}" is not an SNA code known to this system.`,
        field: 'transactionCode',
      });
    }

    if (!row.periodLabel) {
      add({
        rowNumber,
        severity: 'error',
        code: 'missing_required_field',
        message: 'No reference period.',
        field: 'periodLabel',
      });
    } else if (!row.periodId) {
      add({
        rowNumber,
        severity: 'error',
        code: 'unknown_period',
        message: `Period "${row.periodLabel}" does not match any reference period defined for this organization.`,
        field: 'periodLabel',
      });
    }

    // Classification codes that were supplied but did not resolve.
    const codeFields: [keyof MappingDefinition['columns'], string, string | undefined][] = [
      ['activityCode', 'activity', row.activityItemId],
      ['productCode', 'product', row.productItemId],
      ['sectorCode', 'sector', row.sectorItemId],
      ['purposeCode', 'purpose', row.purposeItemId],
    ];
    for (const [field, label, resolved] of codeFields) {
      const supplied = readField(
        { rowNumber, cells: row.raw },
        mapping.columns[field],
      );
      if (supplied && !resolved) {
        add({
          rowNumber,
          severity: 'error',
          code: 'unknown_classification_code',
          message: `${label} code "${supplied}" was not found in the classification version this mapping uses.`,
          field,
        });
      }
    }

    if (row.unitCode && !context.unitCodes.has(row.unitCode)) {
      add({
        rowNumber,
        severity: 'error',
        code: 'unknown_unit',
        message: `Unit "${row.unitCode}" is not in the unit registry.`,
        field: 'unitCode',
      });
    }

    // Value parsing.
    const rawValue = readField({ rowNumber, cells: row.raw }, mapping.columns.value) ?? '';
    const parsed = parseNumericCell(rawValue, {
      decimalSeparator: mapping.decimalSeparator,
      thousandsSeparators: mapping.thousandsSeparators,
    });
    if (parsed.kind === 'ambiguous') {
      add({
        rowNumber,
        severity: 'error',
        code: 'ambiguous_decimal_separator',
        message:
          `"${parsed.text}" could be ${parsed.interpretations[0]} or ` +
          `${parsed.interpretations[1]} depending on the decimal separator. ` +
          `Set the separator on the mapping so this is not guessed.`,
        field: 'value',
      });
    } else if (parsed.kind === 'unparseable') {
      add({
        rowNumber,
        severity: 'error',
        code: 'unparseable_number',
        message: `"${parsed.text}" is not a number.`,
        field: 'value',
      });
    } else if (parsed.kind === 'blank') {
      add({
        rowNumber,
        severity: 'info',
        code: 'blank_value',
        message: 'No value — recorded as missing, which is not the same as zero.',
        field: 'value',
      });
    }

    // Sign conventions.
    if (row.value !== undefined && row.transactionCode) {
      if (row.value < 0 && NON_NEGATIVE_CODES.has(row.transactionCode)) {
        const subtracted = SUBTRACTED_CODES.has(row.transactionCode);
        add({
          rowNumber,
          severity: 'warning',
          code: 'negative_where_positive_expected',
          message: subtracted
            ? `${row.transactionCode} is negative (${row.value}). This system takes it as a positive amount and subtracts it, so a pre-negated figure would be added back.`
            : `${row.transactionCode} is normally non-negative but is ${row.value}.`,
          field: 'value',
        });
      }
    }

    // Duplicate coordinates.
    const key = coordinateKey(row);
    const firstSeen = seenCoordinates.get(key);
    if (firstSeen !== undefined) {
      add({
        rowNumber,
        severity: 'error',
        code: 'duplicate_coordinate',
        message: `The same series and period already appears on row ${firstSeen}. One of the two would silently overwrite the other.`,
      });
    } else {
      seenCoordinates.set(key, rowNumber);
    }
  }

  // --- balance checks across rows -----------------------------------------
  // Intermediate consumption above output means negative value added. Real in
  // rare cases, so it is a warning — but it is far more often a scale
  // mismatch between two extracts.
  const outputs = new Map<string, { value: number; rowNumber: number }>();
  const intermediates = new Map<string, { value: number; rowNumber: number }>();
  for (const row of rows) {
    if (row.value === undefined) continue;
    const dims = [
      row.activityItemId ?? '',
      row.sectorItemId ?? '',
      row.periodId ?? row.periodLabel ?? '',
    ].join('|');
    if (row.transactionCode === 'P.1') outputs.set(dims, { value: row.value, rowNumber: row.rowNumber });
    if (row.transactionCode === 'P.2') intermediates.set(dims, { value: row.value, rowNumber: row.rowNumber });
  }
  for (const [dims, ic] of intermediates) {
    const output = outputs.get(dims);
    if (output && ic.value > output.value) {
      add({
        rowNumber: ic.rowNumber,
        severity: 'warning',
        code: 'value_added_exceeds_output',
        message:
          `Intermediate consumption (${ic.value}) exceeds output (${output.value}, row ` +
          `${output.rowNumber}) for the same activity and period, so value added is negative. ` +
          `Occasionally genuine; usually a scale mismatch between two sources.`,
        field: 'value',
      });
    }
  }

  // --- per-series checks across periods ------------------------------------
  const bySeries = new Map<string, ResolvedRow[]>();
  for (const row of rows) {
    const key = seriesKey(row);
    const list = bySeries.get(key);
    if (list) list.push(row);
    else bySeries.set(key, [row]);
  }

  for (const [, seriesRows] of bySeries) {
    // Unit consistency within a series: mixing thousands and millions in one
    // series is a silent factor-of-1000 error.
    const units = new Set(seriesRows.map((r) => r.unitCode).filter(Boolean));
    if (units.size > 1) {
      add({
        rowNumber: seriesRows[0].rowNumber,
        severity: 'error',
        code: 'inconsistent_unit',
        message: `One series carries more than one unit (${[...units].join(', ')}). Values in different units cannot be compared or summed.`,
        field: 'unitCode',
      });
    }

    // Magnitude jumps between consecutive periods.
    const ordered = seriesRows
      .filter((r) => r.value !== undefined && r.value !== 0)
      .sort((a, b) => (a.periodLabel ?? '').localeCompare(b.periodLabel ?? ''));
    for (let i = 1; i < ordered.length; i++) {
      const previous = Math.abs(ordered[i - 1].value!);
      const current = Math.abs(ordered[i].value!);
      if (previous === 0) continue;
      const ratio = current / previous;
      if (ratio > MAGNITUDE_JUMP_RATIO || ratio < 1 / MAGNITUDE_JUMP_RATIO) {
        add({
          rowNumber: ordered[i].rowNumber,
          severity: 'warning',
          code: 'suspicious_magnitude_jump',
          message:
            `Value changes by a factor of ${ratio > 1 ? ratio.toFixed(0) : (1 / ratio).toFixed(0)} ` +
            `from ${ordered[i - 1].periodLabel} to ${ordered[i].periodLabel}. ` +
            `Check the unit — this is the shape of a thousands/millions mismatch.`,
          field: 'value',
        });
      }
    }

    // Coverage gaps.
    if (options.expectedPeriodLabels?.length) {
      const present = new Set(seriesRows.map((r) => r.periodLabel));
      const missing = options.expectedPeriodLabels.filter((p) => !present.has(p));
      if (missing.length > 0 && missing.length < options.expectedPeriodLabels.length) {
        add({
          rowNumber: seriesRows[0].rowNumber,
          severity: 'warning',
          code: 'coverage_gap',
          message:
            `This series covers some periods but not ${missing.join(', ')}. ` +
            `A partially covered series usually means a truncated extract.`,
        });
      }
    }
  }

  const invalidRowNumbers = new Set(
    issues
      .filter((i) => i.severity === 'error' && i.rowNumber !== null)
      .map((i) => i.rowNumber as number),
  );

  return {
    issues,
    invalidRowNumbers,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
  };
}

/** Errors block a commit; warnings and info do not. */
export function canCommit(result: ValidationResult): boolean {
  return result.errorCount === 0;
}
