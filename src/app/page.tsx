import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { IdentityBar } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const claims = await getVerifiedClaims();
  if (claims) redirect('/orgs');

  return (
    <>
      <IdentityBar />
      <main className="narrow">
        <h1>Compile GDP under SNA 2008</h1>
        <p className="lede">
          Upload source data, map it to standard classifications, and compute
          Gross Domestic Product by the production, expenditure and income
          approaches — with a full audit trail and reproducible vintages.
        </p>

        <div className="actions">
          <Link href="/sign-in">
            <button type="button">Sign in</button>
          </Link>
          <Link href="/sign-up">Create an account</Link>
        </div>

        <h3>What the platform guarantees</h3>
        <div className="panel">
          <div className="panel-body">
            <p className="muted">
              <strong>Reproducible.</strong> Every published figure is
              re-computable from a frozen vintage of source data plus the exact
              engine version and configuration that produced it.
            </p>
            <p className="muted">
              <strong>Auditable.</strong> Every change records who made it, when,
              what changed and why. Writes without a stated reason are refused.
            </p>
            <p className="muted">
              <strong>Isolated.</strong> Pre-release estimates are
              market-sensitive. Tenant separation is enforced in the database,
              not only in application code.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
