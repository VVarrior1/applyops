-- Custom SQL migration file, put your code below! ---

-- RLS for the three tables added by 0008 (the Guide feature), matching the
-- policy drizzle/0001_rls.sql and 0002_rls_remaining.sql established: the app
-- always connects with the service-role/`postgres` connection and so bypasses
-- RLS entirely — nothing below changes app behavior. It exists so that a table
-- reachable over PostgREST with the public anon key (which ships to the
-- browser) fails closed.
--
-- 0002 already revoked the default anon/authenticated table grants and set
-- `alter default privileges ... revoke all on tables`, so these three tables
-- were created without those grants. Enabling RLS with an owner-scoped policy
-- is the second lock, and the one that survives someone re-granting later.

alter table public.guides enable row level security;
drop policy if exists "own rows" on public.guides;
create policy "own rows" on public.guides for all using (user_id = auth.uid());

alter table public.chat_threads enable row level security;
drop policy if exists "own rows" on public.chat_threads;
create policy "own rows" on public.chat_threads for all using (user_id = auth.uid());

-- chat_messages is user-owned transitively, via chat_threads.user_id — the
-- same shape outcome_events/approvals use through applications.
alter table public.chat_messages enable row level security;
drop policy if exists "own rows" on public.chat_messages;
create policy "own rows" on public.chat_messages for all using (
  exists (
    select 1 from public.chat_threads t
    where t.id = chat_messages.thread_id
      and t.user_id = auth.uid()
  )
);
