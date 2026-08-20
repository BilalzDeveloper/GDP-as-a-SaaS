import Link from 'next/link';
import { signOut } from '@/app/(auth)/actions';

/** The organization sections, in the order work moves through them. */
export const SECTIONS = [
  { key: 'overview', label: 'Overview', path: '' },
  { key: 'classifications', label: 'Classifications', path: '/classifications' },
  { key: 'data', label: 'Source data', path: '/data' },
  { key: 'runs', label: 'Compilation runs', path: '/runs' },
] as const;

export type SectionKey = (typeof SECTIONS)[number]['key'];

/**
 * The identity bar: who you are and which organization you are working in.
 * Separate from the section nav so switching sections never moves it.
 */
export function IdentityBar({
  email,
  orgName,
}: {
  email?: string;
  orgName?: string;
}) {
  return (
    <div className="identity-bar">
      <div className="identity-inner">
        <Link href="/orgs" className="wordmark">
          <span className="mark">SNA</span>
          <span>Compilation Platform</span>
        </Link>
        <div className="identity-right">
          {orgName && <span>{orgName}</span>}
          {email && <span className="mono">{email}</span>}
          {email && (
            <form action={signOut}>
              <button className="link" type="submit">
                Sign out
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export function SectionNav({
  slug,
  current,
}: {
  slug: string;
  current: SectionKey;
}) {
  return (
    <nav className="section-nav" aria-label="Organization sections">
      <div className="section-nav-inner">
        {SECTIONS.map((section) => (
          <Link
            key={section.key}
            href={`/orgs/${slug}${section.path}`}
            aria-current={section.key === current ? 'page' : undefined}
          >
            {section.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** Everything an organization page needs above its content. */
export function OrgShell({
  slug,
  orgName,
  email,
  current,
}: {
  slug: string;
  orgName: string;
  email?: string;
  current: SectionKey;
}) {
  return (
    <>
      <IdentityBar email={email} orgName={orgName} />
      <SectionNav slug={slug} current={current} />
    </>
  );
}

/** A titled panel. Tables belong in `scroll` panels so the page never shifts. */
export function Panel({
  title,
  aside,
  scroll,
  children,
}: {
  title?: string;
  aside?: React.ReactNode;
  scroll?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-head">
          <h3>{title}</h3>
          {aside}
        </div>
      )}
      <div className={scroll ? 'panel-scroll' : 'panel-body'}>{children}</div>
    </section>
  );
}

/** Formats a figure for a numeric column; renders an em dash for nothing. */
export function Num({ value }: { value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === '') return <>—</>;
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return <>{String(value)}</>;
  return <>{n.toLocaleString('en-GB', { maximumFractionDigits: 2 })}</>;
}
