import Link from 'next/link';
import { signUp } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main>
      <h1>Create an account</h1>
      {error && <p className="error">{error}</p>}
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
  );
}
