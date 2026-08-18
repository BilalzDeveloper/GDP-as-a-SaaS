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
  if (!name) fail(path, 'Name the run.');
  if (!vintageId) fail(path, 'Choose the vintage this run reads.');

  try {
    const runId = await withRls(
      claims,
      { reason: `create compilation run "${name}"` },
      async (tx) => {
        const rows = (await tx.execute(sql`
          insert into compilation_run
            (org_id, name, frequency, input_vintage_id, anchor_approach, created_by)
          values (${org.id}::uuid, ${name}, ${frequency}::period_frequency,
                  ${vintageId}::uuid, ${anchor}, ${claims.sub}::uuid)
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
