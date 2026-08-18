// Expenditure approach. SNA 2008 ch.9 (use of income / final consumption),
// ch.10 (capital formation) and ch.14 (supply and use, exports and imports).
//
// Identity implemented:
//   GDP at market prices
//     = household final consumption (P.31, S.14)
//     + NPISH final consumption (P.31, S.15)
//     + government final consumption (P.3, S.13)
//     + gross fixed capital formation (P.51g)
//     + changes in inventories (P.52)
//     + acquisitions less disposals of valuables (P.53)
//     + exports (P.6)
//     − imports (P.7)
import type {
  Diagnostic,
  ExpenditureInput,
  ExpenditureResult,
  Money,
} from './types';
import { assertFinite, sum } from './numeric';

/**
 * Final consumption expenditure of the three consuming sectors. SNA 2008
 * ch.9. Note this is final consumption EXPENDITURE (P.3), not actual final
 * consumption (P.4): the two differ by social transfers in kind, and only P.3
 * belongs in the GDP identity.
 */
export function finalConsumptionExpenditure(
  household: Money,
  npish: Money,
  government: Money,
): Money {
  return sum([household, npish, government]);
}

/**
 * Gross capital formation. SNA 2008 ch.10 — fixed capital formation plus the
 * two flows that are routinely mis-signed: changes in inventories, negative
 * when stocks are drawn down, and net acquisitions of valuables.
 */
export function grossCapitalFormation(
  grossFixedCapitalFormation: Money,
  changesInInventories: Money,
  acquisitionsLessDisposalsOfValuables: Money,
): Money {
  return sum([
    grossFixedCapitalFormation,
    changesInInventories,
    acquisitionsLessDisposalsOfValuables,
  ]);
}

/**
 * GDP by the expenditure approach. SNA 2008 ch.14: imports are deducted
 * because the identity measures domestic production, and imported goods and
 * services are embedded in the consumption and capital formation totals
 * above.
 *
 * `imports` is supplied as a positive amount and subtracted here — the sign
 * convention lives in one place rather than in every caller.
 */
export function computeExpenditureApproach(
  input: ExpenditureInput,
): ExpenditureResult {
  const diagnostics: Diagnostic[] = [];
  const fields: (keyof ExpenditureInput)[] = [
    'householdFinalConsumption',
    'npishFinalConsumption',
    'governmentFinalConsumption',
    'grossFixedCapitalFormation',
    'changesInInventories',
    'acquisitionsLessDisposalsOfValuables',
    'exports',
    'imports',
  ];
  for (const field of fields) {
    assertFinite(input[field] as number, field);
  }

  if (input.imports < 0) {
    diagnostics.push({
      code: 'component_missing',
      severity: 'warning',
      message:
        'Imports (P.7) were supplied as a negative amount. They are deducted ' +
        'by the engine, so a negative figure double-negates and inflates GDP.',
      subject: 'imports',
    });
  }

  const consumption = finalConsumptionExpenditure(
    input.householdFinalConsumption,
    input.npishFinalConsumption,
    input.governmentFinalConsumption,
  );
  const capitalFormation = grossCapitalFormation(
    input.grossFixedCapitalFormation,
    input.changesInInventories,
    input.acquisitionsLessDisposalsOfValuables,
  );
  const netExports = input.exports - input.imports;

  return {
    finalConsumptionExpenditure: consumption,
    grossCapitalFormation: capitalFormation,
    netExports,
    gdp: sum([consumption, capitalFormation, netExports]),
    diagnostics,
  };
}
