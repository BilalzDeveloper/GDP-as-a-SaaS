# End-to-end tests

The brief's stack section asks for "Vitest for the calculation engine,
Playwright for critical user flows". Vitest has covered the engine and the
database since milestone 3. This is the other half.

```bash
bash scripts/test-db.sh              # Postgres with every migration applied
export DATABASE_URL=postgresql://postgres:postgres@localhost:54329/gdp_test
npm run db:seed                      # reference data the flows need
npm run build                        # the suite runs against a production build
npm run test:e2e
```

`npm run test:e2e:ui` opens Playwright's interactive runner. Both start the
web server and the auth stub themselves.

## What is real, and what is not

Real: the Next.js production build, every server action, the middleware, the
Postgres with all eight migrations, every RLS policy, the calculation engine,
the exporters. A test signs up, uploads a file, maps its columns, commits,
compiles, reviews, publishes and downloads — through the interface, in a
browser.

Not real: the identity provider. `supabase.auth.getUser()` revalidates the JWT
against Supabase's hosted Auth service on every request — deliberately, and
the middleware says so — which means a browser-level test needs either a live
Supabase project or a local stand-in. `tests/e2e/auth-stub.mjs` is that stand-in:
it speaks enough of the GoTrue HTTP API to issue a session, return the user for
a bearer token, and sign out, writing its users into the same `auth.users`
table every foreign key points at.

So the suite does **not** cover password strength policy, rate limiting, email
delivery, OAuth or MFA. Those belong to Supabase Auth and behave as the project
configures them. It covers everything the application does once it has an
identity.

When the deployment exists, point `NEXT_PUBLIC_SUPABASE_URL` at the real
project and these specs run unchanged. The stub is a fixture, not an
abstraction the application knows about. Recorded as D38.

## The three specs

**`access.spec.ts`** — the front door. A signed-out visitor is redirected from
any tenant URL, deep ones included. An account registers, signs out, signs back
in. A wrong password is refused and says so. A password below the minimum is
rejected server-side, not only by the input's `minlength`. An unconfirmed
account is told to check its email.

**`compile.spec.ts`** — the whole walk, serially, in one browser: create an
organization, define its reference periods, upload a CSV, map its columns,
validate, commit into a vintage, create a run, execute it, read GDP by all
three approaches, see the discrepancy, drill from Manufacturing's value added
down to the P.1 and P.2 rows of the source file, submit for review, be refused
because you compiled it yourself, add a reviewer, approve, watch the vintage
freeze, publish under embargo, and download both exports.

The fixture is a small internally consistent economy where production and
income both give GDP = 1600, so any other figure on screen is the application
getting it wrong rather than the fixture being loose.

**`isolation.spec.ts`** — non-negotiable 3, from the browser.
`tests/rls/isolation.test.ts` proves the policies hold against direct SQL; this
proves the application does not undo them. A member of one organization, with
another organization's URLs, gets 404 on the overview, on every section, on a
compiled pre-release run, and on both export endpoints — and a real-but-
forbidden organization renders identically to a made-up one, so the existence
of a tenant does not leak either. The last test is the control: the owner can
still see their own work, because isolation that also blocked the owner would
pass every other test and be useless.

## What writing them found

Both of these were live defects, not test-harness problems. Neither showed up
in the unit tests, because those call the services directly and so skipped the
step where the application decides what to pass them.

**A new organization could not use the product.** Nothing in the interface
created reference periods. The Source data page warned that none were defined
and offered no way to define any, so a compiler who registered could not
process their first upload without someone running SQL for them. Fixed by
`src/intake/periods.ts` and a form on that page (D40).

**Committing used the wrong mapping.** `commitStaged` read the organization's
most recently saved `column_mapping` — whichever dataset it belonged to. Map
dataset A, map dataset B differently, commit A, and A's rows were interpreted
with B's mapping: values under the wrong transaction code, industry or period,
silently. The same code path also made the optional "save this mapping as"
name effectively required, with a message that did not say so. Fixed by
recording the applied mapping on the dataset (migration 0008, D39), which is
where it belonged anyway — the bytes plus the mapping are what produced the
observations, so provenance needs both.

## Conventions

- **Serial, one worker.** These tests share a database and a compilation run
  reads everything a vintage holds; parallel workers would see each other's
  data and the failures would be blamed on the code.
- **Drive the interface, never the database.** A helper that took a shortcut
  would test the shortcut. `tests/e2e/fixtures.ts` clicks and types.
- **Wait for state, not for clicks.** A server action redirects, so anything
  typed immediately after a click can land on the page about to be replaced.
  Helpers wait for the resulting state — Commit becoming enabled, the dataset
  heading appearing — rather than for the click to return.
- **Address selects by `name`.** Playwright folds a wrapped `<select>`'s option
  text into its accessible name, so `getByLabel` is ambiguous for them.
  Text inputs and buttons use roles and labels as normal.
- **Unique identities per run.** Emails and slugs carry a run id, so the suite
  can be re-run against a database it has already used.
