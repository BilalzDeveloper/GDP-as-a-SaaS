// The whole walk, in one browser: an empty organization to a published GDP
// figure with its exports.
//
// This is the flow the brief describes as the product — "an NSO uploads source
// data, maps it to standard classifications, and the system computes GDP by
// all three approaches with full audit trails and reproducible vintages" — and
// it is the one flow no unit test can cover, because every step depends on
// state the previous step left in the browser and the database.
//
// Serial by design: these are stages of one story, not independent cases.
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
const adminEmail = `e2e-admin-${id}@nso.test`;
const reviewerEmail = `e2e-reviewer-${id}@nso.test`;
const slug = `e2e-${id}`;
const YEAR = 2023;
const RUN_NAME = 'Annual estimates, first release';

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  // The reviewer needs an account before the admin can add them by email.
  await signUp(page, reviewerEmail);
  await signOut(page);
  await signUp(page, adminEmail);
});

test.afterAll(async () => {
  await page.close();
});

test('an admin creates an organization and is made its admin', async () => {
  await createOrganization(page, `Statistics ${id}`, slug);
  await expect(page.getByRole('cell', { name: adminEmail })).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'manages members and publishes' }),
  ).toBeVisible();
});

test('a new organization can define its own reference periods', async () => {
  // Before this, nothing an upload contains can resolve to a period.
  await page.goto(`/orgs/${slug}/data`);
  await expect(page.getByText('No reference periods defined')).toBeVisible();

  await definePeriods(page, slug, YEAR);
  await expect(page.getByText('No reference periods defined')).toHaveCount(0);
  // Calendar year: one annual period and four quarters.
  const row = page.getByRole('row', { name: new RegExp(`^${YEAR}`) });
  await expect(row).toContainText(`${YEAR}-01-01`);
  await expect(row).toContainText(`${YEAR}-12-31`);
});

test('a source file uploads and keeps its checksum', async () => {
  await uploadCsv(page, slug, 'Annual accounts', 'accounts.csv', annualCsv(String(YEAR)));
  await expect(page.getByText('SHA-256')).toBeVisible();
  await expect(page.getByText('e2e fixture, generated in the test')).toBeVisible();
});

test('columns are mapped and the rows validate cleanly', async () => {
  await applyStandardMapping(page);
  await expect(page.getByText('Ready to commit')).toBeVisible();
  await expect(page.getByText('13 of 13 rows')).toBeVisible();
  // Nothing blocking: the fixture is a consistent set of accounts.
  await expect(page.locator('.pill.is-critical')).toHaveCount(0);
});

test('staged rows commit into a vintage', async () => {
  await commitInto(page, 'first estimate');
  await expect(page.getByText(/13 observations committed/)).toBeVisible();
});

test('a run executes and reports GDP by all three approaches', async () => {
  await page.goto(`/orgs/${slug}/runs`);
  await page.locator('input[name="name"]').fill(RUN_NAME);
  const vintage = page
    .locator('select[name="vintageId"] option')
    .filter({ hasText: 'first estimate' })
    .first();
  await page
    .locator('select[name="vintageId"]')
    .selectOption(await vintage.getAttribute('value'));
  await page.getByRole('button', { name: 'Create run' }).click();

  await expect(page.getByRole('heading', { name: RUN_NAME })).toBeVisible();
  await page.getByRole('button', { name: 'Execute', exact: true }).click();

  // Production 1600, income 1600, headline 1600 — the fixture is consistent,
  // so anything else here is the application getting it wrong.
  const gdpRow = page
    .getByRole('table')
    .first()
    .getByRole('row', { name: new RegExp(`^${YEAR}`) });
  await expect(gdpRow).toContainText('1,600');

  // The expenditure approach has no source data, and is withheld rather than
  // reported as a partial total.
  await expect(gdpRow).toContainText('—');
});

test('the discrepancy between approaches is zero and shown as such', async () => {
  const panel = page.locator('.panel', { hasText: 'Statistical discrepancy' });
  await expect(panel.getByRole('row', { name: new RegExp(`^${YEAR}`) })).toContainText('0');
  await expect(
    page.getByText('Discrepancies are reported, never removed'),
  ).toBeVisible();
});

test('value added is broken down by industry', async () => {
  const panel = page.locator('.panel', { hasText: 'current prices' });
  await expect(panel.getByRole('row', { name: /Manufacturing/ })).toContainText('800');
  await expect(panel.getByRole('row', { name: /Agriculture/ })).toContainText('300');
  await expect(panel.getByRole('row', { name: /Construction/ })).toContainText('250');
});

test('an aggregate drills down to the source records behind it', async () => {
  // The claim the product makes is that any figure traces back to the bytes
  // it came from. This is that claim, exercised.
  await page
    .getByRole('row', { name: /Manufacturing/ })
    .getByRole('link', { name: 'sources' })
    .click();

  const sources = page.locator('.panel', { hasText: 'Transaction' }).last();
  await expect(page.getByRole('heading', { name: /Source records/ })).toBeVisible();
  await expect(sources.getByRole('row', { name: /P\.1/ })).toContainText('2,000');
  await expect(sources.getByRole('row', { name: /P\.2/ })).toContainText('1,200');
  await expect(sources).toContainText('accounts.csv');
  await page.getByRole('link', { name: 'Close drill-down' }).click();
});

test('a run cannot be reviewed by the person who created it', async () => {
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Under review')).toBeVisible();
  // Separation of duties: the admin can review in general, but not this run.
  await expect(page.getByText('You created this run, so you cannot review it')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record decision' })).toHaveCount(0);
});

test('a second person is added as reviewer and approves it', async () => {
  await page.goto(`/orgs/${slug}`);
  await page.locator('input[name="email"]').fill(reviewerEmail);
  await page.locator('select[name="role"]').selectOption('reviewer');
  await page.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByRole('cell', { name: reviewerEmail })).toBeVisible();

  await signOut(page);
  await signIn(page, reviewerEmail);
  await page.goto(`/orgs/${slug}/runs`);
  await page.getByRole('link', { name: RUN_NAME }).click();

  await page.locator('select[name="decision"]').selectOption('approved');
  await page
    .locator('input[name="note"]')
    .fill('Checked the industry breakdown against the source file. Agrees.');
  await page.getByRole('button', { name: 'Record decision' }).click();

  await expect(page.locator('.pill.is-positive', { hasText: 'approved' }).first()).toBeVisible();
  // A reviewer is not an admin, so publication is not theirs to do.
  await expect(page.getByText('Approved. An admin can publish it.')).toBeVisible();
});

test('approval freezes the vintage the run read', async () => {
  await page.goto(`/orgs/${slug}/runs`);
  await expect(
    page.getByRole('row', { name: new RegExp(RUN_NAME) }).locator('.pill', { hasText: 'frozen' }),
  ).toBeVisible();
});

test('the admin publishes it under embargo', async () => {
  await signOut(page);
  await signIn(page, adminEmail);
  await page.goto(`/orgs/${slug}/runs`);
  await page.getByRole('link', { name: RUN_NAME }).click();

  // An hour out, so the embargo is live while the test looks at it.
  const release = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);
  await page.locator('input[name="embargoUntil"]').fill(release);
  await page.getByRole('button', { name: 'Publish' }).click();

  await expect(page.getByText(/Embargoed until/)).toBeVisible();
  await expect(
    page.getByText('The embargo governs release to anyone else'),
  ).toBeVisible();
});

test('the SDMX-CSV export carries the figures and the embargo stamp', async () => {
  const link = page.getByRole('link', { name: 'Export SDMX-CSV' });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');

  // page.request shares the browser context's cookies, so this is fetched as
  // the signed-in admin — an anonymous fetch would (correctly) get nothing.
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  const body = await response.text();

  // The leading comment is deliberately not valid SDMX-CSV, so a strict
  // parser rejects an embargoed extract rather than loading it silently.
  expect(body.split('\n')[0]).toMatch(/^#EMBARGOED UNTIL .* NOT FOR RELEASE/);
  expect(body).toContain('BENCHMARKED');
  expect(body).toContain('headline_gdp');
  expect(body).toContain('1600');
});

test('the Excel export downloads as a real workbook', async () => {
  const href = await page.getByRole('link', { name: 'Export Excel' }).getAttribute('href');
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  const body = await response.body();
  // A zip container, which is what xlsx is — checked by its magic number
  // rather than by trusting the file extension.
  expect(body.subarray(0, 2).toString('binary')).toBe('PK');
  expect(body.byteLength).toBeGreaterThan(1000);
});

test('the figures are reproducible: re-executing gives the same GDP', async () => {
  await page.getByRole('button', { name: 'Re-execute' }).click();
  const gdpRow = page
    .getByRole('table')
    .first()
    .getByRole('row', { name: new RegExp(`^${YEAR}`) });
  await expect(gdpRow).toContainText('1,600');
});
