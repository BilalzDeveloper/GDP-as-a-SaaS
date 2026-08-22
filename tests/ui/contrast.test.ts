// The skins' accessibility claims, held to.
//
// `src/app/globals.css` states that body text clears WCAG AA on every skin in
// both modes and AAA on the Contrast skin. That is the sort of claim that
// decays silently the first time a hex value is nudged, so it is a test.
import { describe, expect, it } from 'vitest';
// Plain ESM script, shared with `npm run check:contrast` so the stylesheet is
// checked by exactly one implementation.
import {
  check,
  contrastRatio,
  readSkins,
  threshold,
  PAIRS,
} from '../../scripts/check-contrast.mjs';

const skins = readSkins() as Record<
  string,
  Record<string, { light: string; dark: string }>
>;

describe('skin palettes', () => {
  it('defines every skin the appearance picker offers', () => {
    expect(Object.keys(skins).sort()).toEqual([
      'contrast',
      'ink',
      'ledger',
      'parchment',
      'slate',
    ]);
  });

  it('gives every skin a complete palette', () => {
    // A skin declares only what it changes and inherits the rest, so a
    // missing token would silently fall back rather than fail loudly.
    const required = [...new Set(PAIRS.flatMap(([a, b]: string[]) => [a, b]))];
    for (const [name, tokens] of Object.entries(skins)) {
      for (const token of required) {
        expect(tokens[token], `${name} is missing --${token}`).toBeDefined();
      }
    }
  });

  it('passes every contrast pairing in both modes', () => {
    expect(check(skins)).toEqual([]);
  });

  it('holds the Contrast skin to AAA, not merely AA', () => {
    expect(threshold('contrast')).toBe(7);
    expect(threshold('ledger')).toBe(4.5);
    for (const mode of ['light', 'dark'] as const) {
      const ratio = contrastRatio(
        skins.contrast.ink[mode],
        skins.contrast.paper[mode],
      );
      expect(ratio).toBeGreaterThanOrEqual(7);
    }
  });

  it('keeps severity chromatic and distinguishable in every skin', () => {
    // Ink is near-monochrome by design, but a diagnostic table that reads as
    // ordinary text is worse than a colourful one. Severity keeps its scale
    // everywhere, and the three levels stay apart from each other.
    for (const [name, tokens] of Object.entries(skins)) {
      for (const mode of ['light', 'dark'] as const) {
        const [critical, warning, positive] = [
          tokens.critical[mode],
          tokens.warning[mode],
          tokens.positive[mode],
        ];
        expect(new Set([critical, warning, positive]).size, `${name}/${mode}`).toBe(3);
        // Each is distinguishable from plain body text, so severity never
        // reads as ordinary prose.
        for (const [label, colour] of [
          ['critical', critical],
          ['warning', warning],
          ['positive', positive],
        ] as const) {
          expect(colour, `${name}/${mode} ${label}`).not.toBe(tokens.ink[mode]);
        }
      }
    }
  });
});
