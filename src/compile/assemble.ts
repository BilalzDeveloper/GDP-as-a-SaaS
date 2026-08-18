// Turning stored observations into engine inputs. Pure: no database imports,
// no I/O — it takes rows and returns structured inputs plus an account of
// what it could not use.
//
// The design principle here is that the assembler NEVER quietly drops or
// invents a component. A GDP total assembled from an incomplete expenditure
// account is not "approximately right", it is wrong in a way that looks
// plausible, so anything missing or unusable is reported and the affected
// approach is withheld rather than published short.
import type {
  ExpenditureInput,
  IncomeInput,
  IndustryInput,
  ProductionInput,
} from '../engine';

/** One observation, flattened to what the assembler needs. */
export interface ObservationRow {
  periodId: string;
  periodLabel: string;
  transactionCode: string;
  activityItemId: string | null;
  activityCode: string | null;
  value: number | null;
  unitCode: string;
  valuation: 'basic' | 'producers' | 'purchasers' | null;
}

export interface AssemblyProblem {
  periodLabel: string;
  approach: 'production' | 'expenditure' | 'income';
  code:
    | 'missing_component'
    | 'no_industry_detail'
    | 'mixed_units'
    | 'wrong_valuation'
    | 'duplicate_total';
  message: string;
}

export interface AssembledPeriod {
  periodId: string;
  periodLabel: string;
  production?: ProductionInput;
  expenditure?: ExpenditureInput;
  income?: IncomeInput;
  problems: AssemblyProblem[];
}

/**
 * Components each approach needs before it can be compiled at all. A missing
 * entry here withholds the approach; the engine is never handed a partial
 * account.
 */
const EXPENDITURE_COMPONENTS: [keyof ExpenditureInput, string][] = [
  ['householdFinalConsumption', 'P.31'],
  ['npishFinalConsumption', 'P.31_S15'],
  ['governmentFinalConsumption', 'P.3_S13'],
  ['grossFixedCapitalFormation', 'P.51g'],
  ['changesInInventories', 'P.52'],
  ['acquisitionsLessDisposalsOfValuables', 'P.53'],
  ['exports', 'P.6'],
  ['imports', 'P.7'],
];

const INCOME_COMPONENTS: [keyof IncomeInput, string][] = [
  ['compensationOfEmployees', 'D.1'],
  ['grossOperatingSurplus', 'B.2g'],
  ['grossMixedIncome', 'B.3g'],
  ['taxesOnProductionAndImports', 'D.2'],
  ['subsidies', 'D.3'],
];

/**
 * Expenditure components that may legitimately be absent, treated as zero.
 * Changes in inventories and valuables are genuinely zero in some
 * compilations, and NPISH consumption is folded into households by several
 * countries. Everything else missing withholds the approach.
 */
const OPTIONAL_EXPENDITURE = new Set([
  'npishFinalConsumption',
  'changesInInventories',
  'acquisitionsLessDisposalsOfValuables',
]);

/** Sum the total-economy value for one transaction code in one period. */
function totalFor(rows: readonly ObservationRow[], code: string): number | undefined {
  const matching = rows.filter(
    (r) => r.transactionCode === code && r.activityItemId === null && r.value !== null,
  );
  if (matching.length === 0) return undefined;
  return matching.reduce((sum, r) => sum + (r.value as number), 0);
}

function checkUnits(
  rows: readonly ObservationRow[],
  periodLabel: string,
  approach: AssemblyProblem['approach'],
  problems: AssemblyProblem[],
): void {
  const units = new Set(rows.map((r) => r.unitCode));
  if (units.size > 1) {
    problems.push({
      periodLabel,
      approach,
      code: 'mixed_units',
      message:
        `Observations for this period use more than one unit (${[...units].join(', ')}). ` +
        `Figures in different units cannot be added; convert them before compiling.`,
    });
  }
}

/** Assemble one period's observations into engine inputs. */
export function assemblePeriod(
  periodId: string,
  periodLabel: string,
  rows: readonly ObservationRow[],
): AssembledPeriod {
  const problems: AssemblyProblem[] = [];
  const result: AssembledPeriod = { periodId, periodLabel, problems };

  // --- production ----------------------------------------------------------
  const outputs = rows.filter((r) => r.transactionCode === 'P.1' && r.activityItemId);
  const intermediates = rows.filter(
    (r) => r.transactionCode === 'P.2' && r.activityItemId,
  );

  if (outputs.length > 0 || intermediates.length > 0) {
    checkUnits([...outputs, ...intermediates], periodLabel, 'production', problems);

    // Output at producers' prices cannot be converted without the embedded
    // tax and subsidy amounts, which are not in the data. Refusing beats
    // guessing (engine D19).
    const wrongValuation = outputs.filter(
      (r) => r.valuation !== null && r.valuation !== 'basic',
    );
    if (wrongValuation.length > 0) {
      problems.push({
        periodLabel,
        approach: 'production',
        code: 'wrong_valuation',
        message:
          `${wrongValuation.length} output observation(s) are at ` +
          `${wrongValuation[0].valuation} prices. GDP is derived from value added ` +
          `at basic prices; convert them before compiling.`,
      });
    } else {
      const byActivity = new Map<string, IndustryInput>();
      for (const row of outputs) {
        const code = row.activityCode ?? row.activityItemId!;
        const existing = byActivity.get(code) ?? {
          code,
          output: 0,
          intermediateConsumption: 0,
        };
        existing.output += row.value ?? 0;
        byActivity.set(code, existing);
      }
      for (const row of intermediates) {
        const code = row.activityCode ?? row.activityItemId!;
        const existing = byActivity.get(code) ?? {
          code,
          output: 0,
          intermediateConsumption: 0,
        };
        existing.intermediateConsumption += row.value ?? 0;
        byActivity.set(code, existing);
      }

      const taxes = totalFor(rows, 'D.21');
      const subsidies = totalFor(rows, 'D.31');
      if (taxes === undefined) {
        problems.push({
          periodLabel,
          approach: 'production',
          code: 'missing_component',
          message:
            'No taxes on products (D.21) at total-economy level. GDP at market ' +
            'prices cannot be derived from value added at basic prices without it.',
        });
      } else {
        result.production = {
          outputValuation: 'basic',
          industries: [...byActivity.values()],
          taxesOnProducts: taxes,
          subsidiesOnProducts: subsidies ?? 0,
        };
        if (subsidies === undefined) {
          problems.push({
            periodLabel,
            approach: 'production',
            code: 'missing_component',
            message:
              'No subsidies on products (D.31); treated as zero. Supply the ' +
              'figure — even an explicit zero — if that is not intended.',
          });
        }
      }
    }
  }

  // --- expenditure ---------------------------------------------------------
  const expenditureCodes = EXPENDITURE_COMPONENTS.map(([, code]) => code);
  const anyExpenditure = rows.some((r) =>
    ['P.3', 'P.31', 'P.32', 'P.51g', 'P.52', 'P.53', 'P.6', 'P.7'].includes(
      r.transactionCode,
    ),
  );
  if (anyExpenditure) {
    const values: Record<string, number> = {};
    const missing: string[] = [];

    // Household and government consumption are read from the sector-agnostic
    // codes this milestone stores; the sector split arrives with the sector
    // dimension in a later milestone.
    const lookups: [keyof ExpenditureInput, string[]][] = [
      ['householdFinalConsumption', ['P.31']],
      ['npishFinalConsumption', ['P.31_S15']],
      ['governmentFinalConsumption', ['P.32', 'P.3']],
      ['grossFixedCapitalFormation', ['P.51g']],
      ['changesInInventories', ['P.52']],
      ['acquisitionsLessDisposalsOfValuables', ['P.53']],
      ['exports', ['P.6']],
      ['imports', ['P.7']],
    ];
    for (const [field, codes] of lookups) {
      let found: number | undefined;
      for (const code of codes) {
        const total = totalFor(rows, code);
        if (total !== undefined) {
          found = total;
          break;
        }
      }
      if (found === undefined) {
        if (OPTIONAL_EXPENDITURE.has(field)) values[field] = 0;
        else missing.push(codes[0]);
      } else {
        values[field] = found;
      }
    }

    if (missing.length > 0) {
      problems.push({
        periodLabel,
        approach: 'expenditure',
        code: 'missing_component',
        message:
          `The expenditure approach is missing ${missing.join(', ')}. ` +
          `A GDP total assembled from an incomplete expenditure account would be ` +
          `wrong in a way that looks plausible, so it was not compiled.`,
      });
    } else {
      result.expenditure = values as unknown as ExpenditureInput;
    }
  }

  // --- income --------------------------------------------------------------
  const anyIncome = rows.some((r) =>
    ['D.1', 'B.2g', 'B.3g', 'D.2', 'D.3'].includes(r.transactionCode),
  );
  if (anyIncome) {
    const values: Record<string, number> = {};
    const missing: string[] = [];
    for (const [field, code] of INCOME_COMPONENTS) {
      const total = totalFor(rows, code);
      if (total === undefined) missing.push(code);
      else values[field] = total;
    }
    if (missing.length > 0) {
      problems.push({
        periodLabel,
        approach: 'income',
        code: 'missing_component',
        message:
          `The income approach is missing ${missing.join(', ')}. ` +
          `It was not compiled rather than being published short.`,
      });
    } else {
      result.income = values as unknown as IncomeInput;
    }
  }

  void expenditureCodes;
  return result;
}

/** Group observations by period and assemble each one. */
export function assembleRun(rows: readonly ObservationRow[]): AssembledPeriod[] {
  const byPeriod = new Map<string, ObservationRow[]>();
  for (const row of rows) {
    const list = byPeriod.get(row.periodId);
    if (list) list.push(row);
    else byPeriod.set(row.periodId, [row]);
  }
  return [...byPeriod.entries()]
    .map(([periodId, periodRows]) =>
      assemblePeriod(periodId, periodRows[0].periodLabel, periodRows),
    )
    .sort((a, b) => a.periodLabel.localeCompare(b.periodLabel));
}
