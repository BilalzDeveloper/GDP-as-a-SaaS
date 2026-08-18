// SNA 2008 GDP calculation engine — public API.
//
// Pure and dependency-free: no database access, no I/O, no npm dependencies.
// Structured input in, structured output out, so it can be unit-tested
// exhaustively and reused outside this application.
//
// Scope at milestone 3: all three approaches at CURRENT PRICES. Volume
// measures, deflation and chain-linking arrive in milestone 6; quarterly
// compilation and Denton benchmarking in milestone 8.
//
// See docs/engine.md for the methodological variants and the citation policy.

export type {
  ApproachDiscrepancy,
  BalancingAnchor,
  CompilationOptions,
  CompilationResult,
  Diagnostic,
  ExpenditureInput,
  ExpenditureResult,
  FisimInput,
  FisimTreatment,
  ImputedRentInput,
  IncomeInput,
  IncomeResult,
  IndustryInput,
  IndustryValueAdded,
  Money,
  OutputValuation,
  ProductionInput,
  ProductionResult,
} from './types';

export {
  approximatelyEqual,
  roundForPublication,
  sum,
  sumBy,
  DEFAULT_ABSOLUTE_TOLERANCE,
  DEFAULT_RELATIVE_TOLERANCE,
} from './numeric';

export {
  basicPricesFromProducers,
  computeProductionApproach,
  grossValueAdded,
} from './production';

export {
  computeExpenditureApproach,
  finalConsumptionExpenditure,
  grossCapitalFormation,
} from './expenditure';

export {
  computeIncomeApproach,
  netTaxesOnProductionAndImports,
  totalFactorIncomes,
} from './income';

export {
  compileGdp,
  statisticalDiscrepancy,
  type CompilationInput,
} from './reconcile';

export {
  annualisedGrowthRate,
  gdpPerCapita,
  growthContribution,
  growthRate,
} from './derived';

/**
 * Engine version, pinned into `method_version` when a compilation runs so any
 * published figure can be re-computed from stored inputs (non-negotiable 1).
 * Bump on any change to a computed result; record the reason in DECISIONS.md.
 */
export const ENGINE_VERSION = '0.1.0';
