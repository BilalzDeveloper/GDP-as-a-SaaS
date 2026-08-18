-- Test-only shim: recreates the Supabase preconditions our migrations assume
-- (auth schema, auth.users, auth.uid(), the anon/authenticated roles) on a
-- plain Postgres so the RLS suite runs in CI and locally without Docker.
-- NEVER apply this to a real Supabase project — there it already exists.

create extension if not exists pgcrypto;

create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- Mirrors Supabase's auth.uid(): sub claim from the request JWT settings.
create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

do $$
begin
  begin
    create role anon nologin;
  exception when duplicate_object then null;
  end;
  begin
    create role authenticated nologin;
  exception when duplicate_object then null;
  end;
  begin
    create role service_role nologin bypassrls;
  exception when duplicate_object then null;
  end;
end;
$$;

grant usage on schema public to anon, authenticated;
grant usage on schema auth to authenticated;
