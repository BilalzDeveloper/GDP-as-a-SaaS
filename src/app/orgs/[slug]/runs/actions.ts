'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { executeRun, ExecutionError } from '@/compile/execute';

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

/**
 * The workflow RPCs raise messages written for the person reading them
 * ("only reviewers and admins can review a run"), so surface those rather
 * than replacing them with something vaguer.
 */
function dbError(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message : String(e);
  if (message === 'NEXT_REDIRECT') throw e;
  const cause = (e as { cause?: { message?: string } })?.cause?.message;
  return cause ?? fallback;
}

async function orgFor(slug: string) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');
  const org = await withRls(claims, {}, async (tx) => {
    const rows = (await tx.execute(
      sql`select id, slug from organization where slug = ${slug}`,
    )) as unknown as { id: string; slug: string }[];
    return rows[0];
  });
  if (!org) redirect('/orgs');
  return { claims, org };
}

export async function createRun(formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const path = `/orgs/${slug}/runs`;
  const { claims, org } = await orgFor(slug);

  const name = String(formData.get('name') ?? '').trim();
  const vintageId = String(formData.get('vintageId') ?? '');
  const anchor = String(formData.get('anchor') ?? 'production');
  const frequency = String(formData.get('frequency') ?? 'annual');
  const volumeReference = String(formData.get('volumeReference') ?? '').trim();
  const volumeFormula = String(formData.get('volumeFormula') ?? '').trim();
  if (!name) fail(path, 'Name the run.');
  if (!vintageId) fail(path, 'Choose the vintage this run reads.');
  if (volumeFormula && !['laspeyres', 'paasche', 'fisher'].includes(volumeFormula)) {
    fail(path, 'Unknown index formula.');
  }

  try {
    const runId = await withRls(
      claims,
      { reason: `create compilation run "${name}"` },
      async (tx) => {
        const rows = (await tx.execute(sql`
          insert into compilation_run
            (org_id, name, frequency, input_vintage_id, anchor_approach,
             volume_reference_period_label, volume_index_formula, created_by)
          values (${org.id}::uuid, ${name}, ${frequency}::period_frequency,
                  ${vintageId}::uuid, ${anchor},
                  ${volumeReference || null}, ${volumeFormula || null},
                  ${claims.sub}::uuid)
          returning id
        `)) as unknown as { id: string }[];
        return rows[0].id;
      },
    );
    revalidatePath(path);
    redirect(`${path}/${runId}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'NEXT_REDIRECT') throw e;
    if (message.includes('compilation_run_org_id_name_key')) {
      fail(path, `A run named "${name}" already exists.`);
    }
    fail(path, 'The run could not be created.');
  }
}

export async function runExecute(formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const runId = String(formData.get('runId') ?? '');
  const path = `/orgs/${slug}/runs/${runId}`;
  const { claims, org } = await orgFor(slug);

  try {
    await executeRun(claims, org.id, runId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'NEXT_REDIRECT') throw e;
    fail(path, e instanceof ExecutionError ? e.message : 'Execution failed.');
  }
  revalidatePath(path);
  redirect(path);
}

export async function submitForReview(formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const runId = String(formData.get('runId') ?? '');
  const path = `/orgs/${slug}/runs/${runId}`;
  const { claims } = await orgFor(slug);

  try {
    await withRls(claims, { reason: `submit run ${runId} for review` }, (tx) =>
      tx.execute(sql`select public.submit_run_for_review(${runId}::uuid)`),
    );
  } catch (e) {
    fail(path, dbError(e, 'The run could not be submitted for review.'));
  }
  revalidatePath(path);
  redirect(path);
}

export async function reviewRun(formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const runId = String(formData.get('runId') ?? '');
  const path = `/orgs/${slug}/runs/${runId}`;
  const { claims } = await orgFor(slug);

  const decision = String(formData.get('decision') ?? '');
  const note = String(formData.get('note') ?? '').trim();
  if (!['approved', 'changes_requested'].includes(decision)) {
    fail(path, 'Choose approve or request changes.');
  }
  if (!note) fail(path, 'A review must record a note saying why.');

  try {
    await withRls(claims, { reason: `review run ${runId}: ${decision}` }, (tx) =>
      tx.execute(
        sql`select public.review_run(${runId}::uuid, ${decision}::review_decision, ${note})`,
      ),
    );
  } catch (e) {
    fail(path, dbError(e, 'The review could not be recorded.'));
  }
  revalidatePath(path);
  redirect(path);
}

export async function publishRun(formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const runId = String(formData.get('runId') ?? '');
  const path = `/orgs/${slug}/runs/${runId}`;
  const { claims } = await orgFor(slug);

  const embargoRaw = String(formData.get('embargoUntil') ?? '').trim();
  const embargo = embargoRaw ? new Date(embargoRaw) : null;
  if (embargoRaw && Number.isNaN(embargo?.getTime())) {
    fail(path, 'That embargo time could not be read.');
  }

  try {
    await withRls(claims, { reason: `publish run ${runId}` }, (tx) =>
      tx.execute(
        sql`select public.publish_run(${runId}::uuid, ${embargo ? embargo.toISOString() : null}::timestamptz)`,
      ),
    );
  } catch (e) {
    fail(path, dbError(e, 'The run could not be published.'));
  }
  revalidatePath(path);
  redirect(path);
}
