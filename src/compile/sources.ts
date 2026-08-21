// Which observations produced which figure.
//
// Milestone 5 asks to "drill from an aggregate down to contributing source
// records". Until now only per-industry aggregates could: the run page looked
// up observations by activity_item_id, which happens to match how the
// assembler groups industries. Every other figure — household final
// consumption, capital formation, net exports, compensation of employees —
// had no way back to the rows behind it.
//
// It cannot be re-derived from the codes alone. Final consumption is resolved
// by institutional sector (D46) and FISIM arrives on codes of its own (D45),
// so "which rows made this 1700" is a question about the assembler's rules,
// not about a transaction code. This module states those rules once. The
// assembler sums what these predicates select, and execution records the
// selection against the result row, so a drill-down shows what was actually
// added up rather than what today's rules would select now.
//
// Pure, like the rest of `src/compile`: rows in, rows out.
import type { ObservationRow } from './assemble';
import { MEASURE, type Measure } from './measures';

/** Rows carrying a value, at total-economy level (no industry attached). */
function totals(rows: readonly ObservationRow[], codes: readonly string[]) {
  return rows.filter(
    (r) =>
      codes.includes(r.transactionCode) && r.activityItemId === null && r.value !== null,
  );
}

/** Rows carrying a value and attributed to one industry. */
function forIndustry(
  rows: readonly ObservationRow[],
  codes: readonly string[],
  activityItemId: string,
) {
  return rows.filter(
    (r) =>
      codes.includes(r.transactionCode) &&
      r.activityItemId === activityItemId &&
      r.value !== null,
  );
}

/** Every row attributed to some industry, whichever it is. */
function anyIndustry(rows: readonly ObservationRow[], codes: readonly string[]) {
  return rows.filter(
    (r) =>
      codes.includes(r.transactionCode) && r.activityItemId !== null && r.value !== null,
  );
}

const OUTPUT_CODES = ['P.1'];
const INTERMEDIATE_CODES = ['P.2'];
const CONSUMPTION_CODES = ['P.3', 'P.31', 'P.32'];
const CAPITAL_CODES = ['P.51g', 'P.52', 'P.53'];
const TRADE_CODES = ['P.6', 'P.7'];
const FACTOR_INCOME_CODES = ['D.1', 'B.2g', 'B.3g'];
const PRODUCTION_TAX_CODES = ['D.2', 'D.3'];

/**
 * The observations behind one compiled figure.
 *
 * `activityItemId` is set for the per-industry measures and null for the
 * total-economy ones. A measure with no source rows — a derived one such as
 * per-capita GDP or a growth rate — returns an empty list rather than a
 * wrong one; those are computed from other results, and the run page says so.
 */
export function contributingRows(
  rows: readonly ObservationRow[],
  measure: Measure,
  activityItemId: string | null = null,
): ObservationRow[] {
  switch (measure) {
    case MEASURE.output:
      return activityItemId ? forIndustry(rows, OUTPUT_CODES, activityItemId) : [];
    case MEASURE.intermediateConsumption:
      return activityItemId ? forIndustry(rows, INTERMEDIATE_CODES, activityItemId) : [];
    case MEASURE.grossValueAdded:
      return activityItemId
        ? forIndustry(rows, [...OUTPUT_CODES, ...INTERMEDIATE_CODES], activityItemId)
        : [];
    case MEASURE.totalGrossValueAdded:
      return anyIndustry(rows, [...OUTPUT_CODES, ...INTERMEDIATE_CODES]);
    case MEASURE.taxesOnProducts:
      return totals(rows, ['D.21']);
    case MEASURE.subsidiesOnProducts:
      return totals(rows, ['D.31']);

    // Final consumption spans the three institutional sectors and any of the
    // consumption codes — which is exactly why it needs recording rather than
    // looking up by code.
    case MEASURE.finalConsumptionExpenditure:
      return totals(rows, CONSUMPTION_CODES);
    case MEASURE.grossCapitalFormation:
      return totals(rows, CAPITAL_CODES);
    case MEASURE.netExports:
      return totals(rows, TRADE_CODES);
    case MEASURE.totalFactorIncomes:
      return totals(rows, FACTOR_INCOME_CODES);
    case MEASURE.netTaxesOnProductionAndImports:
      return totals(rows, PRODUCTION_TAX_CODES);
    case MEASURE.population:
      return totals(rows, ['POP']);
    default:
      return [];
  }
}

/**
 * The observations behind an approach's GDP total: everything its components
 * were built from, including the adjustment codes, which are part of the
 * production figure without being a component of it.
 */
export function contributingRowsForGdp(
  rows: readonly ObservationRow[],
  approach: 'production' | 'expenditure' | 'income',
): ObservationRow[] {
  switch (approach) {
    case 'production':
      return rows.filter(
        (r) =>
          r.value !== null &&
          (([...OUTPUT_CODES, ...INTERMEDIATE_CODES].includes(r.transactionCode) &&
            r.activityItemId !== null) ||
            ['D.21', 'D.31'].includes(r.transactionCode) ||
            r.transactionCode.startsWith('FISIM.') ||
            r.transactionCode.startsWith('IMPRENT.')),
      );
    case 'expenditure':
      return totals(rows, [...CONSUMPTION_CODES, ...CAPITAL_CODES, ...TRADE_CODES]);
    case 'income':
      return totals(rows, [...FACTOR_INCOME_CODES, ...PRODUCTION_TAX_CODES]);
  }
}
