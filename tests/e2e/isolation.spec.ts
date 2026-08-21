// Tenant isolation, from the browser.
//
// `tests/rls/isolation.test.ts` proves the policies hold against direct SQL.
// This proves the application does not undo them: that a signed-in member of
// one organization, typing another organization's URL into the address bar,
// gets nothing — and that "nothing" is indistinguishable from "no such
// organization", so the existence of a tenant does not leak either.
//
// Non-negotiable 3 calls cross-tenant leakage a catastrophic failure rather
// than a bug. It is worth testing at both layers.
import { expect, test, type Page } from '@playwright/test';
import {
  annualCsv,
  applyStandardMapping,
  commitInto,
  createOrganization,
  definePeriods,
  runId,
  signIn,
  signOut,
  signUp,
  uploadCsv,
} from './fixtures';

test.describe.configure({ mode: 'serial' });

const id = runId();
const insiderEmail = `e2e-insider-${id}@nso.test`;
const outsiderEmail = `e2e-outsider-${id}@other.test`;
const insiderSlug = `e2e-inside-${id}`;
const outsiderSlug = `e2e-outside-${id}`;
const SECRET_RUN = 'Pre-release estimate, embargoed';

let page: Page;
let runUrl: string;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();

  // The insider builds an organization with a compiled, unpublished run in it.
  await signUp(page, insiderEmail);
  await createOrganization(page, `Inside ${id}`, insiderSlug);
  await definePeriods(page, insiderSlug, 2023, 'annual');
  await uploadCsv(page, insiderSlug, 'Confidential accounts', 'secret.csv', annualCsv('2023'));
  await applyStandardMapping(page);
  await commitInto(page, 'pre-release');

  await page.goto(`/orgs/${insiderSlug}/runs`);
  await page.locator('input[name="name"]').fill(SECRET_RUN);
  const vintage = page
    .locator('select[name="vintageId"] option')
    .filter({ hasText: 'pre-release' })
    .first();
  await page.locator('select[name="vintageId"]').selectOption(await vintage.getAttribute('value'));
  await page.getByRole('button', { name: 'Create run' }).click();
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.getByText('1,600').first()).toBeVisible();
  runUrl = page.url();

  // The outsider has their own organization and no connection to the first.
  await signOut(page);
  await signUp(page, outsiderEmail);
  await createOrganization(page, `Outside ${id}`, outsiderSlug);
});

test.afterAll(async () => {
  await page.close();
});

test('an outsider’s organization list shows only their own', async () => {
  await page.goto('/orgs');
  await expect(page.getByRole('link', { name: `Outside ${id}` })).toBeVisible();
  await expect(page.getByRole('link', { name: `Inside ${id}` })).toHaveCount(0);
  await expect(page.getByText(insiderSlug)).toHaveCount(0);
});

test('a known organization URL is a 404 to an outsider', async () => {
  const response = await page.goto(`/orgs/${insiderSlug}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText(`Inside ${id}`)).toHaveCount(0);
});

test('a nonexistent organization looks exactly the same', async () => {
  // Deliberately indistinguishable. If a real-but-forbidden organization gave
  // a 403 and a made-up one gave a 404, an outsider could enumerate which
  // statistical offices use the platform.
  const forbidden = await page.goto(`/orgs/${insiderSlug}`);
  const forbiddenText = await page.locator('body').innerText();
  const missing = await page.goto(`/orgs/no-such-organization-${id}`);
  const missingText = await page.locator('body').innerText();

  expect(missing?.status()).toBe(forbidden?.status());
  // What the visitor sees is identical. (The framework echoes the requested
  // path back inside its serialised payload, which is the URL they typed
  // rather than anything about the organization, so the comparison is of what
  // is rendered.)
  expect(missingText).toBe(forbiddenText);
  expect(forbiddenText).toContain('This page could not be found');
});

test('every section of another tenant is closed, not just the overview', async () => {
  for (const section of ['classifications', 'data', 'runs', 'audit']) {
    const response = await page.goto(`/orgs/${insiderSlug}/${section}`);
    expect(response?.status(), `/${section} was reachable`).toBe(404);
  }
});

test('a pre-release run is not readable by its direct URL', async () => {
  // The market-sensitive case the brief names: a figure that exists, is
  // compiled, and has not been published.
  const response = await page.goto(runUrl);
  expect(response?.status()).toBe(404);
  const body = await page.textContent('body');
  expect(body).not.toContain(SECRET_RUN);
  expect(body).not.toContain('1,600');
});

test('the export endpoints do not hand out another tenant’s figures', async () => {
  // Exports read through the same RLS path as the pages. Checked directly,
  // because a route handler is easy to write without that path.
  for (const format of ['sdmx-csv', 'xlsx']) {
    const response = await page.request.get(`${runUrl}/export/${format}`);
    expect(response.status(), `${format} export leaked`).toBe(404);
    const body = await response.text();
    expect(body).not.toContain('1600');
  }
});

test('a signed-out visitor gets nothing either', async () => {
  await signOut(page);
  const response = await page.goto(runUrl);
  // Redirected to sign-in by the middleware rather than shown the figures.
  expect(page.url()).toContain('/sign-in');
  expect(await page.textContent('body')).not.toContain(SECRET_RUN);
  void response;
});

test('the insider can still see their own work', async () => {
  // The control case. Isolation that also blocked the owner would pass every
  // test above and be useless.
  await signIn(page, insiderEmail);
  const response = await page.goto(runUrl);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: SECRET_RUN })).toBeVisible();
  await expect(page.getByText('1,600').first()).toBeVisible();
});
