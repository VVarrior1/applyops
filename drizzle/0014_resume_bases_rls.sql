-- Custom SQL migration file, put your code below! ---

-- RLS for `resume_bases` (added by 0013), matching the policy shape
-- drizzle/0001_rls.sql, 0002_rls_remaining.sql and 0009_guide_rls.sql
-- established: the app always connects with the service-role/`postgres`
-- connection and so bypasses RLS entirely — nothing below changes app
-- behavior. It exists so that a table reachable over PostgREST with the
-- public anon key (which ships to the browser) fails closed.
--
-- This one matters more than most: `resume_bases.latex` holds the user's
-- entire real resume — name, phone, email, employers — in one column.

alter table public.resume_bases enable row level security;
drop policy if exists "own rows" on public.resume_bases;
create policy "own rows" on public.resume_bases for all using (user_id = auth.uid());
