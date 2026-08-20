// Numeric policy for the engine. See DECISIONS.md D3: values are stored as
// NUMERIC(20,6) but computed in IEEE-754 doubles, which carry ~15–16
// significant digits — well beyond any published national-accounts precision.
// Rounding happens once, at publication, not silently mid-calculation.

/**
 * Default comparison tolerance, relative to the magnitude being compared.
 * Used for "should these balance?" checks, never to hide a real difference:
 * a discrepancy between approaches is reported as a number, not tolerated.
 */
export const DEFAULT_RELATIVE_TOLERANCE = 1e-9;

/** Absolute floor for tolerance, so comparisons against zero behave. */
export const DEFAULT_ABSOLUTE_TOLERANCE = 1e-6;

/**
 * True when two amounts agree to within tolerance. Scale-aware: comparing
 * figures in units and figures in millions should not need different code.
 */
export function approximatelyEqual(
  a: number,
  b: number,
  relativeTolerance = DEFAULT_RELATIVE_TOLERANCE,
  absoluteTolerance = DEFAULT_ABSOLUTE_TOLERANCE,
): boolean {
  const diff = Math.abs(a - b);
  if (diff <= absoluteTolerance) return true;
  return diff <= relativeTolerance * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * Sum in a fixed order with Neumaier compensation. National accounts add
 * hundreds of industry figures of very different magnitudes; naive summation
 * accumulates rounding error that then shows up as a spurious statistical
 * discrepancy, which a compiler would waste real time investigating.
 */
export function sum(values: readonly number[]): number {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const t = total + value;
    compensation +=
      Math.abs(total) >= Math.abs(value)
        ? total - t + value
        : value - t + total;
    total = t;
  }
  return total + compensation;
}

/** Sum a field across records, in the order given. */
export function sumBy<T>(items: readonly T[], select: (item: T) => number): number {
  return sum(items.map(select));
}

/**
 * Round for publication. Half-away-from-zero, which is what statistical
 * publications use and what a reader checking by hand expects — unlike
 * JavaScript's Math.round, which rounds −0.5 to −0 rather than −1.
 */
export function roundForPublication(value: number, decimalPlaces = 0): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimalPlaces;
  const scaled = value * factor;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  // Adding 0 normalises −0 to 0 so published zeros never carry a sign.
  return rounded / factor + 0;
}

/** Guard against inputs that would make every downstream figure meaningless. */
export function assertFinite(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, received ${String(value)}`);
  }
}

/**
 * Solve a dense square linear system A·x = b by Gaussian elimination with
 * partial pivoting.
 *
 * Boring on purpose. Benchmarking a quarterly series to annual totals is a
 * constrained least-squares problem, and the textbook way to state it is a
 * KKT system — which is then just a linear solve. Writing that solve out in
 * full keeps the whole method auditable in one file, where a matrix library
 * would move the part a statistician most wants to check out of the repo.
 *
 * The singularity threshold is relative to the largest entry in the matrix,
 * so it behaves the same whether figures arrive in units or in millions.
 */
export function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
): number[] {
  const n = rhs.length;
  if (matrix.length !== n) {
    throw new RangeError(
      `Matrix has ${matrix.length} rows but the right-hand side has ${n} entries`,
    );
  }

  let scale = 0;
  for (const row of matrix) {
    if (row.length !== n) throw new RangeError('Matrix must be square');
    for (const entry of row) {
      assertFinite(entry, 'matrix entry');
      scale = Math.max(scale, Math.abs(entry));
    }
  }
  for (const entry of rhs) assertFinite(entry, 'right-hand side entry');
  if (scale === 0) throw new RangeError('Matrix is entirely zero and cannot be solved');
  const tolerance = scale * 1e-12;

  // Augmented [A | b], copied so the caller's arrays are untouched.
  const a: number[][] = matrix.map((row, i) => [...row, rhs[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) <= tolerance) {
      throw new RangeError(
        `System is singular at column ${col}; it has no unique solution`,
      );
    }
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]];

    for (let row = col + 1; row < n; row++) {
      const factor = a[row][col] / a[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) a[row][c] -= factor * a[col][c];
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let total = a[i][n];
    for (let j = i + 1; j < n; j++) total -= a[i][j] * x[j];
    x[i] = total / a[i][i];
  }
  return x;
}
