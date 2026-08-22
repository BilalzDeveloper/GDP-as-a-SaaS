'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  MODE_COOKIE,
  SKIN_COOKIE,
  parseMode,
  parseSkin,
} from '@/appearance/skins';

/** A year: long enough to be a setting, short enough to expire if abandoned. */
const MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Remember a reader's appearance choice.
 *
 * No `withRls` and no audit entry: this touches no tenant data and changes no
 * figure. It writes two cookies scoped to this browser, which is the whole of
 * its effect. `sameSite: 'lax'` and no `httpOnly` — the value is a palette
 * name, not a credential, and both are validated on read anyway, so a
 * tampered cookie yields the default rather than anything unexpected.
 */
export async function setAppearance(formData: FormData) {
  const skin = parseSkin(String(formData.get('skin') ?? ''));
  const mode = parseMode(String(formData.get('mode') ?? ''));

  const jar = await cookies();
  const options = {
    maxAge: MAX_AGE,
    path: '/',
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
  };
  jar.set(SKIN_COOKIE, skin, options);
  jar.set(MODE_COOKIE, mode, options);

  // Back to the picker so the choice is visible on the page that made it.
  redirect('/appearance?saved=1');
}
