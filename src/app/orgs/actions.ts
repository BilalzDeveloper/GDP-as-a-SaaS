'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { withRls } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function createOrg(formData: FormData) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');

  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase();
  if (!name) fail('/orgs', 'Organization name is required.');
  if (!SLUG_RE.test(slug)) {
    fail('/orgs', 'Slug must be 2–63 chars: lowercase letters, digits, hyphens.');
  }

  try {
    await withRls(claims, { reason: `create organization "${name}"` }, (tx) =>
      tx.execute(sql`select public.create_organization(${name}, ${slug})`),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('organization_slug_key')) {
      fail('/orgs', `The slug "${slug}" is already taken.`);
    }
    fail('/orgs', 'Could not create the organization.');
  }
  revalidatePath('/orgs');
  redirect(`/orgs/${slug}`);
}

export async function addMember(formData: FormData) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');

  const orgId = String(formData.get('orgId') ?? '');
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const email = String(formData.get('email') ?? '').trim();
  const role = String(formData.get('role') ?? 'viewer');
  const path = `/orgs/${orgSlug}`;

  if (!email) fail(path, 'Email is required.');
  if (!['admin', 'compiler', 'reviewer', 'viewer'].includes(role)) {
    fail(path, 'Invalid role.');
  }

  try {
    await withRls(
      claims,
      { reason: `add ${email} as ${role}` },
      (tx) =>
        tx.execute(
          sql`select public.add_member_by_email(${orgId}::uuid, ${email}, ${role}::org_role)`,
        ),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('no user found')) {
      fail(path, `No account exists for ${email} — they need to sign up first.`);
    }
    if (message.includes('only organization admins')) {
      fail(path, 'Only organization admins can add members.');
    }
    fail(path, 'Could not add the member.');
  }
  revalidatePath(path);
  redirect(path);
}
