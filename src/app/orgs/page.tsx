import Link from 'next/link';
import { redirect } from 'next/navigation';
import { withRls, schema } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { signOut } from '../(auth)/actions';
import { createOrg } from './actions';

export const dynamic = 'force-dynamic';

export default async function OrgsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');
  const { error } = await searchParams;

  // RLS filters this to organizations the user is a member of.
  const orgs = await withRls(claims, {}, (tx) =>
    tx
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        slug: schema.organization.slug,
      })
      .from(schema.organization)
      .orderBy(schema.organization.name),
  );

  return (
    <>
      <header className="site">
        <strong>GDP Compilation Platform</strong>
        <span>
          <span className="muted">{claims.email}</span>{' '}
          <form action={signOut} style={{ display: 'inline' }}>
            <button className="link" type="submit">
              Sign out
            </button>
          </form>
        </span>
      </header>
      <main>
        <h1>Your organizations</h1>
        {error && <p className="error">{error}</p>}
        {orgs.length === 0 ? (
          <p className="muted">
            You are not a member of any organization yet — create one below, or
            ask an admin to add you by your account email.
          </p>
        ) : (
          <ul>
            {orgs.map((org) => (
              <li key={org.id}>
                <Link href={`/orgs/${org.slug}`}>{org.name}</Link>{' '}
                <span className="muted">({org.slug})</span>
              </li>
            ))}
          </ul>
        )}

        <h2>Create an organization</h2>
        <form className="stack" action={createOrg}>
          <label>
            Name
            <input name="name" required maxLength={200} />
          </label>
          <label>
            Slug (URL identifier)
            <input
              name="slug"
              required
              pattern="[a-z0-9][a-z0-9-]{1,62}"
              placeholder="e.g. nso-atlantis"
            />
          </label>
          <button type="submit">Create organization</button>
        </form>
        <p className="muted">You become the organization&apos;s admin.</p>
      </main>
    </>
  );
}
