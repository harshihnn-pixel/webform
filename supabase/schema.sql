-- schema.sql
-- ------------------------------------------------------------------
-- Run this once in your Supabase project:
-- Dashboard -> SQL Editor -> New query -> paste this -> Run
--
-- This version does NOT use Supabase Auth (no email confirmation, no
-- login screens on Supabase's side). Instead, accounts are rows in a
-- plain "users" table that you can see directly in Table Editor, and
-- signup/login happen instantly with no email step.
--
-- Passwords are still hashed (never stored as plain text) using
-- Postgres's built-in pgcrypto extension, and the table itself is
-- locked down (see the RLS section) so the only way in or out is
-- through the controlled functions below — a page just calling
-- select() on the users table with the public key cannot read
-- anyone's password.
-- ------------------------------------------------------------------

create extension if not exists pgcrypto;

-- Safe to re-run: if an earlier attempt left any of these functions
-- behind with different parameter names, Postgres won't let
-- "create or replace" rename them, which silently breaks things.
-- Dropping first guarantees a clean slate every time this script runs.
drop function if exists public.signup_user(text, text, text, text);
drop function if exists public.login_user(text, text);
drop function if exists public.reset_password_user(text, text);
drop function if exists public.account_exists(text);
drop function if exists public.submit_application(uuid, text, jsonb, jsonb, jsonb, jsonb);
drop function if exists public.get_applications(uuid);

-- 1. Accounts.
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  phone text,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- 2. Loan applications.
create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  ref text not null,
  personal jsonb not null default '{}'::jsonb,
  employment jsonb not null default '{}'::jsonb,
  loan jsonb not null default '{}'::jsonb,
  documents jsonb not null default '[]'::jsonb, -- [{name, type, size, dataUrl}, ...]
  status text not null default 'Submitted',
  created_at timestamptz not null default now()
);

create index if not exists applications_user_id_idx on public.applications(user_id);

-- 3. Lock both tables down completely. No policies are added for
--    either table, which means the anon key (used by the browser)
--    cannot read or write them directly at all — not even your own
--    row. The only way in is through the functions below.
alter table public.users enable row level security;
alter table public.applications enable row level security;

-- 4. Functions. Each is SECURITY DEFINER, meaning it runs with the
--    permissions of whoever created it (you, via this script) rather
--    than the caller's — that's what lets it read/write the locked
--    tables above while still keeping direct table access closed off.

create or replace function public.signup_user(
  p_name text, p_email text, p_phone text, p_password text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_user public.users;
begin
  if p_name is null or trim(p_name) = '' then
    raise exception 'Full name is required';
  end if;
  if v_email = '' then
    raise exception 'Email is required';
  end if;
  if p_password is null or length(p_password) < 6 then
    raise exception 'Password should be at least 6 characters';
  end if;
  if exists (select 1 from public.users where email = v_email) then
    raise exception 'An account with this email already exists';
  end if;

  insert into public.users (name, email, phone, password_hash)
  values (trim(p_name), v_email, p_phone, crypt(p_password, gen_salt('bf')))
  returning * into v_user;

  return json_build_object('id', v_user.id, 'name', v_user.name, 'email', v_user.email, 'phone', v_user.phone);
end;
$$;

create or replace function public.login_user(
  p_email text, p_password text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_user public.users;
begin
  select * into v_user from public.users where email = v_email;
  if v_user.id is null or v_user.password_hash <> crypt(p_password, v_user.password_hash) then
    raise exception 'Incorrect email or password';
  end if;

  return json_build_object('id', v_user.id, 'name', v_user.name, 'email', v_user.email, 'phone', v_user.phone);
end;
$$;

create or replace function public.account_exists(p_email text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.users where email = lower(trim(p_email)));
$$;

create or replace function public.reset_password_user(
  p_email text, p_new_password text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_user public.users;
begin
  if p_new_password is null or length(p_new_password) < 6 then
    raise exception 'Password should be at least 6 characters';
  end if;

  select * into v_user from public.users where email = v_email;
  if v_user.id is null then
    raise exception 'No account found with that email';
  end if;

  update public.users set password_hash = crypt(p_new_password, gen_salt('bf')) where id = v_user.id;

  return json_build_object('ok', true);
end;
$$;

create or replace function public.submit_application(
  p_user_id uuid, p_ref text, p_personal jsonb, p_employment jsonb, p_loan jsonb, p_documents jsonb
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app public.applications;
begin
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'Unknown user';
  end if;

  insert into public.applications (user_id, ref, personal, employment, loan, documents, status)
  values (p_user_id, p_ref, coalesce(p_personal, '{}'::jsonb), coalesce(p_employment, '{}'::jsonb),
          coalesce(p_loan, '{}'::jsonb), coalesce(p_documents, '[]'::jsonb), 'Submitted')
  returning * into v_app;

  return json_build_object('id', v_app.id, 'ref', v_app.ref, 'created_at', v_app.created_at);
end;
$$;

create or replace function public.get_applications(p_user_id uuid)
returns setof public.applications
language sql
security definer
set search_path = public
as $$
  select * from public.applications where user_id = p_user_id order by created_at desc;
$$;

-- 5. Let the browser (anon key) call these functions — this is the
--    only access it gets; direct table reads/writes stay blocked.
grant execute on function public.account_exists(text) to anon;
grant execute on function public.signup_user(text, text, text, text) to anon;
grant execute on function public.login_user(text, text) to anon;
grant execute on function public.reset_password_user(text, text) to anon;
grant execute on function public.submit_application(uuid, text, jsonb, jsonb, jsonb, jsonb) to anon;
grant execute on function public.get_applications(uuid) to anon;

-- 6. Tell PostgREST to pick up the functions above immediately,
--    instead of waiting for its next automatic refresh.
notify pgrst, 'reload schema';
