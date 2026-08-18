-- Migration 0001 — Foundations (milestone 1)
-- Tenancy (organization, membership), audit (append-only audit_log with a
-- required reason), and Row-Level Security. Extracted from the approved
-- db/schema-proposal.sql §1–§3 and the tenancy/audit parts of §6.
--
-- Assumes a Supabase project (auth.users, auth.uid(), roles authenticated/
-- anon exist, and the migration role has BYPASSRLS — see DECISIONS.md D7).
-- Local/CI test databases get those preconditions from tests/rls/shim.sql.

create extension if not exists pgcrypto;

-- The SQL-language helper functions reference tables created later in this
-- file; defer body validation to first use (as Supabase's own dumps do).
set check_function_bodies = off;

-- Private schema: RLS helpers and trigger functions. Not exposed via
-- PostgREST; `authenticated` needs USAGE so policy expressions can call the
-- helpers (functions are EXECUTE-able by PUBLIC by default).
create schema if not exists private;
grant usage on schema private to authenticated, anon;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type org_role as enum ('admin', 'compiler', 'reviewer', 'viewer');

-- -----------------------------------------------------------------------------
-- RLS helper functions
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER so membership checks inside membership's own policies do
-- not recurse. LOAD-BEARING: owned by a BYPASSRLS role (Supabase `postgres`,
-- or the superuser applying migrations in tests). See DECISIONS.md D7.

create function private.is_org_member(p_org uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membership m
    where m.org_id = p_org and m.user_id = auth.uid()
  );
$$;

create function private.has_org_role(p_org uuid, variadic p_roles org_role[])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.membership m
    where m.org_id = p_org
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
  );
$$;

-- -----------------------------------------------------------------------------
-- Tenancy
-- -----------------------------------------------------------------------------

create table organization (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null check (length(trim(name)) between 1 and 200),
  slug                    text not null unique
                          check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  -- FK to country arrives with reference data in milestone 2.
  country_code            char(3),
  -- Not every country runs January–December (brief, "Reference periods").
  fiscal_year_start_month smallint not null default 1
                          check (fiscal_year_start_month between 1 and 12),
  created_at              timestamptz not null default now()
);

create table membership (
  org_id     uuid not null references organization (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       org_role not null default 'viewer',
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index membership_user_idx on membership (user_id);

-- -----------------------------------------------------------------------------
-- Audit — non-negotiable 2: who, when, what changed, and why
-- -----------------------------------------------------------------------------

create table audit_log (
  id          bigint generated always as identity primary key,
  org_id      uuid,
  actor_id    uuid,
  occurred_at timestamptz not null default now(),
  table_name  text not null,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  row_pk      text not null,
  old_data    jsonb,
  new_data    jsonb,
  reason      text not null
);

create index audit_log_org_idx on audit_log (org_id, occurred_at desc);

-- The "why": the app sets set_config('app.reason', <text>, true) inside the
-- writing transaction (src/db/rls.ts). Audited writes without it are rejected.
create function private.audit_row()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(current_setting('app.reason', true), '');
  v_row    jsonb := coalesce(to_jsonb(new), to_jsonb(old));
begin
  if v_reason is null then
    raise exception 'audited write to % requires app.reason to be set',
      tg_table_name using errcode = 'P0001';
  end if;
  insert into public.audit_log
    (org_id, actor_id, table_name, action, row_pk, old_data, new_data, reason)
  values (
    -- organization rows ARE the org; every other tenant table carries org_id
    coalesce(
      v_row ->> 'org_id',
      case when tg_table_name = 'organization' then v_row ->> 'id' end
    )::uuid,
    auth.uid(),
    tg_table_name,
    tg_op,
    coalesce(v_row ->> 'id', v_row ->> 'org_id', '?'),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    v_reason
  );
  return coalesce(new, old);
end;
$$;

create function private.reject_change()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function private.reject_change();

create trigger audit_organization
  after insert or update or delete on organization
  for each row execute function private.audit_row();

create trigger audit_membership
  after insert or update or delete on membership
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Organization creation: explicit RPC, creator becomes admin
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER (BYPASSRLS owner) because no membership policy can allow
-- the first row: the creator is not yet a member of anything. Deliberately an
-- RPC rather than an insert policy + AFTER trigger: INSERT ... RETURNING must
-- also pass the SELECT policy, and at RETURNING time a trigger-created
-- membership does not exist yet, so the visibility check fails. The RPC keeps
-- creation atomic and lets us deny direct INSERTs on organization outright.

create function public.create_organization(
  p_name text,
  p_slug text,
  p_fiscal_year_start_month smallint default 1
)
returns public.organization
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org public.organization;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  insert into public.organization (name, slug, fiscal_year_start_month)
  values (p_name, p_slug, p_fiscal_year_start_month)
  returning * into v_org;
  insert into public.membership (org_id, user_id, role)
  values (v_org.id, auth.uid(), 'admin');
  return v_org;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
-- FORCE on every tenant table: even the table owner goes through policies
-- (BYPASSRLS roles excepted — that is the migration/definer role only).
-- RLS sits on top of GRANTs, so both layers are set explicitly.

-- No INSERT grant on organization: creation goes through
-- public.create_organization() only.
grant select, update, delete on organization to authenticated;
grant select, insert, update, delete on membership to authenticated;
grant select on audit_log to authenticated;

alter table organization enable row level security;
alter table organization force row level security;

create policy org_select on organization for select
  using (private.is_org_member(id));
create policy org_update on organization for update
  using (private.has_org_role(id, 'admin'))
  with check (private.has_org_role(id, 'admin'));
create policy org_delete on organization for delete
  using (private.has_org_role(id, 'admin'));

alter table membership enable row level security;
alter table membership force row level security;

create policy membership_select on membership for select
  using (private.is_org_member(org_id));
create policy membership_write on membership for all
  using (private.has_org_role(org_id, 'admin'))
  with check (private.has_org_role(org_id, 'admin'));

alter table audit_log enable row level security;
alter table audit_log force row level security;

-- Members read their org's audit trail. No insert/update/delete policies:
-- rows arrive only via the SECURITY DEFINER trigger, and the append-only
-- trigger blocks changes even for privileged roles.
create policy audit_select on audit_log for select
  using (org_id is not null and private.is_org_member(org_id));

-- -----------------------------------------------------------------------------
-- Member management RPCs
-- -----------------------------------------------------------------------------
-- App roles cannot read auth.users (correctly), so listing members with
-- emails and inviting by email go through narrow SECURITY DEFINER functions
-- that re-check membership/role internally. See DECISIONS.md D9.

create function public.org_members(p_org uuid)
returns table (user_id uuid, email text, role org_role, created_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.membership m
  join auth.users u on u.id = m.user_id
  where m.org_id = p_org
    and private.is_org_member(p_org)
  order by m.created_at;
$$;

create function public.add_member_by_email(p_org uuid, p_email text, p_role org_role)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if not private.has_org_role(p_org, 'admin') then
    raise exception 'only organization admins can add members'
      using errcode = '42501';
  end if;
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then
    raise exception 'no user found with email %', p_email;
  end if;
  insert into public.membership (org_id, user_id, role, invited_by)
  values (p_org, v_user, p_role, auth.uid())
  on conflict (org_id, user_id) do update set role = excluded.role;
end;
$$;

revoke execute on function public.create_organization(text, text, smallint) from public, anon;
revoke execute on function public.org_members(uuid) from public, anon;
revoke execute on function public.add_member_by_email(uuid, text, org_role) from public, anon;
grant execute on function public.create_organization(text, text, smallint) to authenticated;
grant execute on function public.org_members(uuid) to authenticated;
grant execute on function public.add_member_by_email(uuid, text, org_role) to authenticated;
