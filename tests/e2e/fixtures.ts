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
export async function applyStandardMapping(page: Page): Promise<void> {
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
  await expect(page.getByText(/observations committed/)).toBeVisible();
}
