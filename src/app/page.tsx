import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getVerifiedClaims } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const claims = await getVerifiedClaims();
  if (claims) redirect('/orgs');

  return (
    <main>
      <h1>GDP Compilation Platform</h1>
      <p>
        Compile Gross Domestic Product by the production, expenditure and
        income approaches under the UN System of National Accounts (SNA 2008)
        — with full audit trails and reproducible vintages.
      </p>
      <p>
        <Link href="/sign-in">Sign in</Link> or{' '}
        <Link href="/sign-up">create an account</Link>.
      </p>
      <p className="muted">
        Milestone 1 preview: authentication, organizations and tenant
        isolation. Compilation features arrive in later milestones.
      </p>
    </main>
  );
}
