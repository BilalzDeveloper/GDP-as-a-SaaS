// FISIM and imputed rent, from stored observations to the engine.
//
// The engine has applied both since milestone 3 and is tested there. What is
// tested here is the part that was missing until migration 0010: turning
// uploaded rows into `FisimInput` and `ImputedRentInput`, and refusing to
// build a half-specified one.
//
// The refusals matter more than the happy path. A FISIM total with no
// allocation, or an allocation with no total, would let the engine compute a
// figure from a statement the compiler never made — and it would look
// entirely reasonable on the page.
import { describe, expect, it } from 'vitest';
import { assemblePeriod, type ObservationRow } from '@/compile/assemble';
import { compileGdp } from '@/engine';

function row(
  transactionCode: string,
  value: number,
  activityCode: string | null = null,
): ObservationRow {
  return {
    periodId: 'p1',
    periodLabel: '2024',
    transactionCode,
    activityItemId: activityCode ? `item-${activityCode}` : null,
    activityCode,
    sectorItemId: null,
    sectorCode: null,
    value,
    unitCode: 'NC_MN',
    valuation: transactionCode === 'P.1' ? 'basic' : null,
  };
}

/**
 * A minimal production account: two industries, taxes and subsidies.
 *
 *   Σ GVA = (1000 − 400) + (500 − 200) = 900
 *   GDP   = 900 + 100 − 20 = 980
 */
const BASE = [
  row('P.1', 1000, 'C'),
  row('P.2', 400, 'C'),
  row('P.1', 500, 'K'),
  row('P.2', 200, 'K'),
  row('D.21', 100),
  row('D.31', 20),
];

const assemble = (rows: ObservationRow[], options = {}) =>
  assemblePeriod('p1', '2024', rows, options);

describe('FISIM reaches the engine', () => {
  // FISIM output 60, of which 40 is consumed by industry C, 15 by households
  // and 5 exported. The allocation exhausts the output.
  const FISIM_ROWS = [
    row('FISIM.P1', 60),
    row('FISIM.P2', 40, 'C'),
    row('FISIM.P31', 15),
    row('FISIM.P6', 5),
  ];

  it('assembles the input the engine expects', () => {
    const { production, problems } = assemble([...BASE, ...FISIM_ROWS]);
    expect(problems).toEqual([]);
    expect(production?.fisim).toEqual({
      totalOutput: 60,
      intermediateByIndustry: { C: 40 },
      householdFinalConsumption: 15,
      governmentFinalConsumption: 0,
      exports: 5,
      treatment: undefined,
    });
  });

  it('lowers GDP by exactly the intermediate portion', () => {
    // The 40 consumed by industry C becomes intermediate consumption there,
    // so value added falls by 40 and GDP with it: 980 − 40 = 940. The 15 + 5
    // of final use is already in the financial industry's output and is not
    // netted off, which is the whole point of allocating FISIM.
    const without = compileGdp({ production: assemble(BASE).production! });
    const withFisim = compileGdp({
      production: assemble([...BASE, ...FISIM_ROWS]).production!,
    });
    expect(without.production!.gdp).toBe(980);
    expect(withFisim.production!.gdp).toBe(940);
  });

  it('cancels FISIM out of GDP entirely under the unallocated treatment', () => {
    // SNA 1993: the whole 60 becomes intermediate consumption of a nominal
    // industry, so GDP falls by the full amount rather than by the part
    // producers consumed. 980 − 60 = 920.
    const { production } = assemble([...BASE, ...FISIM_ROWS], {
      fisimTreatment: 'unallocated',
    });
    expect(production?.fisim?.treatment).toBe('unallocated');
    expect(compileGdp({ production: production! }).production!.gdp).toBe(920);
  });

  it('carries the run’s treatment through to the engine', () => {
    const allocated = assemble([...BASE, ...FISIM_ROWS], {
      fisimTreatment: 'allocated',
    });
    expect(allocated.production?.fisim?.treatment).toBe('allocated');
  });

  it('lets the engine report an allocation that does not exhaust the output', () => {
    // 40 + 15 = 55 against an output of 60. The assembler passes it on; the
    // engine is where the check lives, and it must fire rather than the
    // shortfall silently distorting value added.
    const { production } = assemble([
      ...BASE,
      row('FISIM.P1', 60),
      row('FISIM.P2', 40, 'C'),
      row('FISIM.P31', 15),
    ]);
    const result = compileGdp({ production: production! });
    expect(
      result.diagnostics.map((d) => d.code),
    ).toContain('fisim_allocation_mismatch');
  });
});

describe('FISIM the assembler refuses to guess at', () => {
  it('withholds the adjustment when the total is missing', () => {
    const { production, problems } = assemble([
      ...BASE,
      row('FISIM.P2', 40, 'C'),
      row('FISIM.P31', 15),
    ]);
    expect(production?.fisim).toBeUndefined();
    expect(problems.map((p) => p.code)).toEqual(['adjustment_incomplete']);
    expect(problems[0].message).toContain('FISIM.P1');
    // The rest of the production account still compiles.
    expect(compileGdp({ production: production! }).production!.gdp).toBe(980);
  });

  it('withholds the adjustment when nothing is allocated', () => {
    const { production, problems } = assemble([...BASE, row('FISIM.P1', 60)]);
    expect(production?.fisim).toBeUndefined();
    expect(problems[0].message).toContain('none of it is allocated');
  });

  it('reports an intermediate allocation with no industry to attach it to', () => {
    const { production, problems } = assemble([
      ...BASE,
      row('FISIM.P1', 60),
      row('FISIM.P2', 40), // no industry
      row('FISIM.P31', 20),
    ]);
    expect(problems.map((p) => p.code)).toContain('adjustment_incomplete');
    // The unattributable amount is left out rather than guessed at, which the
    // engine then reports as a shortfall against the total.
    expect(production?.fisim?.intermediateByIndustry).toEqual({});
    const result = compileGdp({ production: production! });
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'fisim_allocation_mismatch',
    );
  });

  it('adds nothing at all when the compilation has no FISIM', () => {
    const { production, problems } = assemble(BASE);
    expect(production?.fisim).toBeUndefined();
    expect(problems).toEqual([]);
  });
});

describe('imputed rent reaches the engine', () => {
  it('folds into the industry that records it', () => {
    const { production, problems } = assemble([
      ...BASE,
      row('IMPRENT.P1', 300, 'L'),
      row('IMPRENT.P2', 50, 'L'),
    ]);
    expect(problems).toEqual([]);
    expect(production?.imputedRent).toEqual({
      industryCode: 'L',
      output: 300,
      intermediateConsumption: 50,
    });
    // A new industry, since L was not among the two supplied: GDP rises by
    // 300 − 50 = 250, to 1230.
    expect(compileGdp({ production: production! }).production!.gdp).toBe(1230);
  });

  it('adds to an industry already present rather than duplicating it', () => {
    const { production } = assemble([
      ...BASE,
      row('IMPRENT.P1', 300, 'C'),
      row('IMPRENT.P2', 50, 'C'),
    ]);
    const result = compileGdp({ production: production! });
    expect(result.production!.industries).toHaveLength(2);
    const manufacturing = result.production!.industries.find((i) => i.code === 'C')!;
    // 1000 + 300 output, 400 + 50 intermediate → value added 850.
    expect(manufacturing.grossValueAdded).toBe(850);
  });

  it('accepts output with no intermediate consumption', () => {
    const { production, problems } = assemble([...BASE, row('IMPRENT.P1', 300, 'L')]);
    expect(problems).toEqual([]);
    expect(production?.imputedRent?.intermediateConsumption).toBe(0);
  });

  it('refuses an adjustment split across two industries', () => {
    // The engine folds output and its inputs into one industry. Two different
    // ones is a mapping error, and applying it would move value added to the
    // wrong place.
    const { production, problems } = assemble([
      ...BASE,
      row('IMPRENT.P1', 300, 'L'),
      row('IMPRENT.P2', 50, 'C'),
    ]);
    expect(production?.imputedRent).toBeUndefined();
    expect(problems[0].message).toContain('split across industries');
  });

  it('refuses intermediate consumption with no output', () => {
    const { production, problems } = assemble([...BASE, row('IMPRENT.P2', 50, 'L')]);
    expect(production?.imputedRent).toBeUndefined();
    expect(problems[0].message).toContain('IMPRENT.P1');
  });

  it('refuses an adjustment carrying no industry', () => {
    const { production, problems } = assemble([...BASE, row('IMPRENT.P1', 300)]);
    expect(production?.imputedRent).toBeUndefined();
    expect(problems[0].message).toContain('typically ISIC division 68');
  });
});

describe('the imputed-rent consistency check', () => {
  const EXPENDITURE = [
    row('P.31', 700),
    row('P.32', 200),
    row('P.51g', 150),
    row('P.6', 100),
    row('P.7', 170),
  ];

  const withRent = (options: Record<string, unknown>) => {
    const assembled = assemble(
      [...BASE, ...EXPENDITURE, row('IMPRENT.P1', 300, 'L')],
      options,
    );
    // Both sides must actually have been built, or the check below would
    // pass vacuously — the engine says nothing when it has one side only.
    expect(assembled.production?.imputedRent).toBeDefined();
    expect(assembled.expenditure).toBeDefined();
    return assembled;
  };

  it('reports imputed rent recorded as output but absent from expenditure', () => {
    // The classic compilation error: the two approaches then differ by
    // exactly the imputed amount, and the discrepancy has a known cause.
    const { production, expenditure } = withRent({
      expenditureIncludesImputedRent: false,
    });
    const result = compileGdp({ production: production!, expenditure: expenditure! });
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'imputed_rent_not_in_expenditure',
    );
  });

  it('says nothing when the compiler states that expenditure includes it', () => {
    const { production, expenditure } = withRent({
      expenditureIncludesImputedRent: true,
    });
    const result = compileGdp({ production: production!, expenditure: expenditure! });
    expect(result.diagnostics.map((d) => d.code)).not.toContain(
      'imputed_rent_not_in_expenditure',
    );
  });

  it('treats "not stated" as its own answer, not as yes', () => {
    // A compiler who has not said is different from one who has checked. The
    // engine asks rather than assuming, and the assembler must not turn an
    // absent setting into a false.
    const { production, expenditure } = withRent({});
    expect(expenditure?.includesImputedRent).toBeUndefined();
    const result = compileGdp({ production: production!, expenditure: expenditure! });
    const diagnostic = result.diagnostics.find(
      (d) => d.code === 'imputed_rent_not_in_expenditure',
    );
    expect(diagnostic?.message).toContain('set includesImputedRent');
  });
});
