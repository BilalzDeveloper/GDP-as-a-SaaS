// The review and publication workflow. What is worth proving here is not that
// the happy path works but that the gates hold: who may make each transition,
// which transitions are legal at all, and that approval really does freeze the
// figures it approved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withRls, closeDb, type RlsClaims } from '../../src/db/rls';
import { admin, claimsFor, createOrg, createTestUser, dbMessage } from '../rls/helpers';
import { executeRun } from '../../src/compile/execute';
import { exportExcel, exportSdmxCsv } from '../../src/export/service';

const tag = Date.now().toString(36);

let owner: RlsClaims; //    admin, creates runs
let compiler: RlsClaims; // compiler
let reviewer: RlsClaims; // reviewer
let viewer: RlsClaims; //   viewer
let outsider: RlsClaims; // member of another org
let orgA: { id: string; slug: string };
let vintageId: string;

async function addMember(email: string, role: string) {
  await withRls(owner, { reason: `test: add ${role}` }, (tx) =>
    tx.execute(
      sql`select public.add_member_by_email(${orgA.id}::uuid, ${email}, ${role}::org_role)`,
    ),
  );
}

/** A fresh executed run, ready to be submitted for review. */
async function freshRun(name: string, creator: RlsClaims = compiler): Promise<string> {
  const runId = await withRls(creator, { reason: `test: run ${name}` }, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into compilation_run (org_id, name, frequency, input_vintage_id,
                                   anchor_approach, created_by)
      values (${orgA.id}::uuid, ${name}, 'annual', ${vintageId}::uuid,
              'production', ${creator.sub}::uuid)
      returning id
    `)) as unknown as { id: string }[];
    return rows[0].id;
  });
  await executeRun(creator, orgA.id, runId);
  return runId;
}

async function runStatus(runId: string): Promise<string> {
  const [row] = await admin`select status from compilation_run where id = ${runId}`;
  return row.status as string;
}

function callRpc(claims: RlsClaims, statement: ReturnType<typeof sql>) {
  return withRls(claims, { reason: 'test: workflow transition' }, (tx) =>
    tx.execute(statement),
  );
}

beforeAll(async () => {
  owner = claimsFor(await createTestUser(`rev-owner-${tag}@a.test`), 'owner');
  compiler = claimsFor(await createTestUser(`rev-comp-${tag}@a.test`), 'compiler');
  reviewer = claimsFor(await createTestUser(`rev-rev-${tag}@a.test`), 'reviewer');
  viewer = claimsFor(await createTestUser(`rev-view-${tag}@a.test`), 'viewer');
  outsider = claimsFor(await createTestUser(`rev-out-${tag}@b.test`), 'outsider');

  orgA = await createOrg(owner, 'Review NSO', `rev-a-${tag}`);
  await createOrg(outsider, 'Other NSO', `rev-b-${tag}`);
  await addMember(`rev-comp-${tag}@a.test`, 'compiler');
  await addMember(`rev-rev-${tag}@a.test`, 'reviewer');
  await addMember(`rev-view-${tag}@a.test`, 'viewer');

  const [isic] = await admin`
    select v.id from classification_version v
      join classification c on c.id = v.classification_id
     where c.code = 'ISIC4' and c.owner_org_id is null`;
  const [itemA] = await admin`
    select id from classification_item where version_id = ${isic.id} and code = 'A'`;

  await withRls(owner, { reason: 'test: period' }, (tx) =>
    tx.execute(sql`
      insert into reference_period (org_id, frequency, start_date, end_date, label, fiscal_year)
      values (${orgA.id}::uuid, 'annual', '2023-01-01', '2023-12-31', '2023', 2023)
    `),
  );

  vintageId = await withRls(owner, { reason: 'test: vintage' }, async (tx) => {
    const v = (await tx.execute(sql`
      insert into data_vintage (org_id, name) values (${orgA.id}::uuid, ${'v-' + tag})
      returning id
    `)) as unknown as { id: string }[];
    const [period] = (await tx.execute(sql`
      select id from reference_period where org_id = ${orgA.id}::uuid limit 1
    `)) as unknown as { id: string }[];

    const series = async (txn: string, activity: string | null) => {
      const rows = (await tx.execute(sql`
        insert into time_series (org_id, transaction_code, activity_item_id,
                                 price_basis, valuation, frequency, unit_code)
        values (${orgA.id}::uuid, ${txn}, ${activity}::uuid, 'current', 'basic',
                'annual', 'NC_MN')
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    };
    for (const [txn, activity, value] of [
      ['P.1', itemA.id, 1000],
      ['P.2', itemA.id, 400],
      ['D.21', null, 100],
    ] as const) {
      const s = await series(txn, activity);
      await tx.execute(sql`
        insert into observation (org_id, series_id, period_id, vintage_id, value)
        values (${orgA.id}::uuid, ${s}::uuid, ${period.id}::uuid, ${v[0].id}::uuid, ${value})
      `);
    }
    return v[0].id;
  });
});

afterAll(async () => {
  await closeDb();
  await admin.end();
});

describe('submitting for review', () => {
  it('lets a compiler submit a computed run', async () => {
    const runId = await freshRun('submit ok');
    await callRpc(compiler, sql`select public.submit_run_for_review(${runId}::uuid)`);
    expect(await runStatus(runId)).toBe('under_review');
  });

  it('refuses a viewer', async () => {
    const runId = await freshRun('viewer submit');
    await expect(
      callRpc(viewer, sql`select public.submit_run_for_review(${runId}::uuid)`),
    ).rejects.toSatisfy((e: unknown) =>
      /only compilers and admins/.test(dbMessage(e)),
    );
    expect(await runStatus(runId)).toBe('computed');
  });

  it('refuses a run that has not been executed', async () => {
    const draftId = await withRls(compiler, { reason: 'test: draft' }, async (tx) => {
      const rows = (await tx.execute(sql`
        insert into compilation_run (org_id, name, frequency, input_vintage_id, created_by)
        values (${orgA.id}::uuid, 'never run', 'annual', ${vintageId}::uuid,
                ${compiler.sub}::uuid)
        returning id
      `)) as unknown as { id: string }[];
      return rows[0].id;
    });
    await expect(
      callRpc(compiler, sql`select public.submit_run_for_review(${draftId}::uuid)`),
    ).rejects.toSatisfy((e: unknown) => /only a computed run/.test(dbMessage(e)));
  });

  it('refuses to submit twice', async () => {
    const runId = await freshRun('double submit');
    await callRpc(compiler, sql`select public.submit_run_for_review(${runId}::uuid)`);
    await expect(
      callRpc(compiler, sql`select public.submit_run_for_review(${runId}::uuid)`),
    ).rejects.toSatisfy((e: unknown) => /only a computed run/.test(dbMessage(e)));
  });
});

describe('reviewing', () => {
  it('lets a reviewer approve, and freezes the input vintage', async () => {
    const runId = await freshRun('approve me');
    await callRpc(compiler, sql`select public.submit_run_for_review(${runId}::uuid)`);
    await callRpc(
      reviewer,
      sql`select public.review_run(${runId}::uuid, 'approved'::review_decision, 'Checked against source; identities balance.')`,
    );
    expect(await runStatus(runId)).toBe('approved');

    // Approval freezes the figures it approved — the whole point.
    const [vintage] = await admin`
      select frozen_at from data_vintage where id = ${vintageId}`;
    expect(vintage.frozen_at).not.toBeNull();
  });

  it('refuses a compiler', async () => {
    const runId = await freshRun('compiler review');
    await callRpc(compiler, sql`select public.submit_run_for_review(${runId}::uuid)`);
    await expect(
      callRpc(
        compiler,
        sql`select public.review_run(${runId}::uuid, 'approved'::review_decision, 'me again')`,
      ),
    ).rejects.toSatisfy((e: unknown) => /only reviewers and admins/.test(dbMessage(e)));
  });

  it('refuses to let someone review their own run', async () => {
    // Separation of duties is the reason the reviewer role exists; an NSO
    // answering to a parliament needs it to be more than a convention. The
    // case that matters is an ADMIN, who can both create and review — a
    // reviewer cannot create runs at all, so they could not reach this.
    const runId = await freshRun('self review', owner);
    await callRpc(owner, sql`select public.submit_run_for_review(${runId}::uuid)`);
    await expect(
      callRpc(
        owner,
        sql`select public.review_run(${runId}::uuid, 'approved'::review_decision, 'looks fine to me')`,
      ),
    ).rejects.toSatisfy((e: unknown) =>
      /cannot be reviewed by the person who created it/.test(dbMessage(e)),
    );
    // Another reviewer can still approve it.
    await callRpc(
      reviewer,
      sql`select public.review_run(${runId}::uuid, 'approved'::review_decision, 'Independent check done.')`,
    );
    expect(await runStatus(runId)).toBe('approved');
  });

  it('a reviewer cannot create runs in the first place', async () => {
    // The write policy, not the workflow, is what stops this — worth pinning
    // down because the self-review guard would be moot if it did not hold.
    await expect(freshRun('reviewer-created', reviewer)).rejects.toSatisfy(
      (e: unknown) => /row-level security/.test(dbMessage(e)),
    );
  });

  it('sends a run back to computed when changes are requested', async () => {
    const runId = await freshRun('changes please');
    await callRpc(compiler, sql`select public.submit_run_for_review(${runId}::uuid)`);
    await callRpc(
      reviewer,
      sql`select public.review_run(${runId}::uuid, 'changes_requested'::review_decision, 'Industry C output looks like a scale error.')`,
    );
    expect(await runStatus(runId)).toBe('computed');
  });

  it('requires a note', async () => {
    const runId = await freshRun('no note');
    await callRpc(compiler, sql`select public.submit_run_for_review(${runId}::uuid)`);
    await expect(
      callRpc(
        reviewer,
        sql`select public.review_run(${runId}::uuid, 'approved'::review_decision, '   ')`,
      ),
    ).rejects.toSatisfy((e: unknown) => /must record a note/.test(dbMessage(e)));
  });

  it('records the decision, the reviewer and the note', async () => {
    const runId = await freshRun('audit trail');
    await callRpc(compiler, sql`select public.submit_run_for_review(${runId}::uuid)`);
    await callRpc(
      reviewer,
      sql`select public.review_run(${runId}::uuid, 'approved'::review_decision, 'Verified totals against the source extract.')`,
    );
    const rows = (await withRls(compiler, {}, (tx) =>
      tx.execute(sql`
        select decision::text as decision, note, reviewer_id from run_review
         where run_id = ${runId}::uuid
      `),
    )) as unknown as { decision: string; note: string; reviewer_id: string }[];
    expect(rows[0].decision).toBe('approved');
    expect(rows[0].reviewer_id).toBe(reviewer.sub);
    expect(rows[0].note).toContain('Verified totals');
  });

  it('refuses to review a run that was never submitted', async () => {
    const runId = await freshRun('not submitted');
    await expect(
      callRpc(
        reviewer,
        sql`select public.review_run(${runId}::uuid, 'approved'::review_decision, 'jumping ahead')`,
      ),
    ).rejects.toSatisfy((e: unknown) => /only a run under review/.test(dbMessage(e)));
  });
});

describe('publishing', () => {
  async function approvedRun(name: string): Promise<string> {
    const runId = await freshRun(name);
    await callRpc(compiler, sql`select public.submit_run_for_review(${runId}::uuid)`);
    await callRpc(
      reviewer,
      sql`select public.review_run(${runId}::uuid, 'approved'::review_decision, 'ok')`,
    );
    return runId;
  }

  it('lets an admin publish an approved run', async () => {
    const runId = await approvedRun('publish me');
    await callRpc(owner, sql`select public.publish_run(${runId}::uuid, null)`);
    expect(await runStatus(runId)).toBe('published');
    const [vintage] = await admin`
      select published from data_vintage where id = ${vintageId}`;
    expect(vintage.published).toBe(true);
  });

  it('refuses a reviewer', async () => {
    const runId = await approvedRun('reviewer publish');
    await expect(
      callRpc(reviewer, sql`select public.publish_run(${runId}::uuid, null)`),
    ).rejects.toSatisfy((e: unknown) => /only admins can publish/.test(dbMessage(e)));
  });

  it('refuses a run that has not been approved', async () => {
    const runId = await freshRun('unapproved publish');
    await expect(
      callRpc(owner, sql`select public.publish_run(${runId}::uuid, null)`),
    ).rejects.toSatisfy((e: unknown) => /only an approved run/.test(dbMessage(e)));
  });

  it('refuses an embargo in the past', async () => {
    const runId = await approvedRun('past embargo');
    await expect(
      callRpc(
        owner,
        sql`select public.publish_run(${runId}::uuid, '2000-01-01T00:00:00Z'::timestamptz)`,
      ),
    ).rejects.toSatisfy((e: unknown) => /must be in the future/.test(dbMessage(e)));
  });

  it('records a future embargo on the run', async () => {
    const runId = await approvedRun('embargoed');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await callRpc(owner, sql`select public.publish_run(${runId}::uuid, ${future}::timestamptz)`);
    const [row] = await admin`
      select embargo_until, published_at from compilation_run where id = ${runId}`;
    expect(row.embargo_until).not.toBeNull();
    expect(row.published_at).not.toBeNull();
  });
});

describe('exports', () => {
  let publishedRun: string;
  let embargoedRun: string;

  beforeAll(async () => {
    publishedRun = await freshRun('export plain');
    await callRpc(compiler, sql`select public.submit_run_for_review(${publishedRun}::uuid)`);
    await callRpc(
      reviewer,
      sql`select public.review_run(${publishedRun}::uuid, 'approved'::review_decision, 'ok')`,
    );
    await callRpc(owner, sql`select public.publish_run(${publishedRun}::uuid, null)`);

    embargoedRun = await freshRun('export embargoed');
    await callRpc(compiler, sql`select public.submit_run_for_review(${embargoedRun}::uuid)`);
    await callRpc(
      reviewer,
      sql`select public.review_run(${embargoedRun}::uuid, 'approved'::review_decision, 'ok')`,
    );
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await callRpc(
      owner,
      sql`select public.publish_run(${embargoedRun}::uuid, ${future}::timestamptz)`,
    );
  });

  it('writes SDMX-CSV with a header and the observations', async () => {
    const { body, filename } = await exportSdmxCsv(owner, publishedRun);
    const lines = body.trim().split('\n');
    expect(lines[0]).toContain('STRUCTURE');
    expect(lines[0]).toContain('OBS_VALUE');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toContain('dataflow');
    expect(filename).toMatch(/\.csv$/);
  });

  it('does not stamp an un-embargoed export', async () => {
    const { body } = await exportSdmxCsv(owner, publishedRun);
    expect(body).not.toContain('EMBARGOED');
  });

  it('stamps an embargoed export so it cannot be loaded unnoticed', async () => {
    const { body } = await exportSdmxCsv(owner, embargoedRun);
    expect(body.split('\n')[0]).toContain('EMBARGOED UNTIL');
    expect(body).toContain('NOT FOR RELEASE');
  });

  it('writes a real xlsx workbook', async () => {
    const { body, filename } = await exportExcel(owner, publishedRun);
    // PK zip magic — a genuine workbook, not a CSV with the wrong extension.
    expect(body.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(body.byteLength).toBeGreaterThan(1000);
    expect(filename).toMatch(/\.xlsx$/);
  });

  it('lets a viewer export their own org’s figures', async () => {
    const { body } = await exportSdmxCsv(viewer, publishedRun);
    expect(body).toContain('OBS_VALUE');
  });

  it("refuses another tenant's run", async () => {
    // RLS filters the run away entirely, so the export sees nothing to export.
    await expect(exportSdmxCsv(outsider, publishedRun)).rejects.toThrow(
      /No such compilation run/,
    );
  });
});

describe('isolation for review records', () => {
  it("another tenant cannot read this org's reviews", async () => {
    const rows = (await withRls(outsider, {}, (tx) =>
      tx.execute(sql`select count(*)::int as n from run_review where org_id = ${orgA.id}::uuid`),
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  it('nobody can insert a review directly, bypassing the role checks', async () => {
    const runId = await freshRun('direct insert');
    await expect(
      withRls(owner, { reason: 'attack: fake approval' }, (tx) =>
        tx.execute(sql`
          insert into run_review (org_id, run_id, reviewer_id, decision, note)
          values (${orgA.id}::uuid, ${runId}::uuid, ${owner.sub}::uuid,
                  'approved'::review_decision, 'rubber stamp')
        `),
      ),
    ).rejects.toSatisfy((e: unknown) =>
      /row-level security|permission denied/.test(dbMessage(e)),
    );
  });
});
