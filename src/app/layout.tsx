import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GDP Compilation Platform',
  description:
    'Multi-tenant SNA 2008 GDP compilation for national statistical offices and researchers',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
