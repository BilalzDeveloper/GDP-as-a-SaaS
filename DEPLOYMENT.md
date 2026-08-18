# Deployment

Milestone 1 requires a live URL. The code is deployment-ready; the steps below
need accounts and secrets that only the owner holds, so they have to be run
once by you. Everything after step 5 is automatic on each push.

## 1. Create the Supabase project

1. supabase.com → New project (free tier). Pick a region near your users.
2. Save the database password — it goes in `DATABASE_URL`.
3. Project Settings → API: copy the **Project URL** and the **anon public** key.
   Do **not** copy the `service_role` key into anything the app can read
   (PLAN.md, stack challenge 1).

## 2. Apply the migrations

```bash
# The pooled URL from Dashboard → Connect → Transaction pooler
export DATABASE_URL='postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:6543/postgres'
npm run db:migrate
```

Do **not** run `tests/rls/shim.sql` against Supabase — it exists only to fake
the `auth` schema and roles on a plain Postgres for local/CI runs.

Alternatively, with the Supabase CLI linked to the project: `supabase db push`.

## 3. Configure Auth

Authentication → Providers → Email is on by default. Confirm the redirect URLs
under Authentication → URL Configuration once the Vercel URL exists (step 4):
add `https://<app>.vercel.app` as Site URL.

Email confirmation is enabled by default; sign-up then lands on the sign-in
page with a "check your email" notice. Turn it off during early testing if you
prefer immediate sessions.

## 4. Deploy to Vercel

1. vercel.com → Add New → Project → import `BilalzDeveloper/GDP-as-a-SaaS`.
2. Framework preset: Next.js (auto-detected). No build overrides needed.
3. Environment variables (all three, for Production and Preview):

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL from step 1 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key from step 1 |
   | `DATABASE_URL` | **Transaction pooler** URL (port 6543) from step 2 |

   The transaction pooler is required on serverless. The app sets
   `prepare: false` and uses `SET LOCAL` per transaction, which is safe in
   transaction mode. The session pooler (5432) will exhaust connections.

4. Deploy. The live URL is the milestone-1 deliverable.

## 5. Verify the deployment

1. Sign up two accounts with different emails.
2. Create an organization with each.
3. Confirm each account sees only its own organization on `/orgs`, and that
   visiting the other's `/orgs/<slug>` returns 404 — not a permission error.
   (RLS makes "not yours" and "does not exist" indistinguishable on purpose.)
4. As an admin, add the second account to your org by email and confirm the
   role shows in the members table.

## What is deliberately not automated

No deploy secrets live in the repo or in CI. CI (`.github/workflows/ci.yml`)
runs typecheck, the tenant-isolation suite against a throwaway Postgres, and
the production build — but never touches the real database or Vercel. Vercel's
own GitHub integration handles deploys on push.
