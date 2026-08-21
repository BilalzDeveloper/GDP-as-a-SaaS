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
  FisimInput,
  FisimTreatment,
  ImputedRentInput,
  IncomeInput,
  IndustryInput,
  ProductionInput,
} from '../engine';

/** One observation, flattened to what the assembler needs. */
export interface ObservationRow {
  /** The stored observation this came from, for recording provenance. */
  observationId: string;
  periodId: string;
  periodLabel: string;
  transactionCode: string;
  activityItemId: string | null;
  activityCode: string | null;
  sectorItemId: string | null;
  sectorCode: string | null;
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
    | 'duplicate_total'
    | 'adjustment_incomplete'
    | 'sector_coverage';
  message: string;
}

/**
 * Compilation choices that reach the engine but are not in the data.
 *
 * Both change published figures, so both are pinned into the run's method
 * version rather than being decided per execution (migration 0010).
 */
export interface AssemblyOptions {
  /** SNA 2008 'allocated' by default; 'unallocated' is the SNA 1993 fallback. */
  fisimTreatment?: FisimTreatment;
  /**
   * Whether the household final consumption figure already includes imputed
   * rent. Undefined means the compiler has not said, which the engine reports
   * rather than assumes.
   */
  expenditureIncludesImputedRent?: boolean;
}

/** Codes the assembler consumes as adjustments rather than as flows. */
const FISIM = {
  output: 'FISIM.P1',
  intermediate: 'FISIM.P2',
  household: 'FISIM.P31',
  government: 'FISIM.P3',
  exports: 'FISIM.P6',
} as const;

const IMPUTED_RENT = { output: 'IMPRENT.P1', intermediate: 'IMPRENT.P2' } as const;

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
  ['npishFinalConsumption', 'P.3'],
  ['governmentFinalConsumption', 'P.3'],
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

/**
 * Institutional sectors the three final-consumption components belong to.
 * SNA 2008 ch.4: S.13 general government, S.14 households, S.15 NPISH.
 */
const CONSUMPTION_SECTOR = {
  householdFinalConsumption: 'S.14',
  npishFinalConsumption: 'S.15',
  governmentFinalConsumption: 'S.13',
} as const;

/**
 * Consumption codes each component may be filed on.
 *
 * P.3 is final consumption expenditure; P.31 its individual part and P.32 its
 * collective part (SNA 2008 §9.42). Households and NPISH have no collective
 * consumption, so P.32 belongs to government alone.
 */
const CONSUMPTION_CODES = {
  householdFinalConsumption: ['P.3', 'P.31'],
  npishFinalConsumption: ['P.3', 'P.31'],
  governmentFinalConsumption: ['P.3', 'P.31', 'P.32'],
} as const;

/**
 * A row that speaks for the economy as a whole rather than for one sector:
 * no sector at all, or the total-economy sector S.1 named explicitly.
 *
 * The two are the same statement but not the same evidence. A blank sector
 * means the compilation does not keep the dimension, and the transaction code
 * alone has to say whose consumption it is. An explicit S.1 means the
 * compiler has the dimension and has used it to say "every sector at once" —
 * which is precisely not any one sector's figure, so it is never read as one.
 */
function isTotalEconomy(row: ObservationRow): boolean {
  return row.sectorCode === null || row.sectorCode === 'S.1';
}

/**
 * SNA sector codes nest by prefix — S.1311 central government is within S.13
 * general government, S.141 employers within S.14 households — so a
 * compilation may file consumption at whatever level of detail it keeps and
 * still have it reach the right component.
 *
 * Only ever called with S.13, S.14 or S.15, which is what makes plain prefix
 * matching safe: every code beginning "S.13" is a government sub-sector. It
 * would NOT be safe against S.1, where every code in the economy matches.
 */
function withinSector(code: string | null, sector: string): boolean {
  return code !== null && code.startsWith(sector);
}

/**
 * One final-consumption component, resolved by institutional sector where the
 * compilation supplies one and by transaction code alone where it does not.
 *
 * A compilation that files consumption against sectors and one that files it
 * on separate codes are both legitimate, and this reads either. What it will
 * not do is read a mixture: a total-economy P.31 sitting alongside
 * sector-split P.31 rows is either a double count or a residual, and only the
 * compiler knows which. Summing them would produce a household figure that
 * silently contains NPISH and government consumption too — a number that
 * looks entirely ordinary in a published table.
 */
function consumptionFor(
  rows: readonly ObservationRow[],
  field: keyof typeof CONSUMPTION_SECTOR,
  periodLabel: string,
  problems: AssemblyProblem[],
): number | undefined {
  const sector = CONSUMPTION_SECTOR[field];
  const codes: readonly string[] = CONSUMPTION_CODES[field];
  const usable = rows.filter(
    (r) =>
      codes.includes(r.transactionCode) && r.activityItemId === null && r.value !== null,
  );

  const bySector = usable.filter((r) => withinSector(r.sectorCode, sector));
  const totals = usable.filter(isTotalEconomy);

  if (bySector.length > 0 && totals.length > 0) {
    problems.push({
      periodLabel,
      approach: 'expenditure',
      code: 'sector_coverage',
      message:
        `Final consumption for ${sector} is supplied both against the sector ` +
        `and as a total-economy figure on ${[...new Set(totals.map((r) => r.transactionCode))].join(', ')}. ` +
        `One of them is a double count and the other a residual, and which is ` +
        `which is a judgement only the compiler can make, so neither was used.`,
    });
    return undefined;
  }

  if (bySector.length > 0) {
    return bySector.reduce((sum, r) => sum + (r.value as number), 0);
  }

  // No sector dimension in this compilation. Fall back to the code alone —
  // but only where the code identifies the sector unambiguously, which rules
  // out P.3 and P.31: an unqualified "final consumption expenditure" belongs
  // to no sector in particular.
  const unambiguous: Partial<Record<keyof typeof CONSUMPTION_SECTOR, string>> = {
    householdFinalConsumption: 'P.31',
    governmentFinalConsumption: 'P.32',
  };
  const code = unambiguous[field];
  if (!code) return undefined;
  const sectorless = usable.filter((r) => r.transactionCode === code && r.sectorCode === null);
  if (sectorless.length === 0) return undefined;
  const total = sectorless.reduce((sum, r) => sum + (r.value as number), 0);

  // P.32 is collective consumption only. Government final consumption
  // expenditure is P.3 of S.13 and also covers the individual services
  // government provides to households — health and education above all
  // (SNA 2008 §9.114). Taking P.32 for the whole understates it, often by
  // more than half, so this is said rather than assumed away.
  if (code === 'P.32') {
    problems.push({
      periodLabel,
      approach: 'expenditure',
      code: 'sector_coverage',
      message:
        `Government final consumption was taken from P.32, which is collective ` +
        `consumption only. It excludes the individual services government ` +
        `provides to households, so the figure understates it. File ` +
        `consumption against sector S.13 to have both parts counted.`,
    });
  }
  return total;
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

/**
 * FISIM as the engine wants it, or undefined when the compilation has none.
 *
 * The allocation itself is checked by the engine (`applyFisim` verifies the
 * parts exhaust the total). What the assembler adds is the refusal to build a
 * half-specified input: a total with no allocation, or an allocation with no
 * total, would let the engine compute a figure from a statement the compiler
 * never made. Either way the adjustment is withheld and reported.
 */
function assembleFisim(
  rows: readonly ObservationRow[],
  periodLabel: string,
  treatment: FisimTreatment | undefined,
  problems: AssemblyProblem[],
): FisimInput | undefined {
  const intermediateRows = rows.filter(
    (r) => r.transactionCode === FISIM.intermediate && r.value !== null,
  );
  const totalOutput = totalFor(rows, FISIM.output);
  const household = totalFor(rows, FISIM.household);
  const government = totalFor(rows, FISIM.government);
  const exports = totalFor(rows, FISIM.exports);

  const anyAllocation =
    intermediateRows.length > 0 ||
    household !== undefined ||
    government !== undefined ||
    exports !== undefined;
  if (totalOutput === undefined && !anyAllocation) return undefined;

  if (totalOutput === undefined) {
    problems.push({
      periodLabel,
      approach: 'production',
      code: 'adjustment_incomplete',
      message:
        `FISIM allocations are present but total FISIM output (${FISIM.output}) ` +
        'is not. Without it the allocation cannot be checked against what was ' +
        'produced, so the FISIM adjustment was not applied.',
    });
    return undefined;
  }
  if (!anyAllocation) {
    problems.push({
      periodLabel,
      approach: 'production',
      code: 'adjustment_incomplete',
      message:
        `Total FISIM output of ${totalOutput} is recorded but none of it is ` +
        'allocated to a user. The FISIM adjustment was not applied; supply the ' +
        `allocation on ${FISIM.intermediate}, ${FISIM.household}, ` +
        `${FISIM.government} and ${FISIM.exports}.`,
    });
    return undefined;
  }

  // Allocations to intermediate consumption are keyed by industry, which is
  // how the engine attaches each amount to the right industry.
  const intermediateByIndustry: Record<string, number> = {};
  for (const row of intermediateRows) {
    const code = row.activityCode ?? row.activityItemId;
    if (!code) {
      problems.push({
        periodLabel,
        approach: 'production',
        code: 'adjustment_incomplete',
        message:
          `A FISIM intermediate-consumption figure of ${row.value} carries no ` +
          'industry, so it cannot be attributed. It was left out of the ' +
          'allocation, which the engine will report as a shortfall.',
      });
      continue;
    }
    intermediateByIndustry[code] =
      (intermediateByIndustry[code] ?? 0) + (row.value as number);
  }

  return {
    totalOutput,
    intermediateByIndustry,
    householdFinalConsumption: household ?? 0,
    governmentFinalConsumption: government ?? 0,
    exports: exports ?? 0,
    treatment,
  };
}

/**
 * Imputed rent for owner-occupied dwellings, or undefined when absent.
 *
 * Output without intermediate consumption is legitimate — some compilations
 * record none — but the two must belong to the same industry, because the
 * engine folds them into one. Two different industries is a mapping error,
 * and applying it would move value added to the wrong place.
 */
function assembleImputedRent(
  rows: readonly ObservationRow[],
  periodLabel: string,
  problems: AssemblyProblem[],
): ImputedRentInput | undefined {
  const outputRows = rows.filter(
    (r) => r.transactionCode === IMPUTED_RENT.output && r.value !== null,
  );
  const intermediateRows = rows.filter(
    (r) => r.transactionCode === IMPUTED_RENT.intermediate && r.value !== null,
  );
  if (outputRows.length === 0 && intermediateRows.length === 0) return undefined;

  if (outputRows.length === 0) {
    problems.push({
      periodLabel,
      approach: 'production',
      code: 'adjustment_incomplete',
      message:
        'Intermediate consumption of owner-occupied dwelling services is ' +
        `recorded but the imputed output (${IMPUTED_RENT.output}) is not. ` +
        'The imputed-rent adjustment was not applied.',
    });
    return undefined;
  }

  const industries = new Set(
    [...outputRows, ...intermediateRows]
      .map((r) => r.activityCode ?? r.activityItemId)
      .filter((code): code is string => !!code),
  );
  if (industries.size === 0) {
    problems.push({
      periodLabel,
      approach: 'production',
      code: 'adjustment_incomplete',
      message:
        'Imputed dwelling services carry no industry, so the adjustment cannot ' +
        'be attached to one. It was not applied; map it to the industry that ' +
        'records housing services, typically ISIC division 68.',
    });
    return undefined;
  }
  if (industries.size > 1) {
    problems.push({
      periodLabel,
      approach: 'production',
      code: 'adjustment_incomplete',
      message:
        `Imputed dwelling services are split across industries ` +
        `(${[...industries].join(', ')}). The output and its intermediate ` +
        'consumption belong to one industry; the adjustment was not applied.',
    });
    return undefined;
  }

  return {
    industryCode: [...industries][0],
    output: outputRows.reduce((total, r) => total + (r.value as number), 0),
    intermediateConsumption: intermediateRows.reduce(
      (total, r) => total + (r.value as number),
      0,
    ),
  };
}

/** Assemble one period's observations into engine inputs. */
export function assemblePeriod(
  periodId: string,
  periodLabel: string,
  rows: readonly ObservationRow[],
  options: AssemblyOptions = {},
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
          // The engine applies these; the assembler only decides whether it
          // has been given a complete enough statement to pass on.
          fisim: assembleFisim(rows, periodLabel, options.fisimTreatment, problems),
          imputedRent: assembleImputedRent(rows, periodLabel, problems),
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

    // The three final-consumption components are the ones the institutional
    // sector matters for: they are the same transaction, told apart by who
    // does the consuming. Everything else is a total-economy figure on a code
    // of its own.
    for (const field of [
      'householdFinalConsumption',
      'npishFinalConsumption',
      'governmentFinalConsumption',
    ] as const) {
      const found = consumptionFor(rows, field, periodLabel, problems);
      if (found === undefined) {
        if (OPTIONAL_EXPENDITURE.has(field)) values[field] = 0;
        else {
          // Named so a compiler can act on it: which sector's consumption is
          // absent, and what would supply it.
          const sector = CONSUMPTION_SECTOR[field];
          const codes = CONSUMPTION_CODES[field].join('/');
          missing.push(`${sector} final consumption (${codes} against sector ${sector})`);
        }
      } else {
        values[field] = found;
      }
    }

    const lookups: [keyof ExpenditureInput, string[]][] = [
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
      result.expenditure = {
        ...(values as unknown as ExpenditureInput),
        // A statement by the compiler, not a figure from the data: whether
        // the household consumption above already includes imputed rent.
        // Undefined stays undefined — the engine reports "not stated"
        // differently from "no".
        includesImputedRent: options.expenditureIncludesImputedRent,
      };
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
export function assembleRun(
  rows: readonly ObservationRow[],
  options: AssemblyOptions = {},
): AssembledPeriod[] {
  const byPeriod = new Map<string, ObservationRow[]>();
  for (const row of rows) {
    const list = byPeriod.get(row.periodId);
    if (list) list.push(row);
    else byPeriod.set(row.periodId, [row]);
  }
  return [...byPeriod.entries()]
    .map(([periodId, periodRows]) =>
      assemblePeriod(periodId, periodRows[0].periodLabel, periodRows, options),
    )
    .sort((a, b) => a.periodLabel.localeCompare(b.periodLabel));
}
