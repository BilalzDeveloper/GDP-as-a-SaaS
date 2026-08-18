'use server';

import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function backWithError(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function signIn(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) backWithError('/sign-in', 'Email and password are required.');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) backWithError('/sign-in', error.message);
  redirect('/orgs');
}

export async function signUp(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) backWithError('/sign-up', 'Email and password are required.');
  if (password.length < 8) backWithError('/sign-up', 'Password must be at least 8 characters.');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) backWithError('/sign-up', error.message);

  // With email confirmation enabled (Supabase default), no session exists yet.
  if (!data.session) {
    redirect('/sign-in?notice=' + encodeURIComponent('Check your email to confirm your account, then sign in.'));
  }
  redirect('/orgs');
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/');
}
