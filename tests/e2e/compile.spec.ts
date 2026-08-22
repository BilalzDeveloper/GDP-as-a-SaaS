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
  adjustmentsCsv,
  annualCsv,
  sectorExpenditureCsv,
  sectorProductionCsv,
  applyStandardMapping,
  commitInto,
  createOrganization,
  definePeriods,
  populationCsv,
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
const FISIM_RUN_NAME = 'Annual estimates with FISIM';
const SECTOR_RUN_NAME = 'Expenditure by institutional sector';

let page: Page;
/** Set once the run exists, so later tests can come back to it. */
let runUrl: string;
/** The sector-split run, which the drill-down tests come back to. */
let sectorRunUrl: string;

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

test('a population figure uploads as a memorandum item', async () => {
  // Per-capita GDP needs a denominator, and it arrives the same way every
  // other figure does: as an observation, in the same vintage, frozen with it.
  await uploadCsv(page, slug, 'Population', 'population.csv', populationCsv(String(YEAR)));
  await applyStandardMapping(page, 'PERSONS_TH');
  await commitInto(page, 'first estimate');
  await expect(page.getByText(/1 observation committed/)).toBeVisible();
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
  runUrl = page.url();
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

test('the audit trail shows who did what, and why', async () => {
  // Non-negotiable 2 is only discharged if someone can read the record. This
  // is that reading, from the browser: the run being created, executed and
  // published, each entry naming the person and carrying the reason the
  // application recorded at the time.
  await page.goto(`/orgs/${slug}/audit`);
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();

  const rows = page.getByRole('table').getByRole('row');
  await expect(rows.filter({ hasText: 'compilation run' }).first()).toBeVisible();
  await expect(page.getByText(`create compilation run "${RUN_NAME}"`)).toBeVisible();
  await expect(page.getByText(adminEmail).first()).toBeVisible();

  // The status transitions are recorded as changes, old → new.
  await expect(page.getByText('published', { exact: false }).first()).toBeVisible();
});

test('the audit trail filters to one table and stays a citable URL', async () => {
  // An auditor should be able to put the filtered view in a report and come
  // back to it, so the filters are links rather than form state.
  await page.getByRole('link', { name: /^review decision/ }).click();
  await expect(page).toHaveURL(/table=run_review/);

  // Every entry now shown is a review decision and nothing else. Asserted on
  // the rows rather than on page text: the reviewer's note mentions a source
  // file, and matching that would test the fixture instead of the filter.
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasNotText: 'review decision' })).toHaveCount(0);

  // The reviewer's own words, preserved.
  await expect(
    page.getByText('Checked the industry breakdown against the source file'),
  ).toBeVisible();
});

test('a viewer cannot alter the trail', async () => {
  // The append-only guarantee is enforced by a database trigger, not by the
  // absence of a button — tests/rls/isolation.test.ts proves that against
  // direct SQL. What matters here is that the interface offers no way in.
  await expect(page.getByRole('button', { name: /delete|edit|remove/i })).toHaveCount(0);
  await expect(page.getByText('append-only in the database')).toBeVisible();
});

test('GDP per capita is published in units of the currency', async () => {
  // 1600 millions of national currency over 8,000,000 people = 200 per head.
  // Compiled in millions per head it would be 0.0002 and would round away —
  // the point of stating the unit rather than inheriting the accounts'.
  await page.goto(runUrl);
  const panel = page.locator('.panel', { hasText: 'Per capita and growth' });
  await expect(panel.getByRole('row', { name: new RegExp(`^${YEAR}`) })).toContainText(
    '8,000,000',
  );
  await expect(panel.getByRole('row', { name: new RegExp(`^${YEAR}`) })).toContainText(
    '200',
  );
  await expect(page.getByText('memorandum item')).toBeVisible();
});

test('FISIM supplied as data reaches the engine and moves GDP', async () => {
  // The last stretch of the brief's production approach: "Handle FISIM
  // allocation, and imputed rent for owner-occupied dwellings." The engine has
  // done both since milestone 3, but until the FISIM.* codes existed there was
  // no way for a compiler to supply either, so no real compilation could reach
  // that code. This walks the whole path in the browser.
  await uploadCsv(page, slug, 'Accounts with FISIM', 'fisim.csv', adjustmentsCsv(String(YEAR)));
  await applyStandardMapping(page);
  await commitInto(page, 'with FISIM');

  await page.goto(`/orgs/${slug}/runs`);
  await page.locator('input[name="name"]').fill(FISIM_RUN_NAME);
  const vintage = page
    .locator('select[name="vintageId"] option')
    .filter({ hasText: 'with FISIM' })
    .first();
  await page
    .locator('select[name="vintageId"]')
    .selectOption(await vintage.getAttribute('value'));
  await page.locator('select[name="fisimTreatment"]').selectOption('allocated');
  await page.getByRole('button', { name: 'Create run' }).click();

  await expect(page.getByRole('heading', { name: FISIM_RUN_NAME })).toBeVisible();
  await page.getByRole('button', { name: 'Execute', exact: true }).click();

  // 1600 without the adjustment, 1540 with it: the 60 consumed by industry C
  // became intermediate consumption there. The 40 taken as final use stayed
  // in GDP, which is the whole point of allocating FISIM rather than writing
  // all of it off.
  const gdpRow = page
    .getByRole('table')
    .first()
    .getByRole('row', { name: new RegExp(`^${YEAR}`) });
  await expect(gdpRow).toContainText('1,540');

  // The income side was sourced to match, so a correct adjustment leaves the
  // two approaches agreeing. Any slip in the path shows up here first.
  const discrepancy = page.locator('.panel', { hasText: 'Statistical discrepancy' });
  await expect(discrepancy).toContainText('0');

  // And the run says what it was compiled under, because a different
  // treatment is a different figure.
  await expect(page.getByText('allocated')).toBeVisible();
});

test('final consumption is read from the institutional sector that did it', async () => {
  // The brief keys every series on (transaction, activity/product, sector,
  // period, price basis, valuation). The sector was stored on the series and
  // then dropped: the mapping form offered no classification version for it,
  // so a mapped sector column resolved to nothing and blocked the upload, and
  // the assembler never looked at the column anyway.
  await uploadCsv(
    page,
    slug,
    'Expenditure by sector',
    'expenditure-sectors.csv',
    sectorExpenditureCsv(String(YEAR)),
  );
  await applyStandardMapping(page, 'NC_MN', true);
  await commitInto(page, 'by sector');

  await page.goto(`/orgs/${slug}/runs`);
  await page.locator('input[name="name"]').fill(SECTOR_RUN_NAME);
  const vintage = page
    .locator('select[name="vintageId"] option')
    .filter({ hasText: 'by sector' })
    .first();
  await page
    .locator('select[name="vintageId"]')
    .selectOption(await vintage.getAttribute('value'));
  // Expenditure is the only approach this vintage carries, so it must be the
  // anchor for there to be a headline at all.
  await page.locator('select[name="anchor"]').selectOption('expenditure');
  await page.getByRole('button', { name: 'Create run' }).click();

  await expect(page.getByRole('heading', { name: SECTOR_RUN_NAME })).toBeVisible();
  sectorRunUrl = page.url();
  await page.getByRole('button', { name: 'Execute', exact: true }).click();

  // 1700 + 60 + 550 + 600 + 40 + 10 + 700 − 710 = 2950. Each of the three
  // consumption figures reached its own component: were the household lookup
  // still sector-blind it would have swept up all three P.3x rows and given
  // 2310 for households alone.
  const gdpRow = page
    .getByRole('table')
    .first()
    .getByRole('row', { name: new RegExp(`^${YEAR}`) });
  await expect(gdpRow).toContainText('2,950');
});

test('a component drills down to source records no code alone would find', async () => {
  // Final consumption is assembled across institutional sectors and across
  // three transaction codes (D46), so "which rows made this figure" cannot be
  // answered from the code on the row. The run records what it summed, and
  // this reads that record back through the interface.
  await page.goto(sectorRunUrl);
  const componentRow = page
    .locator('.panel', { hasText: 'Components' })
    .first()
    .getByRole('row', { name: /Final consumption expenditure/ });
  await expect(componentRow).toContainText('2,310'); // 1700 + 60 + 550
  await componentRow.getByRole('link', { name: 'sources' }).click();

  await expect(
    page.getByRole('heading', { name: /Source records — Final consumption/ }),
  ).toBeVisible();
  // Scoped by the source table's own column header: filtering panels on the
  // word "Transaction" also catches any diagnostic that happens to use it.
  const sources = page
    .locator('.panel')
    .filter({
      // exact, because a string name is a case-insensitive SUBSTRING match by
      // default and the sector panel's "Institutional sector" header matches
      // "Sector" too.
      has: page.getByRole('columnheader', { name: 'Sector', exact: true }),
    });
  // All three sectors, on two different codes, in one figure.
  await expect(sources.getByRole('row', { name: /S\.14/ })).toContainText('1,700');
  await expect(sources.getByRole('row', { name: /S\.15/ })).toContainText('60');
  await expect(sources.getByRole('row', { name: /S\.13/ })).toContainText('550');
  await expect(sources).toContainText('expenditure-sectors.csv');
  await page.getByRole('link', { name: 'Close drill-down' }).click();
});

test('a derived figure offers no drill-down rather than an empty one', async () => {
  // Per-capita GDP and the growth rates are computed from other results, not
  // from observations. There is nothing to show, and saying so by omitting
  // the link is better than a link to an empty table.
  await page.goto(runUrl);
  const perCapita = page.locator('.panel', { hasText: 'Per capita and growth' });
  await expect(perCapita.getByRole('link', { name: 'sources' })).toHaveCount(0);
});

test('value added is also cut by institutional sector', async () => {
  // SNA 2008 ch.4: the same producers, grouped by what kind of unit they are
  // rather than by what they make. General government value added is a table
  // most offices publish and the industry cut cannot give.
  await uploadCsv(
    page,
    slug,
    'Production by sector',
    'production-sectors.csv',
    sectorProductionCsv(String(YEAR)),
  );
  await applyStandardMapping(page, 'NC_MN', true);
  await commitInto(page, 'production by sector');

  await page.goto(`/orgs/${slug}/runs`);
  await page.locator('input[name="name"]').fill('Value added by sector');
  const vintage = page
    .locator('select[name="vintageId"] option')
    .filter({ hasText: 'production by sector' })
    .first();
  await page
    .locator('select[name="vintageId"]')
    .selectOption(await vintage.getAttribute('value'));
  await page.getByRole('button', { name: 'Create run' }).click();
  await expect(page.getByRole('heading', { name: 'Value added by sector' })).toBeVisible();
  const sectorRunUrl = page.url();
  await page.getByRole('button', { name: 'Execute', exact: true }).click();

  // GDP is unchanged by the second cut — it is a view, not a second total.
  const gdpRow = page
    .getByRole('table')
    .first()
    .getByRole('row', { name: new RegExp(`^${YEAR}`) });
  await expect(gdpRow).toContainText('1,600');

  const sectors = page.locator('.panel', { hasText: 'Institutional sector' });
  // S.11 non-financial corporations: (2000−1200) + (700−450) = 1050.
  await expect(sectors.getByRole('row', { name: /S\.11/ })).toContainText('1,050');
  // S.13 general government: 500 − 200 = 300. The industry cut cannot say this.
  await expect(sectors.getByRole('row', { name: /S\.13/ })).toContainText('300');

  // The two cuts agree, so no coverage warning.
  await expect(page.getByText(/covers only part of the economy/)).toHaveCount(0);

  // And a sector figure traces back to its own rows, not the industry's.
  await sectors
    .getByRole('row', { name: /S\.13/ })
    .getByRole('link', { name: 'sources' })
    .click();
  await expect(
    page.getByRole('heading', { name: /Source records — Value added by sector/ }),
  ).toBeVisible();
  const sources = page
    .locator('.panel')
    .filter({
      // exact, because a string name is a case-insensitive SUBSTRING match by
      // default and the sector panel's "Institutional sector" header matches
      // "Sector" too.
      has: page.getByRole('columnheader', { name: 'Sector', exact: true }),
    });
  await expect(sources.getByRole('row', { name: /P\.1/ })).toContainText('500');
  await expect(sources.getByRole('row', { name: /P\.2/ })).toContainText('200');
  // Only the government rows: the corporate producers belong to another cell.
  await expect(sources.getByRole('row', { name: /S\.11/ })).toHaveCount(0);
  await page.goto(sectorRunUrl);
});
