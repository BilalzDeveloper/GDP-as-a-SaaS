import Link from 'next/link';
import { signIn } from '../actions';
import { IdentityBar } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  return (
    <>
      <IdentityBar />
      <main className="narrow">
        <h1>Sign in</h1>
        {notice && (
          <div className="callout is-note">
            <p className="muted" style={{ margin: 0 }}>
              {notice}
            </p>
          </div>
        )}
        {error && (
          <div className="callout is-critical">
            <p className="error" style={{ margin: 0 }}>
              {error}
            </p>
          </div>
        )}
        <form className="stack" action={signIn}>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit">Sign in</button>
        </form>
        <p className="muted">
          No account? <Link href="/sign-up">Create one</Link>.
        </p>
      </main>
    </>
  );
}
