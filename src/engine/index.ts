// SNA 2008 GDP calculation engine — public API.
//
// Pure and dependency-free: no database access, no I/O, no npm dependencies.
// Structured input in, structured output out, so it can be unit-tested
// exhaustively and reused outside this application.
//
// Scope: all three approaches at current prices (milestone 3), volume
// measures — deflation, index numbers and chain-linking (milestone 6) — and
// quarterly compilation with Denton benchmarking to annual totals
// (milestone 8).
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
  SectorProductionInput,
  SectorValueAdded,
} from './types';

export {
  approximatelyEqual,
  roundForPublication,
  solveLinearSystem,
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

export {
  chainLink,
  chainLinkAggregate,
  deflate,
  fisherIndex,
  implicitPriceDeflator,
  laspeyresPriceIndex,
  laspeyresVolumeIndex,
  nonAdditivityResidual,
  paaschePriceIndex,
  paascheVolumeIndex,
  previousYearPricesValue,
  priceIndex,
  volumeIndex,
  INDEX_BASE,
  type ChainLinkedPoint,
  type ChainLinkOptions,
  type IndexFormula,
  type NonAdditivity,
  type PriceQuantity,
  type SeriesPoint,
} from './volume';

export {
  dentonBenchmark,
  subAnnualGrowth,
  temporalAggregate,
  BenchmarkError,
  type BenchmarkConstraintCheck,
  type BenchmarkOptions,
  type BenchmarkResult,
  type BenchmarkTotal,
  type BenchmarkVariant,
  type BenchmarkedPoint,
  type IndicatorPoint,
  type QuarterlyGrowthPoint,
} from './benchmark';

/**
 * Engine version, pinned into `method_version` when a compilation runs so any
 * published figure can be re-computed from stored inputs (non-negotiable 1).
 * Bump on any change to a computed result; record the reason in DECISIONS.md.
 */
export const ENGINE_VERSION = '0.1.0';
