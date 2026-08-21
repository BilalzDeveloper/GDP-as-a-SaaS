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
