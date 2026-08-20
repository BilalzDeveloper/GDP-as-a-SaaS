import { notFound, redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { withRls, schema } from '@/db/rls';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { OrgShell, Panel } from '@/components/shell';
import { addMember } from '../actions';

export const dynamic = 'force-dynamic';

type MemberRow = {
  user_id: string;
  email: string;
  role: 'admin' | 'compiler' | 'reviewer' | 'viewer';
  created_at: string;
};

/** What each role can do, so the members table explains itself. */
const ROLE_NOTE: Record<MemberRow['role'], string> = {
  admin: 'manages members and publishes',
  compiler: 'uploads data and runs compilations',
  reviewer: 'approves runs for publication',
  viewer: 'read-only',
};

const ROLE_TONE: Record<MemberRow['role'], string> = {
  admin: 'pill is-accent',
  compiler: 'pill',
  reviewer: 'pill is-positive',
  viewer: 'pill',
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
    <>
      <OrgShell
        slug={org.slug}
        orgName={org.name}
        email={claims.email}
        current="overview"
      />
      <main>
        <h1>{org.name}</h1>
        <ul className="meta">
          <li>
            <span className="k">Identifier</span>
            <span className="v mono">{org.slug}</span>
          </li>
          <li>
            <span className="k">Fiscal year starts</span>
            <span className="v">month {org.fiscalYearStartMonth}</span>
          </li>
          <li>
            <span className="k">Your role</span>
            <span className="v">{myRole ?? 'unknown'}</span>
          </li>
        </ul>

        {error && (
          <div className="callout is-critical">
            <p className="error" style={{ margin: 0 }}>
              {error}
            </p>
          </div>
        )}

        <Panel title={`Members · ${members.length}`} scroll>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Can</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id}>
                  <td className="mono">{m.email}</td>
                  <td>
                    <span className={ROLE_TONE[m.role]}>{m.role}</span>
                  </td>
                  <td className="muted">{ROLE_NOTE[m.role]}</td>
                  <td className="mono muted">
                    {new Date(m.created_at).toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

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
                  <option value="admin">admin — manages members and publishes</option>
                  <option value="compiler">compiler — uploads data and runs compilations</option>
                  <option value="reviewer">reviewer — approves runs for publication</option>
                  <option value="viewer">viewer — read-only</option>
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
    </>
  );
}
