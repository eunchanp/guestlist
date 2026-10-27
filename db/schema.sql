-- ============================================================
-- Guestlist - Supabase schema
-- Lives in the same Supabase project as qplex; every object is prefixed
-- guestlist_ so it never collides with the pool tables.
-- Paste into the Supabase SQL Editor and run. Safe to re-run: every
-- statement is idempotent and never touches existing guests.
--
-- Security model
--   * Anyone with the anon key can READ the list (RLS select policy).
--   * Nobody can write to the table directly. Every change goes through a
--     security-definer function that checks the password against a bcrypt
--     hash stored in guestlist_secret, which the anon role cannot read.
--   * The password itself is NOT in this file. Set it once (and again any
--     time you want to change it) with:
--         select guestlist_set_password('your-password');
--     That function is not executable by the anon/authenticated roles, so it
--     can only be run from the SQL editor.
--   * Unlocking trades the password for a device token (guestlist_login),
--     which is what devices keep. The token is derived from the password
--     hash, so changing the password revokes every device at once.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.guestlist_guests (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  note       text not null default '',
  arrived_at timestamptz,                       -- null = not arrived yet
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guestlist_name_len check (char_length(btrim(name)) between 1 and 200),
  constraint guestlist_note_len check (char_length(note) <= 500)
);

create index if not exists guestlist_guests_name_idx on public.guestlist_guests (lower(name));

-- Single row holding the bcrypt hash of the edit password.
create table if not exists public.guestlist_secret (
  id            integer primary key default 1,
  password_hash text not null,
  constraint guestlist_secret_one_row check (id = 1)
);

-- The guests removed by the latest guestlist_clear, kept so it can be undone.
-- batch names that clear; the next clear replaces the contents.
create table if not exists public.guestlist_cleared (
  id         uuid primary key,
  batch      uuid not null,
  name       text not null,
  note       text not null,
  arrived_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- ------------------------------------------------------------
-- Row-level security
-- ------------------------------------------------------------
alter table public.guestlist_guests enable row level security;
alter table public.guestlist_secret enable row level security;
alter table public.guestlist_cleared enable row level security;

drop policy if exists "guestlist public read" on public.guestlist_guests;
create policy "guestlist public read" on public.guestlist_guests
  for select to anon, authenticated using (true);
-- No insert/update/delete policies: writes only happen through the
-- functions below. Revoke the table privileges too, as a second lock.
revoke insert, update, delete, truncate on public.guestlist_guests from anon, authenticated;
-- guestlist_secret has no policies at all and no grants: invisible to clients.
revoke all on public.guestlist_secret from anon, authenticated;
-- guestlist_cleared likewise: only the clear/undo functions touch it.
revoke all on public.guestlist_cleared from anon, authenticated;

-- ------------------------------------------------------------
-- Password helpers
-- ------------------------------------------------------------

-- SQL-editor only: set or change the edit password.
create or replace function public.guestlist_set_password(p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_password is null or char_length(p_password) < 4 then
    raise exception 'password must be at least 4 characters';
  end if;
  insert into public.guestlist_secret (id, password_hash)
  values (1, extensions.crypt(p_password, extensions.gen_salt('bf', 10)))
  on conflict (id) do update set password_hash = excluded.password_hash;
end $$;

-- Internal: the device token for a password hash. Not callable by clients.
create or replace function public.guestlist_device_token(p_hash text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.hmac('guestlist device token', p_hash, 'sha256'), 'hex')
$$;

-- Internal: raise unless p_password is the device token or the password
-- itself. Not callable by clients.
create or replace function public.guestlist_require(p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text;
begin
  select password_hash into h from public.guestlist_secret where id = 1;
  if h is null then
    raise exception 'guestlist password is not set' using errcode = '28000';
  end if;
  -- The token is the cheap check, so test it before bcrypt.
  if p_password = public.guestlist_device_token(h) then
    return;
  end if;
  if p_password is null or extensions.crypt(p_password, h) <> h then
    raise exception 'invalid password' using errcode = '28P01';
  end if;
end $$;

-- Client: unlock. Returns the device token, or null for a wrong password.
-- (Replaces guestlist_verify, which only said yes or no.)
drop function if exists public.guestlist_verify(text);
create or replace function public.guestlist_login(p_password text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text;
begin
  perform public.guestlist_require(p_password);
  select password_hash into h from public.guestlist_secret where id = 1;
  return public.guestlist_device_token(h);
exception when sqlstate '28P01' then
  return null;
end $$;

-- ------------------------------------------------------------
-- Write API (all password-checked)
-- p_password takes the device token from guestlist_login, or the password.
-- ------------------------------------------------------------

-- Add one or more guests. Blank names are skipped. Returns the new rows.
create or replace function public.guestlist_add(
  p_password text,
  p_names    text[],
  p_note     text default '',
  p_arrived  boolean default false
)
returns setof public.guestlist_guests
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.guestlist_require(p_password);
  return query
    insert into public.guestlist_guests (name, note, arrived_at)
    select btrim(n), btrim(coalesce(p_note, '')), case when p_arrived then now() end
      from unnest(p_names) with ordinality as t(n, ord)
     where btrim(coalesce(n, '')) <> ''
     order by ord
    returning *;
end $$;

-- Rename a guest / change their note.
create or replace function public.guestlist_update(
  p_password text,
  p_id       uuid,
  p_name     text,
  p_note     text
)
returns public.guestlist_guests
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.guestlist_guests;
begin
  perform public.guestlist_require(p_password);
  update public.guestlist_guests
     set name = btrim(p_name), note = btrim(coalesce(p_note, '')), updated_at = now()
   where id = p_id
  returning * into r;
  if r.id is null then
    raise exception 'guest not found' using errcode = 'P0002';
  end if;
  return r;
end $$;

-- Check a guest in or out. p_at restores an exact time (used by Undo);
-- otherwise the server clock stamps the arrival.
create or replace function public.guestlist_set_arrived(
  p_password text,
  p_id       uuid,
  p_arrived  boolean,
  p_at       timestamptz default null
)
returns public.guestlist_guests
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.guestlist_guests;
begin
  perform public.guestlist_require(p_password);
  update public.guestlist_guests
     set arrived_at = case when p_arrived then coalesce(p_at, now()) end,
         updated_at = now()
   where id = p_id
  returning * into r;
  if r.id is null then
    raise exception 'guest not found' using errcode = 'P0002';
  end if;
  return r;
end $$;

-- Remove a guest.
create or replace function public.guestlist_delete(p_password text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.guestlist_require(p_password);
  delete from public.guestlist_guests where id = p_id;
end $$;

-- Put a deleted guest back (Undo), with their id, note, arrival and creation
-- times. If that id is already back (another device undid it), returns it as is.
create or replace function public.guestlist_restore(
  p_password   text,
  p_id         uuid,
  p_name       text,
  p_note       text,
  p_arrived_at timestamptz,
  p_created_at timestamptz
)
returns public.guestlist_guests
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.guestlist_guests;
begin
  perform public.guestlist_require(p_password);
  insert into public.guestlist_guests (id, name, note, arrived_at, created_at)
  values (p_id, btrim(p_name), btrim(coalesce(p_note, '')), p_arrived_at, coalesce(p_created_at, now()))
  on conflict (id) do nothing;
  select * into r from public.guestlist_guests where id = p_id;
  return r;
end $$;

-- Remove every guest (to reuse the list for the next event), keeping a copy
-- in guestlist_cleared for guestlist_undo_clear. Returns {batch, count}.
-- DELETE rather than TRUNCATE so realtime tells the other devices; "where
-- true" because Supabase's pg_safeupdate rejects a DELETE without a WHERE.
-- An earlier version returned just the count, and a return type can't be
-- replaced in place, so drop that one first.
do $$
begin
  if (select prorettype from pg_proc
       where oid = to_regprocedure('public.guestlist_clear(text)')) = 'integer'::regtype
    then drop function public.guestlist_clear(text); end if;
end $$;
create or replace function public.guestlist_clear(p_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b uuid := gen_random_uuid();
  n integer;
begin
  perform public.guestlist_require(p_password);
  delete from public.guestlist_cleared where true;
  with gone as (
    delete from public.guestlist_guests where true returning *
  )
  insert into public.guestlist_cleared (id, batch, name, note, arrived_at, created_at, updated_at)
  select id, b, name, note, arrived_at, created_at, updated_at from gone;
  get diagnostics n = row_count;
  return jsonb_build_object('batch', b, 'count', n);
end $$;

-- Bring back the guests a guestlist_clear removed, with their ids, notes and
-- arrival times. Returns the restored rows: none if that clear was already
-- undone or a later clear replaced it.
create or replace function public.guestlist_undo_clear(p_password text, p_batch uuid)
returns setof public.guestlist_guests
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.guestlist_require(p_password);
  return query
    with back as (
      delete from public.guestlist_cleared where batch = p_batch returning *
    )
    insert into public.guestlist_guests (id, name, note, arrived_at, created_at, updated_at)
    select id, name, note, arrived_at, created_at, now() from back
    on conflict (id) do nothing
    returning *;
end $$;

-- Function privileges: Postgres grants EXECUTE to PUBLIC by default, so
-- revoke everything first, then expose only the client API.
revoke all on function public.guestlist_set_password(text)                         from public, anon, authenticated;
revoke all on function public.guestlist_device_token(text)                         from public, anon, authenticated;
revoke all on function public.guestlist_require(text)                              from public, anon, authenticated;
revoke all on function public.guestlist_login(text)                                from public;
revoke all on function public.guestlist_add(text, text[], text, boolean)           from public;
revoke all on function public.guestlist_update(text, uuid, text, text)             from public;
revoke all on function public.guestlist_set_arrived(text, uuid, boolean, timestamptz) from public;
revoke all on function public.guestlist_delete(text, uuid)                         from public;
revoke all on function public.guestlist_restore(text, uuid, text, text, timestamptz, timestamptz) from public;
revoke all on function public.guestlist_clear(text)                                from public;
revoke all on function public.guestlist_undo_clear(text, uuid)                     from public;
grant execute on function public.guestlist_login(text)                                to anon, authenticated;
grant execute on function public.guestlist_add(text, text[], text, boolean)           to anon, authenticated;
grant execute on function public.guestlist_update(text, uuid, text, text)             to anon, authenticated;
grant execute on function public.guestlist_set_arrived(text, uuid, boolean, timestamptz) to anon, authenticated;
grant execute on function public.guestlist_delete(text, uuid)                         to anon, authenticated;
grant execute on function public.guestlist_restore(text, uuid, text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.guestlist_clear(text)                                to anon, authenticated;
grant execute on function public.guestlist_undo_clear(text, uuid)                     to anon, authenticated;

-- ------------------------------------------------------------
-- Realtime: push changes to every open device (door phones stay in sync).
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'guestlist_guests')
    then alter publication supabase_realtime add table public.guestlist_guests; end if;
end $$;
