// Volume measures: deflation, index numbers and chain-linking.
// SNA 2008 ch.15 (price and volume measures).
//
// Pure, like the rest of the engine. The central identity throughout:
//
//   value change = price change × volume change
//
// Everything here is a way of splitting an observed change in value into
// those two parts, and the choice of index formula is a choice about how.
import { assertFinite, approximatelyEqual, sum } from './numeric';
import type { Money } from './types';

/**
 * Index-number formula. SNA 2008 ch.15 discusses all three; Fisher is the
 * theoretically preferred "superlative" index but needs both periods' prices
 * AND quantities, which many compilations do not have at the detail required.
 */
export type IndexFormula = 'laspeyres' | 'paasche' | 'fisher';

/** A price–quantity pair for one product in one period. */
export interface PriceQuantity {
  /** Product or item code — used only to pair base and current observations. */
  code: string;
  price: number;
  quantity: number;
}

/** Index numbers are expressed on a base of 100 throughout this module. */
export const INDEX_BASE = 100;

function pairUp(
  base: readonly PriceQuantity[],
  current: readonly PriceQuantity[],
): { code: string; p0: number; q0: number; pt: number; qt: number }[] {
  const byCode = new Map(current.map((c) => [c.code, c]));
  const paired: { code: string; p0: number; q0: number; pt: number; qt: number }[] = [];
  for (const b of base) {
    const c = byCode.get(b.code);
    // An item present in only one period cannot contribute to a bilateral
    // index: there is no price relative to compute. Dropping it silently
    // would bias the index, so callers get the paired set they can check
    // against their inputs.
    if (!c) continue;
    paired.push({ code: b.code, p0: b.price, q0: b.quantity, pt: c.price, qt: c.quantity });
  }
  return paired;
}

/**
 * Laspeyres price index. SNA 2008 ch.15: prices of the current period valued
 * with BASE-period quantities.
 *
 *   L_p = Σ(p_t · q_0) / Σ(p_0 · q_0) × 100
 */
export function laspeyresPriceIndex(
  base: readonly PriceQuantity[],
  current: readonly PriceQuantity[],
): number {
  const pairs = pairUp(base, current);
  const numerator = sum(pairs.map((x) => x.pt * x.q0));
  const denominator = sum(pairs.map((x) => x.p0 * x.q0));
  if (denominator === 0) throw new RangeError('Laspeyres price index: base value is zero');
  return (numerator / denominator) * INDEX_BASE;
}

/**
 * Paasche price index. SNA 2008 ch.15: CURRENT-period quantities as weights.
 *
 *   P_p = Σ(p_t · q_t) / Σ(p_0 · q_t) × 100
 */
export function paaschePriceIndex(
  base: readonly PriceQuantity[],
  current: readonly PriceQuantity[],
): number {
  const pairs = pairUp(base, current);
  const numerator = sum(pairs.map((x) => x.pt * x.qt));
  const denominator = sum(pairs.map((x) => x.p0 * x.qt));
  if (denominator === 0) throw new RangeError('Paasche price index: base value is zero');
  return (numerator / denominator) * INDEX_BASE;
}

/**
 * Laspeyres volume index — quantities revalued at BASE-period prices.
 *
 *   L_q = Σ(q_t · p_0) / Σ(q_0 · p_0) × 100
 */
export function laspeyresVolumeIndex(
  base: readonly PriceQuantity[],
  current: readonly PriceQuantity[],
): number {
  const pairs = pairUp(base, current);
  const numerator = sum(pairs.map((x) => x.qt * x.p0));
  const denominator = sum(pairs.map((x) => x.q0 * x.p0));
  if (denominator === 0) throw new RangeError('Laspeyres volume index: base value is zero');
  return (numerator / denominator) * INDEX_BASE;
}

/** Paasche volume index — quantities revalued at CURRENT-period prices. */
export function paascheVolumeIndex(
  base: readonly PriceQuantity[],
  current: readonly PriceQuantity[],
): number {
  const pairs = pairUp(base, current);
  const numerator = sum(pairs.map((x) => x.qt * x.pt));
  const denominator = sum(pairs.map((x) => x.q0 * x.pt));
  if (denominator === 0) throw new RangeError('Paasche volume index: base value is zero');
  return (numerator / denominator) * INDEX_BASE;
}

/**
 * Fisher index — the geometric mean of Laspeyres and Paasche. SNA 2008 ch.15
 * treats it as the superlative index of choice: it satisfies the factor
 * reversal test, so the Fisher price index times the Fisher volume index
 * equals the change in value exactly.
 */
export function fisherIndex(laspeyres: number, paasche: number): number {
  assertFinite(laspeyres, 'laspeyres');
  assertFinite(paasche, 'paasche');
  if (laspeyres < 0 || paasche < 0) {
    throw new RangeError('Fisher index requires non-negative component indices');
  }
  return Math.sqrt(laspeyres * paasche);
}

/** Price index by the chosen formula. */
export function priceIndex(
  base: readonly PriceQuantity[],
  current: readonly PriceQuantity[],
  formula: IndexFormula,
): number {
  switch (formula) {
    case 'laspeyres':
      return laspeyresPriceIndex(base, current);
    case 'paasche':
      return paaschePriceIndex(base, current);
    case 'fisher':
      return fisherIndex(
        laspeyresPriceIndex(base, current),
        paaschePriceIndex(base, current),
      );
  }
}

/** Volume index by the chosen formula. */
export function volumeIndex(
  base: readonly PriceQuantity[],
  current: readonly PriceQuantity[],
  formula: IndexFormula,
): number {
  switch (formula) {
    case 'laspeyres':
      return laspeyresVolumeIndex(base, current);
    case 'paasche':
      return paascheVolumeIndex(base, current);
    case 'fisher':
      return fisherIndex(
        laspeyresVolumeIndex(base, current),
        paascheVolumeIndex(base, current),
      );
  }
}

/**
 * Deflate a current-price value with a price index to get a volume measure at
 * the index's reference-period prices. SNA 2008 ch.15 — deflation is the
 * usual practical route to volume measures, because price indices are more
 * readily available than the full price and quantity detail an index formula
 * needs.
 */
export function deflate(
  currentPriceValue: Money,
  priceIndexValue: number,
  indexBase = INDEX_BASE,
): Money {
  assertFinite(currentPriceValue, 'currentPriceValue');
  assertFinite(priceIndexValue, 'priceIndexValue');
  if (priceIndexValue === 0) {
    throw new RangeError('Cannot deflate by a zero price index');
  }
  return (currentPriceValue / priceIndexValue) * indexBase;
}

/**
 * A period's value expressed at the PREVIOUS period's prices — the building
 * block of chain-linking. Derived from the deflator's movement rather than
 * from price and quantity detail:
 *
 *   PYP_t = V_t × (P_{t−1} / P_t)
 *
 * which removes exactly the price change between t−1 and t, leaving t's
 * quantities valued at t−1's prices.
 */
export function previousYearPricesValue(
  currentPriceValue: Money,
  deflatorCurrent: number,
  deflatorPrevious: number,
): Money {
  assertFinite(currentPriceValue, 'currentPriceValue');
  assertFinite(deflatorCurrent, 'deflatorCurrent');
  assertFinite(deflatorPrevious, 'deflatorPrevious');
  if (deflatorCurrent === 0) {
    throw new RangeError('Cannot revalue with a zero current-period deflator');
  }
  return currentPriceValue * (deflatorPrevious / deflatorCurrent);
}

export interface SeriesPoint {
  periodLabel: string;
  /** Current-price value. */
  value: Money;
  /** Price index for the same period, any consistent base. */
  deflator: number;
}

export interface ChainLinkedPoint {
  periodLabel: string;
  /** Current-price value, unchanged. */
  currentPriceValue: Money;
  /** This period's value at the previous period's prices. Null for the first. */
  previousYearPricesValue: Money | null;
  /**
   * Year-on-year volume link: PYP_t / V_{t−1}. Null for the first period.
   * This is the growth factor the chain is built from.
   */
  link: number | null;
  /** Chained volume index, reference period = 100. */
  chainIndex: number;
  /**
   * Chain-linked volume, expressed in the reference period's price level:
   * referenceValue × chainIndex / 100.
   */
  chainLinkedValue: Money;
  /** Volume growth on the previous period, per cent. Null for the first. */
  volumeGrowthPercent: number | null;
}

export interface ChainLinkOptions {
  /**
   * Period whose price level the chain-linked series is expressed in, and
   * where the chain index equals 100. Defaults to the first period.
   */
  referencePeriodLabel?: string;
}

/**
 * Chain-link a series by the ANNUAL OVERLAP method. SNA 2008 ch.15.
 *
 * Each period's volume movement is measured at the previous period's prices,
 * and those year-on-year links are multiplied together into a continuous
 * series. Weights are therefore never more than one period out of date, which
 * is the point: a fixed-base series drifts as the economy's structure moves
 * away from the base year.
 *
 * Annual overlap is the variant used by most European compilers and by
 * Statistics Denmark. The alternatives — one-quarter overlap and
 * over-the-year linking — differ only for sub-annual data, where they trade
 * a step in the quarterly path against exact consistency with annual totals.
 * For annual data all three coincide. Recorded in DECISIONS.md D25.
 *
 * THE RESULT IS NOT ADDITIVE. Chain-linked components do not sum to the
 * chain-linked aggregate except in the reference period. See
 * `nonAdditivityResidual` and docs/volume-measures.md — users report this as
 * a bug, and it is not one.
 */
export function chainLink(
  series: readonly SeriesPoint[],
  options: ChainLinkOptions = {},
): ChainLinkedPoint[] {
  if (series.length === 0) return [];
  for (const point of series) {
    assertFinite(point.value, `value for ${point.periodLabel}`);
    assertFinite(point.deflator, `deflator for ${point.periodLabel}`);
    if (point.deflator <= 0) {
      throw new RangeError(
        `Deflator for ${point.periodLabel} must be positive, got ${point.deflator}`,
      );
    }
  }

  const referenceLabel = options.referencePeriodLabel ?? series[0].periodLabel;
  const referenceIdx = series.findIndex((p) => p.periodLabel === referenceLabel);
  if (referenceIdx === -1) {
    throw new RangeError(
      `Reference period "${referenceLabel}" is not in the series`,
    );
  }

  // Links first, then cumulate outward from the reference period so the
  // chain index is exactly 100 there.
  const links: (number | null)[] = series.map((point, i) => {
    if (i === 0) return null;
    const previous = series[i - 1];
    if (previous.value === 0) return null;
    const pyp = previousYearPricesValue(point.value, point.deflator, previous.deflator);
    return pyp / previous.value;
  });

  const chainIndex: number[] = new Array(series.length).fill(INDEX_BASE);
  for (let i = referenceIdx + 1; i < series.length; i++) {
    const link = links[i];
    chainIndex[i] = link === null ? chainIndex[i - 1] : chainIndex[i - 1] * link;
  }
  for (let i = referenceIdx - 1; i >= 0; i--) {
    const link = links[i + 1];
    chainIndex[i] = link === null || link === 0 ? chainIndex[i + 1] : chainIndex[i + 1] / link;
  }

  const referenceValue = series[referenceIdx].value;

  return series.map((point, i) => {
    const previous = i === 0 ? null : series[i - 1];
    const link = links[i];
    return {
      periodLabel: point.periodLabel,
      currentPriceValue: point.value,
      previousYearPricesValue:
        previous === null
          ? null
          : previousYearPricesValue(point.value, point.deflator, previous.deflator),
      link,
      chainIndex: chainIndex[i],
      chainLinkedValue: (referenceValue * chainIndex[i]) / INDEX_BASE,
      volumeGrowthPercent: link === null ? null : (link - 1) * 100,
    };
  });
}

/**
 * Chain-link an AGGREGATE from its components, by annual overlap.
 *
 * This is not the same as chain-linking the aggregate's own value with an
 * aggregate deflator, and the difference is the whole reason chained volumes
 * are non-additive. Here each year's link is
 *
 *   L_t = Σ_i PYP_{i,t} / Σ_i V_{i,t−1}
 *
 * — every component revalued at ITS OWN previous-year prices, then summed.
 * The aggregate therefore carries each year's actual composition, which a
 * fixed-base deflator applied to the aggregate value cannot reproduce.
 *
 * (If instead every series is deflated by a common fixed-base index, chaining
 * collapses to fixed-base deflation and the result IS additive. That is a
 * mathematical fact, not a shortcut: it is also why fixed-base constant-price
 * series add up and chained ones do not.)
 */
export function chainLinkAggregate(
  components: readonly (readonly SeriesPoint[])[],
  options: ChainLinkOptions = {},
): ChainLinkedPoint[] {
  if (components.length === 0) return [];
  const periodCount = components[0].length;
  for (const series of components) {
    if (series.length !== periodCount) {
      throw new RangeError(
        'All components must cover the same periods to be aggregated',
      );
    }
  }

  const labels = components[0].map((p) => p.periodLabel);
  const aggregateValues = labels.map((_, i) =>
    sum(components.map((series) => series[i].value)),
  );

  // Links from component PYP sums — the annual-overlap aggregation.
  const links: (number | null)[] = labels.map((_, i) => {
    if (i === 0) return null;
    const previousTotal = aggregateValues[i - 1];
    if (previousTotal === 0) return null;
    const pypTotal = sum(
      components.map((series) =>
        previousYearPricesValue(
          series[i].value,
          series[i].deflator,
          series[i - 1].deflator,
        ),
      ),
    );
    return pypTotal / previousTotal;
  });

  const referenceLabel = options.referencePeriodLabel ?? labels[0];
  const referenceIdx = labels.indexOf(referenceLabel);
  if (referenceIdx === -1) {
    throw new RangeError(`Reference period "${referenceLabel}" is not in the series`);
  }

  const chainIndex: number[] = new Array(labels.length).fill(INDEX_BASE);
  for (let i = referenceIdx + 1; i < labels.length; i++) {
    const link = links[i];
    chainIndex[i] = link === null ? chainIndex[i - 1] : chainIndex[i - 1] * link;
  }
  for (let i = referenceIdx - 1; i >= 0; i--) {
    const link = links[i + 1];
    chainIndex[i] = link === null || link === 0 ? chainIndex[i + 1] : chainIndex[i + 1] / link;
  }

  const referenceValue = aggregateValues[referenceIdx];

  return labels.map((label, i) => {
    const link = links[i];
    const pypTotal =
      i === 0
        ? null
        : sum(
            components.map((series) =>
              previousYearPricesValue(
                series[i].value,
                series[i].deflator,
                series[i - 1].deflator,
              ),
            ),
          );
    return {
      periodLabel: label,
      currentPriceValue: aggregateValues[i],
      previousYearPricesValue: pypTotal,
      link,
      chainIndex: chainIndex[i],
      chainLinkedValue: (referenceValue * chainIndex[i]) / INDEX_BASE,
      volumeGrowthPercent: link === null ? null : (link - 1) * 100,
    };
  });
}

export interface NonAdditivity {
  periodLabel: string;
  /** The chain-linked aggregate as compiled in its own right. */
  aggregate: Money;
  /** The sum of the chain-linked components. */
  sumOfComponents: Money;
  /** aggregate − Σ components. Zero in the reference period, otherwise not. */
  residual: Money;
  /** The residual as a percentage of the aggregate. */
  residualPercent: number;
  /** True where the residual is negligible — the reference period. */
  isAdditive: boolean;
}

/**
 * Measure how far chain-linked components fall short of (or exceed) their
 * chain-linked aggregate. SNA 2008 ch.15 is explicit that chained volume
 * measures are not additive: each series carries its own price weights from
 * its own periods, so their sum has no reason to equal an aggregate linked
 * with the aggregate's weights.
 *
 * Publishing the residual is standard practice precisely because the
 * alternative — quietly forcing the components to add up — would misstate
 * every component to preserve an arithmetic property the measure does not
 * have.
 */
export function nonAdditivityResidual(
  aggregate: readonly ChainLinkedPoint[],
  components: readonly ChainLinkedPoint[][],
): NonAdditivity[] {
  return aggregate.map((point, i) => {
    const sumOfComponents = sum(
      components.map((series) => series[i]?.chainLinkedValue ?? 0),
    );
    const residual = point.chainLinkedValue - sumOfComponents;
    return {
      periodLabel: point.periodLabel,
      aggregate: point.chainLinkedValue,
      sumOfComponents,
      residual,
      residualPercent:
        point.chainLinkedValue === 0 ? 0 : (residual / point.chainLinkedValue) * 100,
      isAdditive: approximatelyEqual(residual, 0, 1e-9, 1e-6),
    };
  });
}

/**
 * Implicit price deflator: the ratio of a current-price value to its volume
 * measure. SNA 2008 ch.15 — it is a Paasche-type index derived after the
 * fact, not an independently compiled price index, which is why it can move
 * differently from the deflators used to build the volume series.
 */
export function implicitPriceDeflator(
  currentPriceValue: Money,
  volumeValue: Money,
): number {
  assertFinite(currentPriceValue, 'currentPriceValue');
  assertFinite(volumeValue, 'volumeValue');
  if (volumeValue === 0) {
    throw new RangeError('Implicit deflator is undefined when the volume measure is zero');
  }
  return (currentPriceValue / volumeValue) * INDEX_BASE;
}
