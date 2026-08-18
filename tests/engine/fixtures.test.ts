// Fixture-driven tests. Every fixture in ./fixtures is run through the engine
// and checked against its declared expectations, so adding an official
// fixture (see fixtures/README.md) requires no new test code.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileGdp } from '../../src/engine';
import type {
  ExpenditureInput,
  IncomeInput,
  ProductionInput,
} from '../../src/engine';

interface Fixture {
  name: string;
  provenance: 'synthetic' | 'official';
  source: string;
  description: string;
  expected: { gdp: number; totalGrossValueAdded?: number };
  production?: ProductionInput;
  expenditure?: ExpenditureInput;
  income?: IncomeInput;
}

const dir = join(process.cwd(), 'tests/engine/fixtures');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const fixtures: Fixture[] = files.map(
  (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture,
);

describe('fixture hygiene', () => {
  it('finds at least one fixture', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('$name declares its provenance and source', (fixture) => {
    expect(['synthetic', 'official']).toContain(fixture.provenance);
    expect(fixture.source).toBeTruthy();
  });

  it('a fixture claiming official provenance must cite its figures', () => {
    // Guards the boundary described in fixtures/README.md: an "official"
    // fixture without per-figure citations is indistinguishable from a
    // remembered one, which is worse than having no fixture at all.
    for (const [i, fixture] of fixtures.entries()) {
      if (fixture.provenance !== 'official') continue;
      const raw = JSON.parse(readFileSync(join(dir, files[i]), 'utf8'));
      expect(raw.citations, `${fixture.name} must carry citations`).toBeTruthy();
    }
  });
});

describe.each(fixtures)('$name ($provenance)', (fixture) => {
  const input = {
    production: fixture.production,
    expenditure: fixture.expenditure,
    income: fixture.income,
  };

  it('produces the expected GDP by every approach supplied', () => {
    const result = compileGdp(input, { anchor: 'production' });
    for (const approach of result.approaches) {
      expect(approach.gdp, `${approach.approach} approach`).toBeCloseTo(
        fixture.expected.gdp,
        6,
      );
    }
  });

  if (fixture.expected.totalGrossValueAdded !== undefined) {
    it('produces the expected total gross value added', () => {
      const result = compileGdp(input);
      expect(result.production?.totalGrossValueAdded).toBeCloseTo(
        fixture.expected.totalGrossValueAdded!,
        6,
      );
    });
  }

  it('reconciles to a zero statistical discrepancy', () => {
    const result = compileGdp(input, { anchor: 'production' });
    for (const approach of result.approaches) {
      expect(approach.discrepancy, `${approach.approach} discrepancy`).toBeCloseTo(0, 6);
    }
  });

  it('reports no divergence diagnostics when the accounts agree', () => {
    const result = compileGdp(input, { anchor: 'production' });
    const divergence = result.diagnostics.filter((d) => d.code === 'approaches_diverge');
    expect(divergence).toEqual([]);
  });

  it('gives the same headline whichever approach anchors it', () => {
    // True for a consistent fixture by construction; the point of asserting
    // it is that a future engine change which quietly privileges one approach
    // would break here.
    const anchors = ['production', 'expenditure', 'income'] as const;
    const headlines = anchors
      .filter((a) => input[a] !== undefined)
      .map((a) => compileGdp(input, { anchor: a }).gdp);
    for (const headline of headlines) {
      expect(headline).toBeCloseTo(fixture.expected.gdp, 6);
    }
  });
});
