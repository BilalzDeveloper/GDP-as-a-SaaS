// Server-side Supabase client (auth/session only — tenant data goes through
// src/db/rls.ts so RLS applies on the one database path).
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { RlsClaims } from '@/db/rls';

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — middleware refreshes sessions.
          }
        },
      },
    },
  );
}

/**
 * Server-side-verified claims for the current user, or null when signed out.
 * getUser() revalidates the JWT against Supabase Auth — never trust
 * getSession() alone on the server.
 */
export async function getVerifiedClaims(): Promise<RlsClaims | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { sub: user.id, role: 'authenticated', email: user.email };
}
