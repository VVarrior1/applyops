-- Custom SQL migration file, put your code below! ---

-- FK from public.profiles.user_id -> auth.users.id. auth.users is managed by
-- Supabase Auth and already exists in the database; drizzle-kit can't
-- express "don't try to create this table", so this constraint is added
-- here by hand instead of via a drizzle .references() in schema.ts (see the
-- comment at the top of src/db/schema.ts for the full explanation).
--
-- Guarded with `if not exists` so this migration can be safely replayed
-- against a restored/branched database or a reset __drizzle_migrations
-- table, not just run once against a fresh one.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_user_id_auth_users_fk'
  ) then
    alter table public.profiles
      add constraint profiles_user_id_auth_users_fk
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;
end $$;

-- Row Level Security, owner-only policies, on every table that carries a
-- literal user_id column. Defense in depth only: the app connects with the
-- service-role/`postgres` connection (which bypasses RLS entirely) and
-- enforces per-user scoping in application code — these policies exist to
-- protect against any future direct-from-browser (anon/authenticated key)
-- access to these tables. (See drizzle/0002_rls_remaining.sql for the
-- tables that don't carry a literal user_id but still need RLS enabled.)

alter table public.profiles enable row level security;
drop policy if exists "own rows" on public.profiles;
create policy "own rows" on public.profiles for all using (user_id = auth.uid());

alter table public.profile_facts enable row level security;
drop policy if exists "own rows" on public.profile_facts;
create policy "own rows" on public.profile_facts for all using (user_id = auth.uid());

alter table public.search_prefs enable row level security;
drop policy if exists "own rows" on public.search_prefs;
create policy "own rows" on public.search_prefs for all using (user_id = auth.uid());

alter table public.generations enable row level security;
drop policy if exists "own rows" on public.generations;
create policy "own rows" on public.generations for all using (user_id = auth.uid());

alter table public.job_scores enable row level security;
drop policy if exists "own rows" on public.job_scores;
create policy "own rows" on public.job_scores for all using (user_id = auth.uid());

alter table public.applications enable row level security;
drop policy if exists "own rows" on public.applications;
create policy "own rows" on public.applications for all using (user_id = auth.uid());

alter table public.usage_daily enable row level security;
drop policy if exists "own rows" on public.usage_daily;
create policy "own rows" on public.usage_daily for all using (user_id = auth.uid());
