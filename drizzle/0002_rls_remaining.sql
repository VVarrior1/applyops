-- Custom SQL migration file, put your code below! ---

-- Fixes a live security gap left by drizzle/0001_rls.sql: RLS was enabled
-- only on tables carrying a literal `user_id` column. Supabase grants the
-- `anon` and `authenticated` roles broad privileges (SELECT/INSERT/UPDATE/
-- DELETE/...) on every table in `public` by default, and Postgres grants
-- alone are enough for PostgREST to serve rows over `/rest/v1/<table>` to
-- anyone holding the public anon key (which ships to the browser) — RLS is
-- the only thing that stops that once a table has row-level grants. Nine
-- tables had RLS disabled and were reachable this way: allowed_emails,
-- approvals, companies, eval_items, eval_results, eval_runs, jobs,
-- outcome_events, prompt_versions.
--
-- The app itself always connects with the service-role/`postgres`
-- connection, which bypasses RLS entirely — nothing below changes app
-- behavior. It only closes off anon/authenticated access.
--
-- Belt-and-braces: also revoke the blanket table privileges Supabase grants
-- by default to anon/authenticated, on current tables and on any table
-- created in the future, so a table that ships later without an explicit
-- RLS migration fails closed (PostgREST returns 401/permission denied)
-- rather than failing open.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- outcome_events and approvals are user-owned transitively via
-- applications.user_id (spec §4: RLS with owner-only policies on user
-- tables) — give them real owner-scoped policies, not just RLS-enabled/
-- no-policy deny-all.

alter table public.outcome_events enable row level security;
drop policy if exists "own rows" on public.outcome_events;
create policy "own rows" on public.outcome_events for all using (
  exists (
    select 1 from public.applications a
    where a.id = outcome_events.application_id
      and a.user_id = auth.uid()
  )
);

alter table public.approvals enable row level security;
drop policy if exists "own rows" on public.approvals;
create policy "own rows" on public.approvals for all using (
  exists (
    select 1 from public.applications a
    where a.id = approvals.application_id
      and a.user_id = auth.uid()
  )
);

-- The remaining tables are shared/global reference or admin data (the
-- allow-list gate, the job catalog, companies, prompt/eval data) with no
-- per-user owner column. RLS is enabled with NO permissive policy, which
-- denies all access to anon/authenticated (and to any authenticated user —
-- there is no "own rows" concept here) while leaving the service-role
-- connection unaffected, since RLS never applies to it.

alter table public.allowed_emails enable row level security;
alter table public.companies enable row level security;
alter table public.jobs enable row level security;
alter table public.prompt_versions enable row level security;
alter table public.eval_items enable row level security;
alter table public.eval_runs enable row level security;
alter table public.eval_results enable row level security;
