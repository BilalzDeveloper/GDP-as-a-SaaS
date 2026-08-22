// Getting in, and being kept out.
//
// The middleware gate and the sign-in flow are the first things a user meets
// and the last things anyone thinks to test. Everything here goes through the
// browser, so a session cookie that fails to round-trip shows up as a failed
// redirect rather than as a passing unit test.
import { expect, test } from '@playwright/test';
import { PASSWORD, runId, signIn, signOut, signUp } from './fixtures';

test.describe('the front door', () => {
  test('sends a signed-out visitor from a tenant page to sign-in', async ({ page }) => {
    await page.goto('/orgs');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('guards a deep tenant URL, not just the index', async ({ page }) => {
    await page.goto('/orgs/some-organization/runs');
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('shows the landing page to a signed-out visitor', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Compile GDP under SNA 2008' }),
    ).toBeVisible();
    // The three non-negotiables the brief names are what the page promises.
    await expect(page.getByText('Reproducible.')).toBeVisible();
    await expect(page.getByText('Auditable.')).toBeVisible();
    await expect(page.getByText('Isolated.')).toBeVisible();
  });
});

test.describe('registering and signing in', () => {
  test('a new account can register, sign out and sign back in', async ({ page }) => {
    const email = `e2e-access-${runId()}@nso.test`;

    await signUp(page, email);
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // A brand-new account belongs to nothing, and is told what to do about it.
    await expect(
      page.getByText('You are not a member of any organization yet'),
    ).toBeVisible();

    await signOut(page);
    await page.goto('/orgs');
    await expect(page).toHaveURL(/\/sign-in$/);

    await signIn(page, email);
    await expect(page.getByText(email)).toBeVisible();
  });

  test('refuses a wrong password and says so on the form', async ({ page }) => {
    const email = `e2e-wrong-${runId()}@nso.test`;
    await signUp(page, email);
    await signOut(page);

    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/sign-in\?error=/);
    await expect(page.locator('.callout.is-critical')).toContainText(/Invalid login/i);
    // And it did not let them in.
    await page.goto('/orgs');
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('rejects a password below the minimum length before calling out', async ({ page }) => {
    await page.goto('/sign-up');
    // The field's own minlength would block submission, so the server-side
    // check is what is under test here — remove the attribute and submit.
    await page.getByLabel('Email').fill(`e2e-short-${runId()}@nso.test`);
    await page.getByLabel('Password').fill('short');
    await page
      .getByLabel('Password')
      .evaluate((el: HTMLInputElement) => el.removeAttribute('minlength'));
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.locator('.callout.is-critical')).toContainText(
      'Password must be at least 8 characters',
    );
  });

  test('tells an unconfirmed account to check its email', async ({ page }) => {
    // With email confirmation enabled — the Supabase default — sign-up returns
    // no session. The auth stub reproduces that for this address prefix so the
    // branch is covered; see tests/e2e/auth-stub.mjs.
    await page.goto('/sign-up');
    await page.getByLabel('Email').fill(`needs-confirm-${runId()}@nso.test`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/sign-in\?notice=/);
    await expect(page.locator('.callout.is-note')).toContainText(
      'Check your email to confirm your account',
    );
  });
});

test.describe('the user guide', () => {
  test('is reachable without an account', async ({ page }) => {
    // Someone evaluating the platform, or a compiler stuck on a validation
    // message at the sign-in screen, should not have to log in to read it.
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: 'User guide', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/help$/);
  });

  test('is one click from anywhere, signed out', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Help' }).click();
    await expect(page.getByRole('heading', { name: 'User guide', level: 1 })).toBeVisible();
  });

  test('its contents jump to the sections they name', async ({ page }) => {
    await page.goto('/help');
    await page.getByRole('link', { name: 'Institutional sectors' }).first().click();
    await expect(page).toHaveURL(/#sectors$/);
    await expect(
      page.getByRole('heading', { name: 'Institutional sectors', level: 2 }),
    ).toBeVisible();
  });

  test('documents the codes a compiler has to get right', async ({ page }) => {
    // The guide is only worth having if it is accurate, and these are the
    // parts the application will refuse over. If a code is renamed and this
    // fails, the guide needed updating with it.
    await page.goto('/help');
    for (const code of ['P.31', 'P.32', 'D.21', 'POP', 'FISIM.P2', 'IMPRENT.P1']) {
      await expect(page.getByText(code, { exact: true }).first()).toBeVisible();
    }
  });

  test('offers no way in that a signed-out visitor does not have', async ({ page }) => {
    // The guide is public, so it must hold nothing tenant-specific: no
    // organization names, no figures, and no sign-out for someone with no
    // session.
    await page.goto('/help');
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  });
});

test.describe('appearance', () => {
  const root = (page: import('@playwright/test').Page) =>
    page.locator('html');

  test('defaults to the base skin following the system', async ({ page }) => {
    // No attributes at all: the bare `:root` palette, and `color-scheme:
    // light dark` so the reader's operating system decides the mode.
    await page.goto('/appearance');
    await expect(root(page)).not.toHaveAttribute('data-skin', /./);
    await expect(root(page)).not.toHaveAttribute('data-theme', /./);
  });

  test('a chosen skin is stamped on the document, not applied by script',
    async ({ page }) => {
      await page.goto('/appearance');
      await page.locator('input[name="skin"][value="parchment"]').check();
      await page.locator('input[name="mode"][value="dark"]').check();
      await page.getByRole('button', { name: 'Save appearance' }).click();

      await expect(page.getByText('Saved')).toBeVisible();
      await expect(root(page)).toHaveAttribute('data-skin', 'parchment');
      await expect(root(page)).toHaveAttribute('data-theme', 'dark');
    });

  test('the choice follows the reader to every page and survives a reload',
    async ({ page }) => {
      await page.goto('/appearance');
      await page.locator('input[name="skin"][value="contrast"]').check();
      await page.getByRole('button', { name: 'Save appearance' }).click();
      await expect(page.getByText('Saved')).toBeVisible();

      await page.goto('/help');
      await expect(root(page)).toHaveAttribute('data-skin', 'contrast');
      await page.reload();
      await expect(root(page)).toHaveAttribute('data-skin', 'contrast');
      // And on a page behind the sign-in wall's redirect, too.
      await page.goto('/sign-in');
      await expect(root(page)).toHaveAttribute('data-skin', 'contrast');
    });

  test('a tampered cookie falls back to the default rather than breaking',
    async ({ page, context }) => {
      // The value is reader-supplied text. It is validated on read, so the
      // worst a bad one can do is nothing.
      await context.addCookies([
        { name: 'skin', value: 'not-a-skin', url: 'http://127.0.0.1:3211' },
        { name: 'mode', value: '"><script>', url: 'http://127.0.0.1:3211' },
      ]);
      await page.goto('/help');
      await expect(root(page)).not.toHaveAttribute('data-skin', /./);
      await expect(root(page)).not.toHaveAttribute('data-theme', /./);
      await expect(page.getByRole('heading', { name: 'User guide' })).toBeVisible();
    });

  test('changes the palette and nothing else', async ({ page }) => {
    // A skin must not move a control or change a word: two people discussing
    // a figure over the phone have to be looking at the same page.
    await page.goto('/help');
    const before = await page.locator('main').innerText();

    await page.goto('/appearance');
    await page.locator('input[name="skin"][value="ink"]').check();
    await page.getByRole('button', { name: 'Save appearance' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    await page.goto('/help');
    expect(await page.locator('main').innerText()).toBe(before);
  });

  test('offers every skin the stylesheet defines', async ({ page }) => {
    await page.goto('/appearance');
    for (const skin of ['ledger', 'slate', 'parchment', 'contrast', 'ink']) {
      await expect(page.locator(`input[name="skin"][value="${skin}"]`)).toHaveCount(1);
    }
  });
});

test.describe('insights', () => {
  test('needs an account, like every other tenant-aware page', async ({ page }) => {
    await page.goto('/insights');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('ranks the economies and the GCC, and says the figures are indicative',
    async ({ page }) => {
      await signUp(page, `insights-${runId()}@nso.test`);
      await page.goto('/insights');

      // The honesty notice is the first thing on the page while the seeded
      // transcription is in force. If this disappears without the official
      // loader having run, the page is lying.
      await expect(
        page.getByText('These figures are indicative, not official'),
      ).toBeVisible();

      const gcc = page.locator('.panel', { hasText: 'GCC member states' });
      for (const state of ['Saudi Arabia', 'United Arab Emirates', 'Qatar',
                           'Kuwait', 'Oman', 'Bahrain']) {
        await expect(gcc.getByRole('row', { name: new RegExp(state) })).toHaveCount(1);
      }

      const world = page.locator('.panel', { hasText: 'Ranked by nominal GDP' });
      const first = world.locator('tbody tr').first();
      await expect(first).toContainText('United States');
      await expect(world.locator('tbody tr')).toHaveCount(20);
    });

  test('shows growth, which needs more than one period', async ({ page }) => {
    await signUp(page, `insights-growth-${runId()}@nso.test`);
    await page.goto('/insights');
    const world = page.locator('.panel', { hasText: 'Ranked by nominal GDP' });
    // Saudi Arabia fell in dollar terms in 2023 on lower oil; the sign has to
    // survive the round trip, because a growth column that cannot show a
    // negative is worse than none.
    await expect(world.getByRole('row', { name: /Saudi Arabia/ })).toContainText('-');
    await expect(world.getByRole('row', { name: /United States/ })).toContainText('+');
  });

  test('splits the GCC between oil and everything else', async ({ page }) => {
    await signUp(page, `insights-oil-${runId()}@nso.test`);
    await page.goto('/insights');
    const oil = page.locator('.panel', { hasText: 'Value added at basic prices' });
    await expect(oil).toBeVisible();
    // Ranked by oil share, so the most and least diversified are the ends.
    const first = oil.locator('tbody tr').first();
    const last = oil.locator('tbody tr').last();
    await expect(first).toContainText('Kuwait');
    await expect(last).toContainText('Bahrain');
    // Two series, so a legend, and it is not colour alone.
    await expect(oil.getByText('Oil', { exact: true })).toBeVisible();
    await expect(oil.getByText('Rest of the economy')).toBeVisible();
    // The figures are value added, and the page must not invite a subtraction
    // from GDP at market prices.
    await expect(page.getByText(/sum to gross value added, not to GDP/)).toBeVisible();
  });

  test('a country page puts the benchmark beside your own compilations',
    async ({ page }) => {
      await signUp(page, `insights-country-${runId()}@nso.test`);
      await page.goto('/insights/SAU');
      await expect(page.getByRole('heading', { name: 'Saudi Arabia' })).toBeVisible();
      await expect(page.locator('.hero-figure')).toContainText('tn');

      // A fresh account has published nothing, and the page says so rather
      // than showing an empty table.
      await expect(page.getByText(/No run of yours has been published/)).toBeVisible();

      // The series, and exactly one hero figure on the page — a second at the
      // same size competes with the first.
      const series = page.locator('.panel', { hasText: 'Relative size' });
      await expect(series.locator('tbody tr')).toHaveCount(3);
      await expect(page.locator('.hero-figure')).toHaveCount(1);
      // Saudi Arabia publishes an oil split, so the stat is there too.
      await expect(page.locator('.stat-figure')).toContainText('%');
    });

  test('an unknown country is a 404, not an empty page', async ({ page }) => {
    await signUp(page, `insights-404-${runId()}@nso.test`);
    const response = await page.goto('/insights/ZZZ');
    expect(response?.status()).toBe(404);
  });

  test('reaches the same figures from any skin', async ({ page }) => {
    // The rankings are drawn with the skin's accent; a skin must not change
    // what they say.
    await signUp(page, `insights-skin-${runId()}@nso.test`);
    await page.goto('/insights');
    const before = await page.locator('.ranking').first().innerText();

    await page.goto('/appearance');
    await page.locator('input[name="skin"][value="contrast"]').check();
    await page.getByRole('button', { name: 'Save appearance' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    await page.goto('/insights');
    expect(await page.locator('.ranking').first().innerText()).toBe(before);
  });
});
