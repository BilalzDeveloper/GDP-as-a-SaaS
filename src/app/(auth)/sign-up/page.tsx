import Link from 'next/link';
import { signUp } from '../actions';
import { IdentityBar } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <>
      <IdentityBar />
      <main className="narrow">
        <h1>Create an account</h1>
        {error && (
          <div className="callout is-critical">
            <p className="error" style={{ margin: 0 }}>
              {error}
            </p>
          </div>
        )}
        <form className="stack" action={signUp}>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </label>
          <button type="submit">Create account</button>
        </form>
        <p className="muted">
          Already registered? <Link href="/sign-in">Sign in</Link>.
        </p>
      </main>
    </>
  );
}
