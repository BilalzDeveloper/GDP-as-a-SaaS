// The controlled vocabulary for `compilation_result.measure`.
//
// Kept small and explicit rather than free-form: these strings are what a
// reviewer, an export and any future API all key on, so they are part of the
// product's contract.
export const MEASURE = {
  /** GDP at market prices by the approach named on the row. */
  gdp: 'gdp',
  /** Σ gross value added at basic prices (production only). */
  totalGrossValueAdded: 'total_gross_value_added',
  /** B.1g for one industry — the row carries activity_item_id. */
  grossValueAdded: 'gross_value_added',
  /** P.1 for one industry, as used after FISIM and imputed rent. */
  output: 'output',
  /** P.2 for one industry, as used. */
  intermediateConsumption: 'intermediate_consumption',
  taxesOnProducts: 'taxes_on_products',
  subsidiesOnProducts: 'subsidies_on_products',
  finalConsumptionExpenditure: 'final_consumption_expenditure',
  grossCapitalFormation: 'gross_capital_formation',
  netExports: 'net_exports',
  totalFactorIncomes: 'total_factor_incomes',
  netTaxesOnProductionAndImports: 'net_taxes_on_production_and_imports',
  /** Headline − this approach's estimate (summary rows). */
  statisticalDiscrepancy: 'statistical_discrepancy',
  /** The published figure, per the run's anchor (summary row). */
  headlineGdp: 'headline_gdp',
} as const;

export type Measure = (typeof MEASURE)[keyof typeof MEASURE];
