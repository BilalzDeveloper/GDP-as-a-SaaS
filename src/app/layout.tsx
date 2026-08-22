import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import {
  MODE_COOKIE,
  SKIN_COOKIE,
  parseMode,
  parseSkin,
  rootAttributes,
} from '@/appearance/skins';
import './globals.css';

export const metadata: Metadata = {
  title: 'GDP Compilation Platform',
  description:
    'Multi-tenant SNA 2008 GDP compilation for national statistical offices and researchers',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read on the server and stamped onto <html>, so the chosen skin is in the
  // first byte of markup. Doing this in the browser would show the default
  // skin for a frame first — the flash every themed application is judged by.
  const jar = await cookies();
  const attributes = rootAttributes(
    parseSkin(jar.get(SKIN_COOKIE)?.value),
    parseMode(jar.get(MODE_COOKIE)?.value),
  );

  return (
    <html lang="en" {...attributes}>
      <body>{children}</body>
    </html>
  );
}
