// The brief requires the engine to be "a pure, dependency-free TypeScript
// module with no database imports". That property is easy to state and easy
// to erode — one convenient import of the Drizzle schema for a type, and the
// engine is no longer portable or independently testable.
//
// This test enforces it mechanically rather than by review.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const engineDir = join(process.cwd(), 'src/engine');
const files = readdirSync(engineDir).filter((f) => f.endsWith('.ts'));

const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm;

function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1]);
}

describe('the engine is pure and dependency-free', () => {
  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s imports only from within the engine', (file) => {
    const source = readFileSync(join(engineDir, file), 'utf8');
    const external = importsOf(source).filter((spec) => !spec.startsWith('./'));
    expect(external, `${file} must not import anything outside src/engine`).toEqual([]);
  });

  it.each(files)('%s does not reach for the database or the app', (file) => {
    const source = readFileSync(join(engineDir, file), 'utf8');
    const forbidden = [
      'drizzle-orm',
      'postgres',
      '@supabase',
      'next/',
      '@/db',
      '@/lib',
      'node:fs',
      'node:crypto',
    ];
    const found = forbidden.filter((needle) =>
      importsOf(source).some((spec) => spec.includes(needle)),
    );
    expect(found, `${file} must not import ${found.join(', ')}`).toEqual([]);
  });

  it('performs no I/O and reads no environment', () => {
    for (const file of files) {
      const source = readFileSync(join(engineDir, file), 'utf8');
      // Strip comments so prose mentioning these words does not trip the test.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} must not read process.env`).not.toMatch(/process\.env/);
      expect(code, `${file} must not use fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${file} must not touch the filesystem`).not.toMatch(/\breadFile|writeFile\b/);
    }
  });

  it('is importable without any application context', async () => {
    // A fresh import with no DATABASE_URL, no Supabase config, nothing.
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const engine = await import('../../src/engine');
      expect(engine.ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      expect(
        engine.computeIncomeApproach({
          compensationOfEmployees: 10,
          grossOperatingSurplus: 5,
          grossMixedIncome: 2,
          taxesOnProductionAndImports: 3,
          subsidies: 1,
        }).gdp,
      ).toBe(19);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
