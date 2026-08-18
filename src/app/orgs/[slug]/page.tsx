import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { withRls, schema } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { addMember } from '../actions';

export const dynamic = 'force-dynamic';

type MemberRow = {
  user_id: string;
  email: string;
  role: 'admin' | 'compiler' | 'reviewer' | 'viewer';
  created_at: string;
};

export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const claims = await getVerifiedClaims();
  if (!claims) redirect('/sign-in');
  const { slug } = await params;
  const { error } = await searchParams;

  const { org, members } = await withRls(claims, {}, async (tx) => {
    const [org] = await tx
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug));
    if (!org) return { org: undefined, members: [] as MemberRow[] };
    const members = (await tx.execute(
      sql`select user_id, email, role, created_at from public.org_members(${org.id}::uuid)`,
    )) as unknown as MemberRow[];
    return { org, members };
  });

  // RLS returns zero rows for non-members and nonexistent slugs alike —
  // deliberately indistinguishable, so org existence never leaks.
  if (!org) notFound();

  const myRole = members.find((m) => m.user_id === claims.sub)?.role;

  return (
    <main>
      <p>
        <Link href="/orgs">← Your organizations</Link>
      </p>
      <h1>{org.name}</h1>
      <p className="muted">
        Slug: {org.slug} · Fiscal year starts month {org.fiscalYearStartMonth} ·
        Your role: {myRole ?? 'unknown'}
      </p>
      {error && <p className="error">{error}</p>}

      <p>
        <Link href={`/orgs/${org.slug}/classifications`}>
          Classifications and mappings
        </Link>
        {' · '}
        <Link href={`/orgs/${org.slug}/data`}>Source data</Link>
        {' · '}
        <Link href={`/orgs/${org.slug}/runs`}>Compilation runs</Link>
      </p>

      <h2>Members</h2>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.email}</td>
                <td>{m.role}</td>
                <td>{new Date(m.created_at).toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {myRole === 'admin' && (
        <>
          <h2>Add a member</h2>
          <form className="stack" action={addMember}>
            <input type="hidden" name="orgId" value={org.id} />
            <input type="hidden" name="orgSlug" value={org.slug} />
            <label>
              Account email
              <input name="email" type="email" required />
            </label>
            <label>
              Role
              <select name="role" defaultValue="viewer">
                <option value="admin">admin</option>
                <option value="compiler">compiler</option>
                <option value="reviewer">reviewer</option>
                <option value="viewer">viewer</option>
              </select>
            </label>
            <button type="submit">Add member</button>
          </form>
          <p className="muted">
            The person must already have an account with that email.
          </p>
        </>
      )}
    </main>
  );
}
