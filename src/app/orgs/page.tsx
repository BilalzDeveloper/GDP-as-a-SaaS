import Link from 'next/link';
import { redirect } from 'next/navigation';
import { withRls, schema } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { IdentityBar, Panel } from '@/components/shell';
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
      <IdentityBar email={claims.email} />
      <main>
        <h1>Your organizations</h1>
        {error && (
          <div className="callout is-critical">
            <p className="error" style={{ margin: 0 }}>
              {error}
            </p>
          </div>
        )}

        {orgs.length === 0 ? (
          <p className="empty">
            You are not a member of any organization yet — create one below, or
            ask an admin to add you by your account email.
          </p>
        ) : (
          <Panel title="Organizations" scroll>
            <table>
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Identifier</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.id}>
                    <td>
                      <Link href={`/orgs/${org.slug}`}>{org.name}</Link>
                    </td>
                    <td className="mono muted">{org.slug}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        <h2>Create an organization</h2>
        <form className="stack" action={createOrg}>
          <label>
            Name
            <input name="name" required maxLength={200} />
          </label>
          <label>
            Identifier used in URLs
            <input
              name="slug"
              required
              pattern="[a-z0-9][a-z0-9-]{1,62}"
              placeholder="nso-atlantis"
            />
          </label>
          <button type="submit">Create organization</button>
        </form>
        <p className="muted">You become the organization&apos;s admin.</p>
      </main>
    </>
  );
}
