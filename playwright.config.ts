// Playwright drives the critical user flows end to end, as the brief's stack
// section asks for. Vitest covers the calculation engine and the database;
// this covers the paths a person actually walks.
//
// What is real here: the Next.js production build, every server action, the
// Postgres with all seven migrations and every RLS policy. The only stand-in
// is the identity provider — see `tests/e2e/auth-stub.mjs` for why, and for
// what that means the suite does not cover.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3211);
const AUTH_STUB_PORT = Number(process.env.AUTH_STUB_PORT ?? 54330);
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:54329/gdp_test';

export const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * This image ships Chromium under PLAYWRIGHT_BROWSERS_PATH at a build number
 * that need not match the installed @playwright/test. Point at the binary
 * rather than downloading another copy.
 */
const executablePath = process.env.PLAYWRIGHT_BROWSERS_PATH
  ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium`
  : undefined;

export default defineConfig({
  testDir: './tests/e2e',
  // Compilation runs and file uploads are not fast; the default 30s is tight.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Serial. These tests share one database, and a compilation run reads
  // everything a vintage holds — parallel workers would see each other's data
  // and the failures would be blamed on the code rather than the harness.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node tests/e2e/auth-stub.mjs`,
      url: `http://localhost:${AUTH_STUB_PORT}/auth/v1/settings`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { DATABASE_URL, AUTH_STUB_PORT: String(AUTH_STUB_PORT) },
    },
    {
      command: `npx next start -p ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DATABASE_URL,
        NEXT_PUBLIC_SUPABASE_URL: `http://localhost:${AUTH_STUB_PORT}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'e2e-anon-key',
      },
    },
  ],
});
