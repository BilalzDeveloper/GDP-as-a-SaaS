// Making the audit trail readable.
//
// Non-negotiable 2 is only discharged if a person can actually read the
// record. These are the functions that turn whole-row JSON snapshots into
// something a parliamentary auditor could follow, so they are worth testing
// as carefully as anything that computes a figure — a diff that quietly drops
// a changed field would hide exactly what the trail exists to show.
import { describe, expect, it } from 'vitest';
import {
  changedFields,
  describeRow,
  formatValue,
  TABLE_LABEL,
} from '@/app/orgs/[slug]/audit/describe';

describe('changedFields', () => {
  it('lists only the fields that changed', () => {
    const changes = changedFields(
      { id: 'x', name: 'first estimate', status: 'draft', anchor: 'production' },
      { id: 'x', name: 'first estimate', status: 'computed', anchor: 'production' },
    );
    expect(changes).toEqual([{ field: 'status', from: 'draft', to: 'computed' }]);
  });

  it('never drops a changed field', () => {
    const changes = changedFields(
      { a: 1, b: 'two', c: true, d: null },
      { a: 2, b: 'three', c: false, d: 'set' },
    );
    expect(changes.map((c) => c.field)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('compares nested values by value, not by reference', () => {
    const unchanged = changedFields(
      { definition: { columns: { value: { source: 'amount' } } } },
      { definition: { columns: { value: { source: 'amount' } } } },
    );
    expect(unchanged).toEqual([]);

    const changed = changedFields(
      { definition: { columns: { value: { source: 'amount' } } } },
      { definition: { columns: { value: { source: 'value' } } } },
    );
    expect(changed).toHaveLength(1);
  });

  it('detects a value moving, which is the change that matters most', () => {
    // An observation whose figure was edited. If the diff missed this, the
    // trail would record that *something* happened and hide what.
    const changes = changedFields(
      { value: '1600.000000', period_id: 'p1' },
      { value: '1650.000000', period_id: 'p1' },
    );
    expect(changes).toEqual([
      { field: 'value', from: '1600.000000', to: '1650.000000' },
    ]);
  });

  it('hides bookkeeping columns that say nothing about the change', () => {
    const changes = changedFields(
      { id: 'a', org_id: 'o', created_at: 't1', name: 'before' },
      { id: 'a', org_id: 'o', created_at: 't2', name: 'after' },
    );
    expect(changes.map((c) => c.field)).toEqual(['name']);
  });

  it('does not try to diff the bytes of an uploaded file', () => {
    const changes = changedFields(
      { file_bytes: 'AAAA', status: 'uploaded' },
      { file_bytes: 'BBBB', status: 'parsed' },
    );
    expect(changes.map((c) => c.field)).toEqual(['status']);
  });

  it('lists nothing for an insert or a delete', () => {
    // There is no "before" to compare against, so every field would show as a
    // change and bury the updates an auditor is usually looking for. The row
    // summary says what was created or removed.
    expect(changedFields(null, { name: 'new' })).toEqual([]);
    expect(changedFields({ name: 'gone' }, null)).toEqual([]);
  });

  it('returns changes in a stable order', () => {
    const first = changedFields({ z: 1, a: 1 }, { z: 2, a: 2 });
    const second = changedFields({ a: 1, z: 1 }, { a: 2, z: 2 });
    expect(first.map((c) => c.field)).toEqual(second.map((c) => c.field));
  });
});

describe('formatValue', () => {
  it('marks an absent value distinctly from an empty one', () => {
    // "no value recorded" and "recorded as blank" are different facts, and a
    // trail that showed both as nothing would lose one of them.
    expect(formatValue(null)).toBe('∅');
    expect(formatValue(undefined)).toBe('∅');
    expect(formatValue('')).toBe('(empty)');
  });

  it('reads booleans as words', () => {
    expect(formatValue(true)).toBe('yes');
    expect(formatValue(false)).toBe('no');
  });

  it('keeps numbers exactly as given', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue(-1650.5)).toBe('-1650.5');
  });

  it('truncates something long rather than flooding the row', () => {
    const long = 'x'.repeat(500);
    const shown = formatValue(long);
    expect(shown.length).toBeLessThan(100);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('serialises an object before truncating it', () => {
    const shown = formatValue({ columns: { value: { source: 'amount' } } });
    expect(shown).toContain('columns');
  });
});

describe('describeRow', () => {
  it('identifies a row the way the table means it', () => {
    expect(describeRow('compilation_run', { name: '2024 first release', status: 'computed' }))
      .toBe('2024 first release · computed');
    expect(describeRow('reference_period', { label: '2024-Q3', frequency: 'quarterly' }))
      .toBe('2024-Q3 · quarterly');
    expect(describeRow('membership', { role: 'reviewer' })).toBe('reviewer');
    expect(describeRow('run_review', { decision: 'approved' })).toBe('approved');
  });

  it('shows a reviewer’s note, which no diff would reveal', () => {
    // A review is an INSERT, so it has no field-level changes. The note is
    // the reasoning a reviewer is required to give, and the trail exists to
    // preserve it.
    expect(
      describeRow('run_review', {
        decision: 'changes_requested',
        note: 'Construction output double-counts the Q2 programme.',
      }),
    ).toBe('changes_requested · Construction output double-counts the Q2 programme.');
  });

  it('describes an observation by its figure', () => {
    expect(describeRow('observation', { value: '1600.000000' })).toBe('value 1600.000000');
  });

  it('surfaces the states that matter on a vintage', () => {
    expect(describeRow('data_vintage', { name: 'first estimate' })).toBe('first estimate');
    expect(
      describeRow('data_vintage', { name: 'first estimate', frozen_at: 't', published: true }),
    ).toBe('first estimate · frozen · published');
  });

  it('falls back to a name, label or code for anything unlisted', () => {
    expect(describeRow('some_new_table', { code: 'ISIC4' })).toBe('ISIC4');
    expect(describeRow('some_new_table', {})).toBe('');
  });

  it('copes with a missing row', () => {
    expect(describeRow('observation', null)).toBe('');
    expect(describeRow('observation', undefined)).toBe('');
  });
});

describe('TABLE_LABEL', () => {
  it('names the tables a compiler would recognise', () => {
    expect(TABLE_LABEL.source_dataset).toBe('source file');
    expect(TABLE_LABEL.observation).toBe('observation');
    expect(TABLE_LABEL.compilation_run).toBe('compilation run');
  });
});
