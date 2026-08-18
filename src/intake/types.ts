// Data intake — shared types.
//
// The validation and mapping modules are PURE (no database, no I/O), like the
// calculation engine: they take parsed rows plus the reference data they need
// and return findings. Only src/intake/parse.ts touches file bytes, and only
// the server actions touch the database.

/** A row exactly as it came out of the file, before any interpretation. */
export interface ParsedRow {
  /** 1-based line number in the source, so a human can be pointed at it. */
  rowNumber: number;
  /** Column name → cell value as text. Empty cells are ''. */
  cells: Record<string, string>;
}

export interface ParsedFile {
  header: string[];
  rows: ParsedRow[];
  /** Present for spreadsheets. */
  sheetName?: string;
}

/** Where a mapped field's value comes from. */
export type FieldSource =
  | { source: string } // a column in the file
  | { constant: string }; // the same value for every row

/**
 * A saved mapping from a file's columns to observation coordinates.
 *
 * `value` and `periodLabel` are always required; the dimension fields are
 * optional because they are not all meaningful at once — a household
 * consumption series has a COICOP purpose and no activity.
 */
export interface MappingDefinition {
  columns: {
    value: FieldSource;
    periodLabel: FieldSource;
    transactionCode: FieldSource;
    activityCode?: FieldSource;
    productCode?: FieldSource;
    sectorCode?: FieldSource;
    purposeCode?: FieldSource;
    unitCode?: FieldSource;
  };
  /** Classification versions the codes are resolved against. */
  activityVersionId?: string;
  productVersionId?: string;
  sectorVersionId?: string;
  purposeVersionId?: string;
  /** Applied to every row unless a per-row column overrides it. */
  unitCode: string;
  priceBasis: 'current' | 'previous_year' | 'chain_linked';
  valuation?: 'basic' | 'producers' | 'purchasers';
  frequency: 'annual' | 'quarterly';
  /**
   * Decimal separator used in the file. European extracts routinely use a
   * comma, and reading "1,5" as 15 would be a silent factor-of-ten error.
   */
  decimalSeparator?: '.' | ',';
  /** Characters to strip from numbers before parsing (spaces, apostrophes). */
  thousandsSeparators?: string[];
}

/** Everything the pure modules need to know about the tenant's reference data. */
export interface ReferenceContext {
  transactionCodes: Set<string>;
  /** version id → set of item codes in that version. */
  itemCodesByVersion: Map<string, Set<string>>;
  unitCodes: Set<string>;
  /** Period label → period id, for the frequency being loaded. */
  periodsByLabel: Map<string, string>;
  /** version id → item code → item id. */
  itemIdsByVersion: Map<string, Map<string, string>>;
}

/** A row after the mapping has been applied and codes resolved. */
export interface ResolvedRow {
  rowNumber: number;
  raw: Record<string, string>;
  transactionCode?: string;
  activityItemId?: string;
  productItemId?: string;
  sectorItemId?: string;
  purposeItemId?: string;
  periodId?: string;
  periodLabel?: string;
  unitCode?: string;
  value?: number;
  /** Null when the cell was blank — a deliberate gap, not a zero. */
  valueIsBlank: boolean;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  /** Null for dataset-level findings such as a coverage gap. */
  rowNumber: number | null;
  severity: IssueSeverity;
  code: ValidationCode;
  message: string;
  field?: string;
}

export type ValidationCode =
  | 'missing_required_field'
  | 'unknown_transaction_code'
  | 'unknown_classification_code'
  | 'unknown_unit'
  | 'unknown_period'
  | 'unparseable_number'
  | 'ambiguous_decimal_separator'
  | 'negative_where_positive_expected'
  | 'positive_where_negative_expected'
  | 'duplicate_coordinate'
  | 'value_added_exceeds_output'
  | 'coverage_gap'
  | 'blank_value'
  | 'inconsistent_unit'
  | 'suspicious_magnitude_jump';

export interface ValidationResult {
  issues: ValidationIssue[];
  /** Row numbers carrying at least one error-severity issue. */
  invalidRowNumbers: Set<number>;
  errorCount: number;
  warningCount: number;
}
