// The skins a reader can choose, and how the choice is carried.
//
// A skin is a palette in `src/app/globals.css` and nothing more: every
// component reads tokens, so a skin changes the look without touching a rule.
// This module is the list, shared by the picker, the layout and the tests, so
// there is one place where a skin is added.
//
// The choice lives in a cookie rather than in the database. It is a property
// of the reader at this screen — the same person may want Contrast on a
// projector and Parchment on their own monitor — it must apply before first
// paint with no query, and it has to work signed out. A per-user column would
// cost a migration, an audited write and a round trip, to store something
// less accurate. See DECISIONS.md D50.

export const SKINS = [
  {
    id: 'ledger',
    name: 'Ledger',
    tagline: 'The default',
    description:
      'Neutrals with a faint green-slate bias and a single teal accent, ' +
      'used sparingly. Built for reading tables of figures.',
  },
  {
    id: 'slate',
    name: 'Slate',
    tagline: 'Cool and familiar',
    description:
      'Blue-grey neutrals and an indigo accent — the register most ' +
      'public-sector and enterprise software is written in.',
  },
  {
    id: 'parchment',
    name: 'Parchment',
    tagline: 'Easier on the eyes',
    description:
      'Warm cream and umber with the glare pulled back, for compiling ' +
      'across a whole afternoon rather than glancing at a dashboard.',
  },
  {
    id: 'contrast',
    name: 'Contrast',
    tagline: 'Maximum separation',
    description:
      'Body text at 21:1, heavier rules and stronger severity colours. ' +
      'For low vision, bright rooms and projectors. Clears WCAG AAA.',
  },
  {
    id: 'ink',
    name: 'Ink',
    tagline: 'Near-monochrome',
    description:
      'Everything structural in graphite. Severity keeps its colour — a ' +
      'diagnostic that reads as ordinary text would be worse.',
  },
] as const;

export type SkinId = (typeof SKINS)[number]['id'];

export const MODES = [
  { id: 'system', name: 'Match my system' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
] as const;

export type ModeId = (typeof MODES)[number]['id'];

export const SKIN_COOKIE = 'skin';
export const MODE_COOKIE = 'mode';

export const DEFAULT_SKIN: SkinId = 'ledger';
export const DEFAULT_MODE: ModeId = 'system';

/** A cookie is reader-supplied text; anything unrecognised is the default. */
export function parseSkin(value: string | undefined): SkinId {
  return SKINS.some((s) => s.id === value) ? (value as SkinId) : DEFAULT_SKIN;
}

export function parseMode(value: string | undefined): ModeId {
  return MODES.some((m) => m.id === value) ? (value as ModeId) : DEFAULT_MODE;
}

/**
 * What goes on `<html>`. The default skin sets no attribute — its palette is
 * the bare `:root` — and 'system' sets no theme, leaving `color-scheme` as
 * `light dark` so the operating system decides.
 */
export function rootAttributes(skin: SkinId, mode: ModeId) {
  return {
    ...(skin === DEFAULT_SKIN ? {} : { 'data-skin': skin }),
    ...(mode === 'system' ? {} : { 'data-theme': mode }),
  };
}
