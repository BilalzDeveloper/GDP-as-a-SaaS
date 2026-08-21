// Turning an audit row into something a person can read.
//
// Pure and unit-tested, because this is the layer an auditor actually looks
// at: `old_data` and `new_data` are whole-row JSON snapshots, and showing
// them raw would technically discharge non-negotiable 2 while making the
// trail useless to the parliament it exists for.

/** Table names as a compiler would say them, not as the schema spells them. */
export const TABLE_LABEL: Record<string, string> = {
  organization: 'organization',
  membership: 'membership',
  reference_period: 'reference period',
  source_dataset: 'source file',
  column_mapping: 'column mapping',
  time_series: 'series',
  observation: 'observation',
  data_vintage: 'vintage',
  compilation_run: 'compilation run',
  run_review: 'review decision',
  classification: 'classification',
  classification_mapping: 'classification mapping',
};

/**
 * Columns that say nothing about a change and would crowd out what does.
 * `id` is on the row already; the timestamps restate `occurred_at`; the byte
 * payload of an uploaded file is megabytes of base64.
 */
const NOISE = new Set([
  'id',
  'org_id',
  'created_at',
  'updated_at',
  'uploaded_at',
  'occurred_at',
  'file_bytes',
]);

/** Long values are truncated: a column mapping is a page of JSON on its own. */
const MAX_LENGTH = 80;

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > MAX_LENGTH ? `${json.slice(0, MAX_LENGTH)}…` : json;
  }
  const text = String(value);
  if (text === '') return '(empty)';
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
}

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

/**
 * The fields that actually changed, old → new.
 *
 * For an INSERT there is no previous state and every field is trivially
 * "new", so nothing is listed — the row summary already says what was
 * created. For a DELETE there is no new state, and the same applies. Listing
 * every column in those cases would bury the UPDATEs, which are the entries
 * an auditor is usually hunting for.
 */
export function changedFields(
  oldData: Record<string, unknown> | null | undefined,
  newData: Record<string, unknown> | null | undefined,
): FieldChange[] {
  if (!oldData || !newData) return [];

  const fields = [...new Set([...Object.keys(oldData), ...Object.keys(newData)])]
    .filter((field) => !NOISE.has(field))
    .sort();

  const changes: FieldChange[] = [];
  for (const field of fields) {
    const before = oldData[field];
    const after = newData[field];
    // Compared as JSON so nested objects and arrays are compared by value.
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push({
      field,
      from: formatValue(before),
      to: formatValue(after),
    });
  }
  return changes;
}

/**
 * A one-line identification of the row a change was made to.
 *
 * Per table, because "which row" means something different in each: an
 * observation is identified by its value and period, a run by its name, a
 * membership by who it is for. A generic "id 9f2c…" would be accurate and
 * useless.
 */
export function describeRow(
  tableName: string,
  row: Record<string, unknown> | null | undefined,
): string {
  if (!row) return '';
  const get = (key: string): string | null => {
    const value = row[key];
    return value === null || value === undefined ? null : String(value);
  };
  const parts: (string | null)[] = (() => {
    switch (tableName) {
      case 'organization':
        return [get('name'), get('slug')];
      case 'membership':
        return [get('role')];
      case 'reference_period':
        return [get('label'), get('frequency')];
      case 'source_dataset':
        return [get('name'), get('original_filename'), get('status')];
      case 'column_mapping':
        return [get('name')];
      case 'observation':
        return [
          get('value') === null ? null : `value ${get('value')}`,
          get('flag') ? `flag ${get('flag')}` : null,
        ];
      case 'time_series':
        return [get('transaction_code'), get('frequency'), get('price_basis')];
      case 'data_vintage':
        return [
          get('name'),
          row.frozen_at ? 'frozen' : null,
          row.published ? 'published' : null,
        ];
      case 'compilation_run':
        return [get('name'), get('status')];
      case 'run_review':
        // The note is the substance of a review, and a review is an INSERT —
        // so it appears in no field-level diff. Requiring reviewers to write
        // one and then not showing it would make the requirement decorative.
        return [get('decision'), get('note')];
      default:
        return [get('name') ?? get('label') ?? get('code')];
    }
  })();

  return parts.filter((part): part is string => !!part).join(' · ');
}
