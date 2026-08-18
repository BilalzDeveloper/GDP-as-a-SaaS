// Applying a column mapping to parsed rows. Pure: no database, no I/O.
//
// Resolution is separated from validation so that a row which fails to
// resolve still reaches the compiler with everything that DID resolve intact
// — a single bad code should not blank out the rest of the row.
import type {
  FieldSource,
  MappingDefinition,
  ParsedFile,
  ParsedRow,
  ReferenceContext,
  ResolvedRow,
} from './types';
import { parseNumericCell } from './numbers';

/** Read one mapped field from a row. Returns undefined when unmapped. */
export function readField(
  row: ParsedRow,
  field: FieldSource | undefined,
): string | undefined {
  if (!field) return undefined;
  if ('constant' in field) return field.constant;
  const value = row.cells[field.source];
  return value === undefined ? undefined : value.trim();
}

/** Column names a mapping refers to but the file does not contain. */
export function missingColumns(
  file: ParsedFile,
  mapping: MappingDefinition,
): string[] {
  const present = new Set(file.header);
  const wanted = Object.values(mapping.columns)
    .filter((f): f is { source: string } => !!f && 'source' in f)
    .map((f) => f.source);
  return [...new Set(wanted.filter((c) => !present.has(c)))];
}

function resolveItem(
  code: string | undefined,
  versionId: string | undefined,
  context: ReferenceContext,
): string | undefined {
  if (!code || !versionId) return undefined;
  return context.itemIdsByVersion.get(versionId)?.get(code);
}

/**
 * Apply a mapping to every row. Codes are resolved against the classification
 * versions named in the mapping; anything unresolved is simply left undefined
 * and reported by `validateRows`, which owns all judgement about what is
 * wrong.
 */
export function resolveRows(
  file: ParsedFile,
  mapping: MappingDefinition,
  context: ReferenceContext,
): ResolvedRow[] {
  const numberOptions = {
    decimalSeparator: mapping.decimalSeparator,
    thousandsSeparators: mapping.thousandsSeparators,
  };

  return file.rows.map((row) => {
    const rawValue = readField(row, mapping.columns.value) ?? '';
    const parsed = parseNumericCell(rawValue, numberOptions);
    const periodLabel = readField(row, mapping.columns.periodLabel);
    const unitCode = readField(row, mapping.columns.unitCode) ?? mapping.unitCode;

    return {
      rowNumber: row.rowNumber,
      raw: row.cells,
      transactionCode: readField(row, mapping.columns.transactionCode) || undefined,
      activityItemId: resolveItem(
        readField(row, mapping.columns.activityCode),
        mapping.activityVersionId,
        context,
      ),
      productItemId: resolveItem(
        readField(row, mapping.columns.productCode),
        mapping.productVersionId,
        context,
      ),
      sectorItemId: resolveItem(
        readField(row, mapping.columns.sectorCode),
        mapping.sectorVersionId,
        context,
      ),
      purposeItemId: resolveItem(
        readField(row, mapping.columns.purposeCode),
        mapping.purposeVersionId,
        context,
      ),
      periodId: periodLabel ? context.periodsByLabel.get(periodLabel) : undefined,
      periodLabel,
      unitCode,
      value: parsed.kind === 'value' ? parsed.value : undefined,
      valueIsBlank: parsed.kind === 'blank',
    };
  });
}
