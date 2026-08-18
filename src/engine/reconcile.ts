// Reconciliation across the three approaches. SNA 2008 ch.2: in principle the
// production, expenditure and income approaches yield the same total; in
// practice, independent source data means they differ, and the difference is
// the statistical discrepancy.
//
// This module does NOT make the approaches agree. It reports what each one
// says, names the anchor, and quantifies the gap. Forcing agreement is
// balancing, which belongs in the supply-and-use process (milestone 5+), and
// silently averaging would destroy the very signal a compiler needs.
import type {
  ApproachDiscrepancy,
  BalancingAnchor,
  CompilationOptions,
  CompilationResult,
  Diagnostic,
  ExpenditureInput,
  IncomeInput,
  Money,
  ProductionInput,
} from './types';
import { computeProductionApproach } from './production';
import { computeExpenditureApproach } from './expenditure';
import { computeIncomeApproach } from './income';

export interface CompilationInput {
  production?: ProductionInput;
  expenditure?: ExpenditureInput;
  income?: IncomeInput;
}

/**
 * Statistical discrepancy between an anchor estimate and another approach.
 * SNA 2008 ch.2. Sign convention: anchor − other, so a positive discrepancy
 * means the other approach falls short of the published figure.
 */
export function statisticalDiscrepancy(anchorGdp: Money, otherGdp: Money): Money {
  return anchorGdp - otherGdp;
}

/**
 * Compile GDP by whichever approaches have inputs, reconcile them, and report
 * the discrepancies.
 *
 * The anchor is configurable because there is no single correct answer: many
 * NSOs anchor annual estimates on the production approach, others on
 * expenditure, and some publish a figure balanced through supply-and-use
 * tables. With anchor 'none' every approach is reported and no headline is
 * chosen. See DECISIONS.md D17.
 */
export function compileGdp(
  input: CompilationInput,
  options: CompilationOptions = {},
): CompilationResult {
  const threshold = options.discrepancyWarningThreshold ?? 0.01;
  const diagnostics: Diagnostic[] = [];

  const production = input.production
    ? computeProductionApproach(input.production)
    : undefined;
  const expenditure = input.expenditure
    ? computeExpenditureApproach(input.expenditure)
    : undefined;
  const income = input.income ? computeIncomeApproach(input.income) : undefined;

  if (!production && !expenditure && !income) {
    throw new Error('compileGdp requires inputs for at least one approach');
  }

  for (const result of [production, expenditure, income]) {
    if (result) diagnostics.push(...result.diagnostics);
  }

  const estimates: { approach: ApproachDiscrepancy['approach']; gdp: Money }[] = [];
  if (production) estimates.push({ approach: 'production', gdp: production.gdp });
  if (expenditure) estimates.push({ approach: 'expenditure', gdp: expenditure.gdp });
  if (income) estimates.push({ approach: 'income', gdp: income.gdp });

  // An explicitly requested anchor must exist — silently publishing a
  // different approach than the one asked for would be a serious surprise.
  // Where no anchor is requested, prefer production (the common choice for
  // annual estimates), and fall back to the sole approach supplied when there
  // is only one, since then there is nothing to choose between.
  const anchor: BalancingAnchor =
    options.anchor ??
    (estimates.some((e) => e.approach === 'production')
      ? 'production'
      : estimates.length === 1
        ? estimates[0].approach
        : 'production');

  let headline: Money | null = null;
  if (anchor !== 'none') {
    const anchored = estimates.find((e) => e.approach === anchor);
    if (!anchored) {
      throw new Error(
        `Balancing anchor is "${anchor}" but no ${anchor} input was supplied`,
      );
    }
    headline = anchored.gdp;
  }

  const approaches: ApproachDiscrepancy[] = estimates.map((e) => {
    if (headline === null) {
      return { approach: e.approach, gdp: e.gdp, discrepancy: null, discrepancyPercent: null };
    }
    const discrepancy = statisticalDiscrepancy(headline, e.gdp);
    return {
      approach: e.approach,
      gdp: e.gdp,
      discrepancy,
      discrepancyPercent: headline === 0 ? null : (discrepancy / headline) * 100,
    };
  });

  // A large gap between independently sourced approaches is the single most
  // informative signal in a compilation; it gets a diagnostic, never a
  // silent adjustment.
  for (const a of approaches) {
    if (a.discrepancy === null || headline === null || a.approach === anchor) continue;
    const relative = headline === 0 ? 0 : Math.abs(a.discrepancy / headline);
    if (relative > threshold) {
      diagnostics.push({
        code: 'approaches_diverge',
        severity: 'warning',
        message:
          `The ${a.approach} approach gives ${a.gdp} against the ${anchor} ` +
          `anchor of ${headline}: a discrepancy of ${a.discrepancy} ` +
          `(${(relative * 100).toFixed(2)}% of the headline), above the ` +
          `${(threshold * 100).toFixed(2)}% threshold.`,
        subject: a.approach,
      });
    }
  }

  // Imputed dwelling services must appear on both sides of the account.
  if (input.production?.imputedRent && input.expenditure) {
    if (input.expenditure.includesImputedRent === false) {
      diagnostics.push({
        code: 'imputed_rent_not_in_expenditure',
        severity: 'warning',
        message:
          `Imputed rent of ${input.production.imputedRent.output} is recorded ` +
          `in production but household final consumption is declared to ` +
          `exclude it. The two sides of the account will not agree.`,
        subject: 'imputedRent',
      });
    } else if (input.expenditure.includesImputedRent === undefined) {
      diagnostics.push({
        code: 'imputed_rent_not_in_expenditure',
        severity: 'info',
        message:
          `Imputed rent of ${input.production.imputedRent.output} is recorded ` +
          `in production. Confirm household final consumption includes it and ` +
          `set includesImputedRent to record that it was checked.`,
        subject: 'imputedRent',
      });
    }
  }

  return { production, expenditure, income, gdp: headline, anchor, approaches, diagnostics };
}
