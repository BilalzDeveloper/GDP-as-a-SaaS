// Shared helpers for the end-to-end suite.
//
// These drive the application through its own interface — click a link, fill
// a form, submit it — rather than reaching into the database to set state up.
// A helper that took a shortcut would test the shortcut.
import { expect, type Page } from '@playwright/test';

/** Unique per run, so a suite re-run against the same database is clean. */
export const runId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export const PASSWORD = 'compilation-platform-e2e';

/** Register a new account and land signed in. */
export async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/orgs$/);
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/orgs$/);
}

export async function signOut(page: Page): Promise<void> {
  // From a page that has the identity bar — a 404 does not, and callers
  // legitimately sign out after checking that one.
  await page.goto('/orgs');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Create an organization and return its slug. The creator becomes admin. */
export async function createOrganization(
  page: Page,
  name: string,
  slug: string,
): Promise<string> {
  await page.goto('/orgs');
  await page.locator('input[name="name"]').fill(name);
  await page.locator('input[name="slug"]').fill(slug);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  return slug;
}

/** Define the reference periods a fiscal year needs. */
export async function definePeriods(
  page: Page,
  slug: string,
  fiscalYear: number,
  cover: 'both' | 'annual' | 'quarterly' = 'both',
): Promise<void> {
  await page.goto(`/orgs/${slug}/data`);
  await page.locator('input[name="fiscalYear"]').fill(String(fiscalYear));
  await page.locator('select[name="cover"]').selectOption(cover);
  await page.getByRole('button', { name: 'Define periods' }).click();
  await expect(
    page.getByRole('cell', { name: String(fiscalYear), exact: true }),
  ).toBeVisible();
}

/** Upload a CSV from a string, without touching the filesystem. */
export async function uploadCsv(
  page: Page,
  slug: string,
  name: string,
  filename: string,
  csv: string,
): Promise<void> {
  await page.goto(`/orgs/${slug}/data`);
  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await page.locator('input[name="name"]').fill(name);
  await page
    .locator('input[name="provenance"]')
    .fill('e2e fixture, generated in the test');
  await page.getByRole('button', { name: 'Upload' }).click();
  // Upload lands on the dataset's own page — the next thing to do is map it.
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/**
 * A small internally consistent economy. Production and income both give
 * GDP = 1600, so the compiled discrepancy is zero and any non-zero figure in
 * the interface is a real defect rather than a fixture artefact.
 *
 *   Σ GVA  = (500−200) + (2000−1200) + (700−450) = 1350
 *   GDP    = 1350 + D.21 320 − D.31 70          = 1600
 *   income = 800 + 350 + 100 + 420 − 70         = 1600
 */
export function annualCsv(periodLabel: string): string {
  return [
    'txn,isic,period,value',
    `P.1,A,${periodLabel},500`,
    `P.2,A,${periodLabel},200`,
    `P.1,C,${periodLabel},2000`,
    `P.2,C,${periodLabel},1200`,
    `P.1,F,${periodLabel},700`,
    `P.2,F,${periodLabel},450`,
    `D.21,,${periodLabel},320`,
    `D.31,,${periodLabel},70`,
    `D.1,,${periodLabel},800`,
    `B.2g,,${periodLabel},350`,
    `B.3g,,${periodLabel},100`,
    `D.2,,${periodLabel},420`,
    `D.3,,${periodLabel},70`,
  ].join('\n');
}

/** Map the uploaded columns and stage them for validation. */
export async function applyStandardMapping(
  page: Page,
  unitCode = 'NC_MN',
  /** Map the sector column too, against the seeded SNA sector classification. */
  withSectors = false,
): Promise<void> {
  // Selects are addressed by name: Playwright folds a wrapped select's option
  // text into its accessible name, so label-based lookup is ambiguous here.
  await page.locator('select[name="col_value"]').selectOption('value');
  await page.locator('select[name="col_periodLabel"]').selectOption('period');
  await page.locator('select[name="col_transactionCode"]').selectOption('txn');
  await page.locator('select[name="col_activityCode"]').selectOption('isic');
  // The seeded ISIC version, whatever id it was given.
  const isic = page
    .locator('select[name="activityVersionId"] option')
    .filter({ hasText: 'ISIC4' })
    .first();
  await page
    .locator('select[name="activityVersionId"]')
    .selectOption(await isic.getAttribute('value'));
  if (withSectors) {
    await page.locator('select[name="col_sectorCode"]').selectOption('sector');
    const sna = page
      .locator('select[name="sectorVersionId"] option')
      .filter({ hasText: 'SNA_SECTOR' })
      .first();
    await page
      .locator('select[name="sectorVersionId"]')
      .selectOption(await sna.getAttribute('value'));
  }
  await page.locator('select[name="unitCode"]').selectOption(unitCode);
  await page.getByRole('button', { name: 'Apply mapping and validate' }).click();
  // Wait for the staged state rather than for the click: the action redirects,
  // and anything typed before that lands on the page about to be replaced.
  // Commit becoming enabled is the real signal — rows are staged and nothing
  // is blocking.
  await expect(page.getByRole('button', { name: 'Commit staged rows' })).toBeEnabled();
}

/** Commit the staged rows into a named vintage. */
export async function commitInto(page: Page, vintageName: string): Promise<void> {
  await page.locator('input[name="vintageName"]').fill(vintageName);
  await page.getByRole('button', { name: 'Commit staged rows' }).click();
  // Singular when a file holds one row — the page pluralises, the wait must too.
  await expect(page.getByText(/observations? committed/)).toBeVisible();
}

/**
 * A population figure for the same period, in thousands of people.
 *
 * Filed on the memorandum code POP, which never enters an aggregate — the
 * unit is what makes the per-capita figure right, so the fixture uses
 * thousands rather than people to exercise the multiplier.
 */
export function populationCsv(periodLabel: string): string {
  return ['txn,isic,period,value', `POP,,${periodLabel},8000`].join('\n');
}

/**
 * The same economy with FISIM recorded explicitly, and still internally
 * consistent.
 *
 * Financial corporations produce 100 of FISIM, of which industry C consumes
 * 60 as an input and households and non-residents take 40 as final use. Under
 * the SNA 2008 allocated treatment the 60 is intermediate consumption, so
 * value added falls by it:
 *
 *   Σ GVA  = 1350 − 60                  = 1290
 *   GDP    = 1290 + D.21 320 − D.31 70  = 1540
 *
 * Operating surplus is 60 lower than in `annualCsv` for the same reason — the
 * industries consuming FISIM earn less on it — so the income approach gives
 * 1540 too and the discrepancy stays zero. A defect anywhere in the
 * adjustment path shows up as a non-zero discrepancy rather than as a figure
 * that merely looks wrong.
 */
export function adjustmentsCsv(periodLabel: string): string {
  return [
    'txn,isic,period,value',
    `P.1,A,${periodLabel},500`,
    `P.2,A,${periodLabel},200`,
    `P.1,C,${periodLabel},2000`,
    `P.2,C,${periodLabel},1200`,
    `P.1,F,${periodLabel},700`,
    `P.2,F,${periodLabel},450`,
    `D.21,,${periodLabel},320`,
    `D.31,,${periodLabel},70`,
    `D.1,,${periodLabel},800`,
    `B.2g,,${periodLabel},290`,
    `B.3g,,${periodLabel},100`,
    `D.2,,${periodLabel},420`,
    `D.3,,${periodLabel},70`,
    `FISIM.P1,,${periodLabel},100`,
    `FISIM.P2,C,${periodLabel},60`,
    `FISIM.P31,,${periodLabel},30`,
    `FISIM.P6,,${periodLabel},10`,
  ].join('\n');
}

/**
 * A complete expenditure account with consumption filed against the sector
 * that did it, which is what the institutional-sector dimension is for.
 *
 *   GDP = 1700 (S.14) + 60 (S.15) + 550 (S.13) + 600 + 40 + 10 + 700 − 710
 *       = 2950
 *
 * Government is filed on P.3 of S.13, the full figure: both the collective
 * services and the individual ones it provides to households. There is no
 * code that says that without the sector, which is the point of the fixture.
 */
export function sectorExpenditureCsv(periodLabel: string): string {
  return [
    'txn,isic,sector,period,value',
    `P.31,,S.14,${periodLabel},1700`,
    `P.31,,S.15,${periodLabel},60`,
    `P.3,,S.13,${periodLabel},550`,
    `P.51g,,,${periodLabel},600`,
    `P.52,,,${periodLabel},40`,
    `P.53,,,${periodLabel},10`,
    `P.6,,,${periodLabel},700`,
    `P.7,,,${periodLabel},710`,
  ].join('\n');
}

/**
 * A production account whose producers carry an institutional sector as well
 * as an industry — the two groupings of the same records (SNA 2008 ch.4).
 *
 *   By industry: (2000−1200) + (700−450) + (500−200) = 1350
 *   By sector:   S.11 (2700−1650) + S.13 (500−200)   = 1350
 *   GDP = 1350 + 320 − 70 = 1600
 *
 * The two cuts agree, so the coverage check stays silent and any warning in
 * the interface is a real defect. Government is the one non-corporate
 * producer, which is what makes the sector cut say something the industry cut
 * does not.
 */
export function sectorProductionCsv(periodLabel: string): string {
  return [
    'txn,isic,sector,period,value',
    `P.1,C,S.11,${periodLabel},2000`,
    `P.2,C,S.11,${periodLabel},1200`,
    `P.1,F,S.11,${periodLabel},700`,
    `P.2,F,S.11,${periodLabel},450`,
    `P.1,A,S.13,${periodLabel},500`,
    `P.2,A,S.13,${periodLabel},200`,
    `D.21,,,${periodLabel},320`,
    `D.31,,,${periodLabel},70`,
  ].join('\n');
}
