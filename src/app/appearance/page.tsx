import Link from 'next/link';
import { cookies } from 'next/headers';
import { IdentityBar, Panel } from '@/components/shell';
import { getVerifiedClaims } from '@/lib/supabase/server';
import {
  MODES,
  MODE_COOKIE,
  SKINS,
  SKIN_COOKIE,
  parseMode,
  parseSkin,
} from '@/appearance/skins';
import { setAppearance } from './actions';

export const metadata = {
  title: 'Appearance — SNA Compilation Platform',
  description: 'Choose how the platform looks: a skin and a light or dark mode.',
};

/**
 * A miniature of the real interface, rendered in one skin.
 *
 * `data-skin` and `data-theme` cascade to descendants exactly as they do on
 * `<html>`, so a sample is the actual stylesheet under a different palette
 * rather than a drawing of one. That matters: a swatch row would show the
 * colours without showing what a table of figures or a severity row looks
 * like in them, which is the only question worth asking here.
 */
function Sample({ skin, mode }: { skin: string; mode: 'light' | 'dark' }) {
  return (
    <div
      className="skin-sample"
      data-skin={skin === 'ledger' ? undefined : skin}
      data-theme={mode}
      aria-hidden="true"
    >
      <div className="skin-sample-bar">
        <span className="mark">SNA</span>
        <span className="skin-sample-mode">{mode}</span>
      </div>
      <div className="skin-sample-body">
        <table>
          <colgroup>
            <col className="name" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Industry</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <span className="mono">C</span> Manufacturing
              </td>
              <td className="num strong">33,715</td>
            </tr>
            <tr>
              <td>
                <span className="mono">K</span> Financial
              </td>
              <td className="num strong">8,432</td>
            </tr>
          </tbody>
        </table>
        <div className="skin-sample-pills">
          <span className="pill is-warning">warning</span>
          <span className="pill is-positive">approved</span>
          <span className="pill">draft</span>
        </div>
      </div>
    </div>
  );
}

export default async function AppearancePage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const { saved } = await searchParams;
  const claims = await getVerifiedClaims();
  const jar = await cookies();
  const current = parseSkin(jar.get(SKIN_COOKIE)?.value);
  const currentMode = parseMode(jar.get(MODE_COOKIE)?.value);

  return (
    <>
      <IdentityBar email={claims?.email} />
      <main className="guide">
        <h1>Appearance</h1>
        <p className="lede">
          Five palettes and a light or dark mode. Every one of them is the same
          interface — the choice changes colours, never what a page says or
          where anything is.
        </p>

        {saved && (
          <div className="callout is-positive">
            <p className="callout-title">Saved</p>
            <p style={{ marginBottom: 0 }}>
              This browser will remember it. Someone else signing in on their
              own machine keeps their own choice.
            </p>
          </div>
        )}

        <form action={setAppearance}>
          <Panel title="Mode">
            <div className="skin-modes">
              {MODES.map((m) => (
                <label key={m.id} className="skin-mode">
                  <input
                    type="radio"
                    name="mode"
                    value={m.id}
                    defaultChecked={m.id === currentMode}
                  />
                  <span>{m.name}</span>
                </label>
              ))}
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              &ldquo;Match my system&rdquo; follows the light or dark setting of
              the computer you are reading on, and changes with it.
            </p>
          </Panel>

          <h2>Skin</h2>
          <div className="skin-grid">
            {SKINS.map((skin) => (
              <label
                key={skin.id}
                className="skin-choice"
                data-current={skin.id === current ? 'true' : undefined}
              >
                <span className="skin-choice-head">
                  <span className="skin-choice-name">
                    <input
                      type="radio"
                      name="skin"
                      value={skin.id}
                      defaultChecked={skin.id === current}
                    />
                    {skin.name}
                    {skin.id === current && (
                      <span className="pill is-positive">in use</span>
                    )}
                  </span>
                  <span className="muted">{skin.tagline}</span>
                </span>
                {/* Both modes, because a skin that reads well in one and badly
                    in the other is a choice made half-blind. */}
                <span className="skin-samples">
                  <Sample skin={skin.id} mode="light" />
                  <Sample skin={skin.id} mode="dark" />
                </span>
                <span className="skin-choice-note">{skin.description}</span>
              </label>
            ))}
          </div>

          <p className="skin-actions">
            <button type="submit">Save appearance</button>
          </p>
        </form>

        <h2>What this does not change</h2>
        <p>
          A skin is a palette. It does not move a control, rename a button,
          hide a warning or alter a figure — the same compilation looks the
          same to everyone who reads it, whatever palette they read it in. That
          is deliberate: two people discussing a discrepancy over the phone
          must be looking at the same page.
        </p>
        <p>
          Every skin is checked for contrast in both modes before it ships.
          Body text clears WCAG AA everywhere, and the Contrast skin clears
          AAA. Severity keeps its own colours in all five, including Ink —
          colour is never the only signal, so a warning carries a word and a
          stripe as well as a hue.
        </p>
        <p>
          The choice is remembered in a cookie on this browser rather than
          against your account, so you can use Contrast on a projector and
          something quieter on your own monitor without changing a setting each
          time.
        </p>
        <p>
          <Link href="/help">User guide</Link>
          {' · '}
          <Link href="/orgs">Back to your organizations</Link>
        </p>
      </main>
    </>
  );
}
