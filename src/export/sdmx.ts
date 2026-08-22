// SDMX-CSV export. Pure: rows in, text out.
//
// WHICH VARIANT. This writes SDMX-CSV 2.0 (the format accompanying SDMX 3.0):
// a `STRUCTURE`/`STRUCTURE_ID`/`ACTION` prefix, then one column per dimension,
// then `OBS_VALUE`, then attributes.
//
// CONFORMANCE IS UNVERIFIED. This implementation follows the format as
// documented, but it has NOT been checked against an official SDMX validator
// or against a receiving institution's parser, because this environment has
// no network access to reach one. Treat the output as "SDMX-CSV shaped" until
// somebody validates it, and see docs/publication.md for how. The same
// honesty rule applies here as to the classification seeds: shipping
// something labelled as a standard that has never been checked against the
// standard is how a product loses an NSO's trust.

export interface SdmxObservation {
  /** Reference period, e.g. '2023' or '2023-Q3'. */
  timePeriod: string;
  /** SNA transaction code, e.g. 'B.1g'. */
  transaction: string;
  /** Activity code, or '' where the measure is a total. */
  activity: string;
  /**
   * Institutional sector code, or '' where the measure is not a sector cut.
   * Its own dimension rather than sharing ACTIVITY: an industry and a sector
   * are two different groupings of the same producers, and a consumer that
   * read S.13 as an activity code would be reading it wrong.
   */
  sector: string;
  /** 'current' | 'chain_linked' | 'previous_year'. */
  priceBasis: string;
  /**
   * Whether this figure has been reconciled to annual totals. A dimension
   * rather than a flag, because a benchmarked and an unbenchmarked figure for
   * the same quarter are two distinct observations and must not collide on
   * the same key. Deliberately NOT sent as SDMX's ADJUSTMENT concept, which
   * means seasonal and calendar adjustment — neither of which this is.
   */
  benchmarked: boolean;
  /** Unit of measure code from the unit registry. */
  unit: string;
  /** The figure. Null is written as an empty cell, never as zero. */
  value: number | null;
  /** Free-text measure name from the compilation. */
  measure: string;
}

export interface SdmxDatasetMeta {
  /** Agency identifier — the organization's slug, upper-cased. */
  agency: string;
  /** Dataflow identifier. */
  dataflow: string;
  version: string;
  /** Set when the figures are still embargoed. */
  embargoUntil?: string | null;
}

const COLUMNS = [
  'STRUCTURE',
  'STRUCTURE_ID',
  'ACTION',
  'FREQ',
  'TIME_PERIOD',
  'TRANSACTION',
  'ACTIVITY',
  'SECTOR',
  'PRICE_BASIS',
  'BENCHMARKED',
  'MEASURE',
  'UNIT_MEASURE',
  'OBS_VALUE',
] as const;

/** Quote a field only when it needs it, per RFC 4180. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.split('"').join('""')}"` : value;
}

export function toSdmxCsv(
  meta: SdmxDatasetMeta,
  frequency: 'A' | 'Q',
  observations: readonly SdmxObservation[],
): string {
  const structureId = `${meta.agency}:${meta.dataflow}(${meta.version})`;
  const lines: string[] = [];

  // An embargo notice as a leading comment. SDMX-CSV has no comment
  // convention, so a receiving parser may reject this line — which is the
  // intended behaviour: an embargoed extract should not be silently loaded
  // into a public database.
  if (meta.embargoUntil) {
    lines.push(`#EMBARGOED UNTIL ${meta.embargoUntil} — NOT FOR RELEASE`);
  }

  lines.push(COLUMNS.join(','));
  for (const o of observations) {
    lines.push(
      [
        'dataflow',
        structureId,
        'I', // Information / full replacement
        frequency,
        o.timePeriod,
        o.transaction,
        o.activity,
        o.sector,
        o.priceBasis,
        o.benchmarked ? 'true' : 'false',
        o.measure,
        o.unit,
        o.value === null ? '' : String(o.value),
      ]
        .map(csvField)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
