#!/usr/bin/env node
// Contrast checking for the skins, as a test rather than a promise.
//
// The stylesheet claims that body text clears WCAG AA on every skin in both
// modes, and AAA on the Contrast skin. A claim like that decays the first
// time someone nudges a hex value, so it is checked here and wired into
// `npm test` through tests/ui/contrast.test.ts.
//
// Reads src/app/globals.css directly — the same file the browser loads — so
// there is no second copy of the palette to fall out of step with.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = join(ROOT, 'src', 'app', 'globals.css');

/** WCAG 2.1 relative luminance. */
function luminance(hex) {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 1:1 to 21:1. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every skin's palette, both modes, parsed out of the stylesheet.
 *
 * Skins inherit tokens they do not declare — `:root[data-skin='ink']` and
 * `:root` both match the same element — so each skin's palette is the default
 * one with its own declarations layered over it. The parse mirrors that.
 */
export function readSkins(css = readFileSync(CSS, 'utf8')) {
  const blocks = new Map();
  // `:root { … }` is the default skin; `[data-skin='x'] { … }` is each of the
  // others. The skin selectors are not anchored to :root so that the picker
  // can render a live sample inside the page.
  const re = /(?::root|\[data-skin='([a-z]+)'\])\s*\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    const name = match[1] ?? 'ledger';
    const tokens = blocks.get(name) ?? {};
    const declRe = /--([a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/g;
    let decl;
    while ((decl = declRe.exec(match[2])) !== null) {
      tokens[decl[1]] = { light: decl[2], dark: decl[3] };
    }
    blocks.set(name, tokens);
  }

  const base = blocks.get('ledger') ?? {};
  const skins = {};
  for (const [name, tokens] of blocks) {
    skins[name] = name === 'ledger' ? base : { ...base, ...tokens };
  }
  return skins;
}

/**
 * The pairings that have to hold. Body text and the muted text used for
 * explanatory notes both carry meaning, so both are checked; severity colours
 * are checked on the wash they actually sit on, not on the paper.
 */
export const PAIRS = [
  ['ink', 'paper', 'body text'],
  ['ink', 'surface', 'body text on a panel'],
  ['ink-2', 'surface', 'secondary text'],
  ['muted', 'paper', 'muted text'],
  ['muted', 'surface', 'muted text on a panel'],
  ['accent', 'paper', 'links'],
  ['accent', 'surface', 'links on a panel'],
  ['accent-fg', 'accent', 'button label'],
  ['critical', 'critical-wash', 'critical severity'],
  ['warning', 'warning-wash', 'warning severity'],
  ['positive', 'positive-wash', 'positive severity'],
  ['neutral-chip', 'neutral-chip-wash', 'neutral chip'],
];

/** AA for body text; the Contrast skin promises AAA and is held to it. */
export const threshold = (skin) => (skin === 'contrast' ? 7 : 4.5);

export function check(skins = readSkins()) {
  const failures = [];
  for (const [skin, tokens] of Object.entries(skins)) {
    for (const mode of ['light', 'dark']) {
      for (const [fg, bg, what] of PAIRS) {
        const a = tokens[fg]?.[mode];
        const b = tokens[bg]?.[mode];
        if (!a || !b) {
          failures.push(`${skin}/${mode}: ${what} — missing --${fg} or --${bg}`);
          continue;
        }
        const ratio = contrastRatio(a, b);
        const need = threshold(skin);
        if (ratio < need) {
          failures.push(
            `${skin}/${mode}: ${what} (--${fg} on --${bg}) is ` +
              `${ratio.toFixed(2)}:1, below ${need}:1`,
          );
        }
      }
    }
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const skins = readSkins();
  const failures = check(skins);
  for (const [skin, tokens] of Object.entries(skins)) {
    for (const mode of ['light', 'dark']) {
      const body = contrastRatio(tokens.ink[mode], tokens.paper[mode]);
      console.log(`${skin.padEnd(10)} ${mode.padEnd(5)} body ${body.toFixed(2)}:1`);
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} contrast failure(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log('\nAll pairings pass.');
}
