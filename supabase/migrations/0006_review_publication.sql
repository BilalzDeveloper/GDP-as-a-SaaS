-- Migration 0006 — Review and publication (milestone 7)
--
-- The path a figure takes from computed to published:
--
--   computed → under_review → approved → published
--                    ↓
--              (changes requested, back to computed)
--
-- Every transition is a SECURITY DEFINER RPC rather than a bare UPDATE,
-- because each one carries a rule that a policy alone cannot express: who may
-- make it, what state the run must be in, and what must be true of the
-- vintage. Roles were reserved for exactly this in milestone 1 —
-- `reviewer` has had no power until now.

set check_function_bodies = off;

create type review_decision as enum ('approved', 'changes_requested');

alter table compilation_run
  add column published_at timestamptz,
  add column embargo_until timestamptz;

comment on column compilation_run.embargo_until is
  'Release time for this run''s figures. Organization members can see them '
  'before this; the embargo governs release to anyone else, and exports are '
  'stamped until it passes.';


create table run_review (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organization (id) on delete cascade,
  run_id      uuid not null references compilation_run (id) on delete cascade,
  reviewer_id uuid references auth.users (id),
  decision    review_decision not null,
  /* A reviewer must say something. An approval with no reasoning is not a
     record anyone can audit later. */
  note        text not null check (length(trim(note)) > 0),
  decided_at  timestamptz not null default now()
);

create index run_review_run_idx on run_review (run_id, decided_at desc);

grant select, insert on run_review to authenticated;
alter table run_review enable row level security;
alter table run_review force row level security;

create policy run_review_select on run_review for select
  using (private.is_org_member(org_id));
-- Rows arrive only through the review RPCs, which check the reviewer role;
-- no direct insert policy.

create trigger audit_run_review
  after insert or update or delete on run_review
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Transitions
-- -----------------------------------------------------------------------------

/**
 * Submit a computed run for review. Compilers and admins may submit; a run
 * must actually have results to be worth reviewing.
 */
create function public.submit_run_for_review(p_run uuid, p_note text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_status public.run_status;
  v_results integer;
begin
  select org_id, status into v_org, v_status
    from public.compilation_run where id = p_run;
  if v_org is null then
    raise exception 'no such compilation run' using errcode = 'P0002';
  end if;
  if not private.has_org_role(v_org, 'admin', 'compiler') then
    raise exception 'only compilers and admins can submit a run for review'
      using errcode = '42501';
  end if;
  if v_status <> 'computed' then
    raise exception 'only a computed run can be submitted for review (this one is %)',
      v_status using errcode = 'P0001';
  end if;
  select count(*) into v_results from public.compilation_result where run_id = p_run;
  if v_results = 0 then
    raise exception 'this run has no results to review' using errcode = 'P0001';
  end if;

  update public.compilation_run set status = 'under_review' where id = p_run;
end;
$$;

/**
 * Record a reviewer's decision.
 *
 * Approving FREEZES the input vintage. That is the point of approval: from
 * here the figures cannot move, so what was reviewed is what gets published
 * (non-negotiable 1). Requesting changes sends the run back to `computed` so
 * a compiler can re-execute.
 *
 * A reviewer cannot approve their own work — separation of duties is the
 * reason the role exists, and an NSO answering to a parliament needs it to be
 * more than a convention.
 */
create function public.review_run(
  p_run      uuid,
  p_decision review_decision,
  p_note     text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_status  public.run_status;
  v_vintage uuid;
  v_author  uuid;
begin
  select org_id, status, input_vintage_id, created_by
    into v_org, v_status, v_vintage, v_author
    from public.compilation_run where id = p_run;
  if v_org is null then
    raise exception 'no such compilation run' using errcode = 'P0002';
  end if;
  if not private.has_org_role(v_org, 'admin', 'reviewer') then
    raise exception 'only reviewers and admins can review a run'
      using errcode = '42501';
  end if;
  if v_status <> 'under_review' then
    raise exception 'only a run under review can be reviewed (this one is %)',
      v_status using errcode = 'P0001';
  end if;
  if v_author is not null and v_author = auth.uid() then
    raise exception
      'a run cannot be reviewed by the person who created it; ask another reviewer'
      using errcode = '42501';
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'a review must record a note' using errcode = 'P0001';
  end if;

  insert into public.run_review (org_id, run_id, reviewer_id, decision, note)
  values (v_org, p_run, auth.uid(), p_decision, p_note);

  if p_decision = 'approved' then
    -- Freeze the inputs so the approved figures cannot move underneath the
    -- approval. Already-frozen vintages are left alone.
    update public.data_vintage
       set frozen_at = now()
     where id = v_vintage and frozen_at is null;
    update public.compilation_run set status = 'approved' where id = p_run;
  else
    update public.compilation_run set status = 'computed' where id = p_run;
  end if;
end;
$$;

/**
 * Publish an approved run, optionally under embargo.
 *
 * Publication marks the vintage published, which requires it to be frozen —
 * a check constraint from migration 0003 already enforces that, and approval
 * has done the freezing by this point.
 *
 * The embargo is a release timestamp. Organization members can still see the
 * figures (compiling them is their job); the embargo governs release to
 * anyone else, and every export before it lifts is stamped accordingly.
 */
create function public.publish_run(p_run uuid, p_embargo_until timestamptz default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_status  public.run_status;
  v_vintage uuid;
  v_frozen  timestamptz;
begin
  select r.org_id, r.status, r.input_vintage_id, v.frozen_at
    into v_org, v_status, v_vintage, v_frozen
    from public.compilation_run r
    join public.data_vintage v on v.id = r.input_vintage_id
   where r.id = p_run;
  if v_org is null then
    raise exception 'no such compilation run' using errcode = 'P0002';
  end if;
  if not private.has_org_role(v_org, 'admin') then
    raise exception 'only admins can publish' using errcode = '42501';
  end if;
  if v_status <> 'approved' then
    raise exception 'only an approved run can be published (this one is %)',
      v_status using errcode = 'P0001';
  end if;
  if v_frozen is null then
    raise exception 'the input vintage is not frozen; approve the run first'
      using errcode = 'P0001';
  end if;
  if p_embargo_until is not null and p_embargo_until <= now() then
    raise exception 'an embargo must be in the future' using errcode = 'P0001';
  end if;

  -- A frozen vintage accepts only a change to `published` (migration 0003's
  -- guard), so the embargo has to be set before freezing OR alongside
  -- publication. Setting it here is done through the same guard by leaving
  -- frozen_at and the rest untouched.
  if p_embargo_until is not null then
    update public.data_vintage
       set embargo_until = p_embargo_until
     where id = v_vintage and embargo_until is distinct from p_embargo_until
       and frozen_at is null;
    -- When the vintage is already frozen the guard forbids moving the
    -- embargo, so it is recorded on the run instead.
    update public.compilation_run
       set embargo_until = p_embargo_until where id = p_run;
  end if;

  update public.data_vintage set published = true where id = v_vintage;
  update public.compilation_run set status = 'published', published_at = now()
   where id = p_run;
end;
$$;

revoke execute on function public.submit_run_for_review(uuid, text) from public, anon;
revoke execute on function public.review_run(uuid, review_decision, text) from public, anon;
revoke execute on function public.publish_run(uuid, timestamptz) from public, anon;
grant execute on function public.submit_run_for_review(uuid, text) to authenticated;
grant execute on function public.review_run(uuid, review_decision, text) to authenticated;
grant execute on function public.publish_run(uuid, timestamptz) to authenticated;
