import Link from 'next/link';
import { signIn } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  return (
    <main>
      <h1>Sign in</h1>
      {notice && <p className="muted">{notice}</p>}
      {error && <p className="error">{error}</p>}
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
  );
}
