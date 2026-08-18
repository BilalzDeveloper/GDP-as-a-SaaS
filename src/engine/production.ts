// Production approach. SNA 2008 ch.6 (production account) and ch.7 (taxes and
// subsidies on products).
//
// Identities implemented:
//   B.1g (by industry) = P.1 output − P.2 intermediate consumption
//   GDP at market prices = Σ B.1g at basic prices + D.21 − D.31
import type {
  Diagnostic,
  FisimInput,
  ImputedRentInput,
  IndustryInput,
  IndustryValueAdded,
  Money,
  ProductionInput,
  ProductionResult,
} from './types';
import { approximatelyEqual, assertFinite, sum, sumBy } from './numeric';

/**
 * Convert output at producers' prices to basic prices. SNA 2008 ch.6: basic
 * price is what the producer retains per unit — it excludes taxes on products
 * payable and includes subsidies on products receivable, whereas the
 * producers' price includes those taxes (other than deductible VAT) and
 * excludes the subsidies.
 *
 * Exported separately, and required before GDP is computed, because the brief
 * is explicit that valuation conversions must never be implicit.
 */
export function basicPricesFromProducers(
  outputAtProducersPrices: Money,
  taxesOnProductsIncluded: Money,
  subsidiesOnProductsExcluded: Money,
): Money {
  assertFinite(outputAtProducersPrices, 'outputAtProducersPrices');
  assertFinite(taxesOnProductsIncluded, 'taxesOnProductsIncluded');
  assertFinite(subsidiesOnProductsExcluded, 'subsidiesOnProductsExcluded');
  return (
    outputAtProducersPrices - taxesOnProductsIncluded + subsidiesOnProductsExcluded
  );
}

/**
 * Gross value added for one industry. SNA 2008 ch.6: value added is the
 * balancing item of the production account, output less intermediate
 * consumption, "gross" meaning before deduction of consumption of fixed
 * capital (P.51c).
 */
export function grossValueAdded(
  output: Money,
  intermediateConsumption: Money,
): Money {
  assertFinite(output, 'output');
  assertFinite(intermediateConsumption, 'intermediateConsumption');
  return output - intermediateConsumption;
}

/**
 * Apply the FISIM allocation to industry inputs. SNA 2008 ch.6 and ch.17:
 * financial intermediation services indirectly measured are output of
 * financial corporations, allocated among the users that consume them.
 *
 * Under 'allocated' (the SNA 2008 treatment) the portion consumed by
 * producers raises their intermediate consumption — which exactly offsets the
 * financial corporations' output already counted, so it is GDP-neutral —
 * while the portion consumed by households, government and non-residents is
 * final use and therefore raises GDP.
 *
 * Under 'unallocated' (permitted under SNA 1993 and still encountered) the
 * whole of FISIM is treated as intermediate consumption of a nominal
 * industry, contributing nothing to GDP. Callers choosing this must also
 * exclude FISIM from final consumption on the expenditure side.
 */
function applyFisim(
  industries: readonly IndustryInput[],
  fisim: FisimInput,
  diagnostics: Diagnostic[],
): IndustryInput[] {
  const treatment = fisim.treatment ?? 'allocated';
  const allocated = sum([
    ...Object.values(fisim.intermediateByIndustry),
    fisim.householdFinalConsumption,
    fisim.governmentFinalConsumption,
    fisim.exports,
  ]);

  // The allocation must exhaust the output; a shortfall or excess means the
  // compilation is out of balance before GDP is even computed.
  if (!approximatelyEqual(allocated, fisim.totalOutput, 1e-9, 1e-6)) {
    diagnostics.push({
      code: 'fisim_allocation_mismatch',
      severity: 'warning',
      message:
        `FISIM allocations total ${allocated} but FISIM output is ` +
        `${fisim.totalOutput}; the difference of ${allocated - fisim.totalOutput} ` +
        `will distort value added.`,
      subject: 'fisim',
    });
  }

  if (treatment === 'unallocated') {
    // A nominal industry consumes the entire FISIM output as intermediate
    // consumption, cancelling it out of value added.
    return [
      ...industries.map((i) => ({ ...i })),
      {
        code: '_fisim_nominal',
        output: 0,
        intermediateConsumption: fisim.totalOutput,
      },
    ];
  }

  const byCode = new Map(industries.map((i) => [i.code, { ...i }]));
  for (const [code, amount] of Object.entries(fisim.intermediateByIndustry)) {
    const industry = byCode.get(code);
    if (!industry) {
      diagnostics.push({
        code: 'component_missing',
        severity: 'warning',
        message:
          `FISIM of ${amount} is allocated to industry ${code}, which is not ` +
          `among the industries supplied; the allocation was ignored.`,
        subject: code,
      });
      continue;
    }
    industry.intermediateConsumption += amount;
  }
  return [...byCode.values()];
}

/** Fold imputed dwelling services into the industry that records them. */
function applyImputedRent(
  industries: readonly IndustryInput[],
  imputedRent: ImputedRentInput,
): IndustryInput[] {
  const result = industries.map((i) => ({ ...i }));
  const target = result.find((i) => i.code === imputedRent.industryCode);
  if (target) {
    target.output += imputedRent.output;
    target.intermediateConsumption += imputedRent.intermediateConsumption;
    return result;
  }
  return [
    ...result,
    {
      code: imputedRent.industryCode,
      output: imputedRent.output,
      intermediateConsumption: imputedRent.intermediateConsumption,
    },
  ];
}

/**
 * GDP by the production approach. SNA 2008 ch.6 and ch.7:
 *
 *   GDP at market prices
 *     = Σ gross value added at basic prices
 *     + taxes on products (D.21)
 *     − subsidies on products (D.31)
 *
 * Taxes and subsidies on products are added at the total-economy level rather
 * than by industry because they are levied on products, not on the producing
 * units, and the industry breakdown of value added is at basic prices.
 */
export function computeProductionApproach(
  input: ProductionInput,
): ProductionResult {
  const diagnostics: Diagnostic[] = [];

  if (input.outputValuation !== 'basic') {
    // Refusing rather than guessing: converting producers' to basic prices
    // needs the tax and subsidy amounts embedded in the output figure, which
    // the caller has and the engine does not.
    throw new Error(
      'Production approach requires output at basic prices. Convert with ' +
        'basicPricesFromProducers() and set outputValuation to "basic".',
    );
  }

  assertFinite(input.taxesOnProducts, 'taxesOnProducts');
  assertFinite(input.subsidiesOnProducts, 'subsidiesOnProducts');

  let industries: IndustryInput[] = input.industries.map((i) => {
    assertFinite(i.output, `industry ${i.code} output`);
    assertFinite(
      i.intermediateConsumption,
      `industry ${i.code} intermediateConsumption`,
    );
    return { ...i };
  });

  if (input.imputedRent) {
    industries = applyImputedRent(industries, input.imputedRent);
  }
  if (input.fisim) {
    industries = applyFisim(industries, input.fisim, diagnostics);
  }

  const perIndustry: IndustryValueAdded[] = industries.map((i) => ({
    code: i.code,
    output: i.output,
    intermediateConsumption: i.intermediateConsumption,
    grossValueAdded: grossValueAdded(i.output, i.intermediateConsumption),
  }));

  // Negative value added is possible and occasionally genuine (a bad year for
  // a small industry), but it is far more often a mapping or sign error, so
  // it is surfaced rather than passed over.
  for (const industry of perIndustry) {
    if (industry.grossValueAdded < 0) {
      diagnostics.push({
        code: 'negative_value_added',
        severity: 'warning',
        message:
          `Industry ${industry.code} has negative gross value added ` +
          `(${industry.grossValueAdded}). Genuine in rare cases; usually a ` +
          `sign or mapping error.`,
        subject: industry.code,
      });
    }
  }

  const totalGrossValueAdded = sumBy(perIndustry, (i) => i.grossValueAdded);
  const gdp =
    totalGrossValueAdded + input.taxesOnProducts - input.subsidiesOnProducts;

  return {
    industries: perIndustry,
    totalGrossValueAdded,
    taxesOnProducts: input.taxesOnProducts,
    subsidiesOnProducts: input.subsidiesOnProducts,
    gdp,
    diagnostics,
  };
}
