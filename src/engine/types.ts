// Calculation engine — input and output types.
//
// This module and everything else under src/engine/ is PURE: no database
// imports, no I/O, no dependencies. It takes structured inputs and returns
// structured outputs, so it is testable in isolation and portable.
//
// CITATION POLICY. Each function names the SNA 2008 chapter and states the
// identity or definition it implements. References are chapter-level rather
// than paragraph-level on purpose: this codebase was written without access
// to the manual, and a paragraph number quoted from memory is precisely what
// an auditing statistician would catch. The identities themselves are the
// substance and are stated in full so they can be checked directly. Pinning
// paragraph numbers is a review task — see docs/engine.md.

/**
 * A monetary amount in the compilation's unit of measure (see the `unit`
 * registry: currency, multiplier). The engine never converts units or
 * currencies — mixing scales is a compilation error, not something to paper
 * over silently.
 */
export type Money = number;

/** Valuation basis for output. SNA 2008 ch.6 — conversions must be explicit. */
export type OutputValuation = 'basic' | 'producers';

/** Which approach's estimate is published as the headline figure. */
export type BalancingAnchor = 'production' | 'expenditure' | 'income' | 'none';

/**
 * FISIM treatment. SNA 2008 ch.6 and ch.17 require FISIM to be allocated
 * among users. The unallocated convention (all FISIM as intermediate
 * consumption of a nominal industry, so it contributes nothing to GDP) was
 * permitted under SNA 1993 and remains in use in some compilations, so it is
 * offered as a configurable variant rather than assumed away.
 */
export type FisimTreatment = 'allocated' | 'unallocated';

export interface IndustryInput {
  /**
   * Classification item code — an ISIC division, a national industry code,
   * whatever the compilation uses. The engine is classification-agnostic by
   * design: 10 industries and 400 industries are the same code path.
   */
  code: string;
  /** P.1 output, at the valuation declared on ProductionInput. */
  output: Money;
  /**
   * P.2 intermediate consumption at purchasers' prices, EXCLUDING any FISIM
   * allocated to this industry — the engine adds that from `fisim`. Passing
   * FISIM-inclusive intermediate consumption alongside a `fisim` input would
   * double-count it. See docs/engine.md.
   */
  intermediateConsumption: Money;
}

export interface FisimInput {
  /**
   * Total FISIM output of financial corporations, already included in their
   * P.1 in `industries`.
   */
  totalOutput: Money;
  /** Allocation to intermediate consumption, keyed by industry code. */
  intermediateByIndustry: Record<string, Money>;
  /** FISIM consumed by households as final consumers (raises GDP). */
  householdFinalConsumption: Money;
  /** FISIM consumed by government as final consumption (raises GDP). */
  governmentFinalConsumption: Money;
  /** FISIM exported (raises GDP). */
  exports: Money;
  /** Defaults to 'allocated', the SNA 2008 treatment. */
  treatment?: FisimTreatment;
}

/**
 * Housing services produced and consumed by owner-occupiers. SNA 2008 ch.6:
 * these services are within the production boundary and are imputed, so they
 * appear both as output of the housing industry and as household final
 * consumption expenditure. Recording one without the other is a classic
 * compilation error; the engine emits a diagnostic to that effect.
 */
export interface ImputedRentInput {
  /** Industry the housing services belong to (typically ISIC division 68). */
  industryCode: string;
  /** Imputed output of owner-occupied dwelling services. */
  output: Money;
  /** Intermediate consumption of that production (maintenance, insurance). */
  intermediateConsumption: Money;
}

export interface ProductionInput {
  /**
   * Valuation of `industries[].output`. GDP is derived from value added at
   * BASIC prices; producers'-price output must be converted first with
   * `basicPricesFromProducers()` rather than accepted silently.
   */
  outputValuation: OutputValuation;
  industries: IndustryInput[];
  /** D.21 taxes on products. SNA 2008 ch.7. */
  taxesOnProducts: Money;
  /** D.31 subsidies on products, entered as a positive amount. */
  subsidiesOnProducts: Money;
  fisim?: FisimInput;
  imputedRent?: ImputedRentInput;
}

export interface ExpenditureInput {
  /** P.31 household final consumption expenditure (S.14). */
  householdFinalConsumption: Money;
  /** P.31 NPISH final consumption expenditure (S.15). */
  npishFinalConsumption: Money;
  /** P.3 general government final consumption expenditure (S.13). */
  governmentFinalConsumption: Money;
  /** P.51g gross fixed capital formation. */
  grossFixedCapitalFormation: Money;
  /** P.52 changes in inventories — legitimately negative when stocks fall. */
  changesInInventories: Money;
  /** P.53 acquisitions less disposals of valuables — may be negative. */
  acquisitionsLessDisposalsOfValuables: Money;
  /** P.6 exports of goods and services. */
  exports: Money;
  /** P.7 imports of goods and services, entered as a positive amount. */
  imports: Money;
  /**
   * Whether household final consumption includes imputed rent for
   * owner-occupied dwellings. Used only for a consistency diagnostic; the
   * engine never adjusts the figure on the caller's behalf.
   */
  includesImputedRent?: boolean;
}

export interface IncomeInput {
  /** D.1 compensation of employees. */
  compensationOfEmployees: Money;
  /** B.2g gross operating surplus. */
  grossOperatingSurplus: Money;
  /** B.3g gross mixed income. */
  grossMixedIncome: Money;
  /** D.2 taxes on production and imports (products plus other). */
  taxesOnProductionAndImports: Money;
  /** D.3 subsidies (products plus other), entered as a positive amount. */
  subsidies: Money;
}

/** A problem or caution worth a compiler's attention, short of an error. */
export interface Diagnostic {
  code:
    | 'fisim_allocation_mismatch'
    | 'imputed_rent_not_in_expenditure'
    | 'negative_value_added'
    | 'component_missing'
    | 'approaches_diverge';
  severity: 'warning' | 'info';
  message: string;
  /** Where it applies — an industry code, a component name. */
  subject?: string;
}

export interface IndustryValueAdded {
  code: string;
  /** P.1 as used, after any FISIM and imputed-rent adjustments. */
  output: Money;
  /** P.2 as used, after any FISIM allocation. */
  intermediateConsumption: Money;
  /** B.1g = P.1 − P.2. */
  grossValueAdded: Money;
}

export interface ProductionResult {
  /** Per-industry B.1g at basic prices. */
  industries: IndustryValueAdded[];
  /** Σ B.1g at basic prices. */
  totalGrossValueAdded: Money;
  taxesOnProducts: Money;
  subsidiesOnProducts: Money;
  /** GDP at market prices by the production approach. */
  gdp: Money;
  diagnostics: Diagnostic[];
}

export interface ExpenditureResult {
  /** Household + NPISH + government final consumption. */
  finalConsumptionExpenditure: Money;
  /** P.51g + P.52 + P.53. */
  grossCapitalFormation: Money;
  /** P.6 − P.7. */
  netExports: Money;
  /** GDP at market prices by the expenditure approach. */
  gdp: Money;
  diagnostics: Diagnostic[];
}

export interface IncomeResult {
  /** D.1 + B.2g + B.3g. */
  totalFactorIncomes: Money;
  /** D.2 − D.3. */
  netTaxesOnProductionAndImports: Money;
  /** GDP at market prices by the income approach. */
  gdp: Money;
  diagnostics: Diagnostic[];
}

export interface ApproachDiscrepancy {
  approach: 'production' | 'expenditure' | 'income';
  gdp: Money;
  /** headline − this approach's estimate. Null when there is no anchor. */
  discrepancy: Money | null;
  /** discrepancy as a percentage of the headline. Null when no anchor. */
  discrepancyPercent: number | null;
}

export interface CompilationResult {
  production?: ProductionResult;
  expenditure?: ExpenditureResult;
  income?: IncomeResult;
  /** The published figure, per the balancing anchor. Null when anchor 'none'. */
  gdp: Money | null;
  anchor: BalancingAnchor;
  approaches: ApproachDiscrepancy[];
  diagnostics: Diagnostic[];
}

export interface CompilationOptions {
  /**
   * Which approach anchors the published figure. Defaults to 'production'.
   * There is no universally correct choice: many NSOs anchor on production
   * for annual estimates, others on expenditure, and some publish a balanced
   * estimate reconciled through supply-and-use tables (out of scope until the
   * compilation workflow exists). Recorded in DECISIONS.md D17.
   */
  anchor?: BalancingAnchor;
  /**
   * Relative size (as a fraction of the headline) at which a discrepancy
   * between approaches raises a diagnostic. Defaults to 0.01 (1%).
   */
  discrepancyWarningThreshold?: number;
}
