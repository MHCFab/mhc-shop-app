-- ============================================================
-- ShopWorks: QuickBooks connection for the Finances page
-- QUICKBOOKS-SCHEMA-V1
--
-- Review it, then run it in the Supabase SQL Editor.
-- Run PART 1 (select from the top down to the PART 2 line, Run).
-- Then run PART 2 on its own. "Success. No rows returned" IS the pass -
-- the Supabase editor does not show RAISE NOTICE. Any problem stops with
-- an error that says what is wrong.
--
-- What it does - ADDITIVE ONLY. Nothing existing is changed or deleted.
--
--   * quickbooks_connections - one row per shop that has connected its
--     QuickBooks company. Holds the QuickBooks login tokens, SCRAMBLED
--     (AES-256-GCM) with a key that lives only in Vercel, so the database
--     alone cannot be used to get into anybody's QuickBooks.
--
--     NO browser login can read or write this table - not admins, not you
--     through the app. Row-level security is on with NO policies, and the
--     blanket table grants Supabase gives 'anon' and 'authenticated' are
--     taken away. Only the server (service role) and this SQL editor can
--     touch it. The page asks the server "am I connected?" instead.
--
--   * finance_settings.qb_snapshot - the last "Pull month to date" result,
--     so the Budget tab shows it to everyone with finance access without
--     asking QuickBooks every time the page opens. Protected by the SAME
--     finance-only policy the rest of finance_settings already has.
-- ============================================================


-- ============================================================
-- PART 1 - SCHEMA
-- ============================================================

create table if not exists public.quickbooks_connections (
  company_id          uuid primary key references public.companies(id) on delete cascade,
  environment         text not null check (environment in ('sandbox', 'production')),
  realm_id            text not null,
  company_name        text,
  access_token_enc    text not null,
  access_expires_at   timestamptz not null,
  refresh_token_enc   text not null,
  refresh_expires_at  timestamptz,
  connected_by        uuid references public.profiles(id) on delete set null,
  connected_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.quickbooks_connections enable row level security;

-- No policies on purpose. And no table grants for browser logins either,
-- so even a policy added by mistake later would not open it up.
revoke all on table public.quickbooks_connections from anon, authenticated;

alter table public.finance_settings
  add column if not exists qb_snapshot jsonb;

notify pgrst, 'reload schema';


-- ============================================================
-- PART 2 - CHECK (read-only). Run on its own.
-- "Success. No rows returned" means every check passed.
-- ============================================================
do $$
declare
  n int;
begin
  if to_regclass('public.quickbooks_connections') is null then
    raise exception 'PROBLEM: quickbooks_connections does not exist';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.quickbooks_connections'::regclass) then
    raise exception 'PROBLEM: row-level security is OFF on quickbooks_connections';
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'quickbooks_connections';
  if n <> 0 then
    raise exception 'PROBLEM: quickbooks_connections has % policies - it should have none', n;
  end if;

  if has_table_privilege('authenticated', 'public.quickbooks_connections', 'SELECT')
     or has_table_privilege('authenticated', 'public.quickbooks_connections', 'INSERT')
     or has_table_privilege('authenticated', 'public.quickbooks_connections', 'UPDATE')
     or has_table_privilege('authenticated', 'public.quickbooks_connections', 'DELETE')
     or has_table_privilege('anon', 'public.quickbooks_connections', 'SELECT') then
    raise exception 'PROBLEM: browser logins still have table rights on quickbooks_connections';
  end if;

  if not has_table_privilege('service_role', 'public.quickbooks_connections', 'SELECT, INSERT, UPDATE, DELETE') then
    raise exception 'PROBLEM: the server (service_role) cannot use quickbooks_connections';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'finance_settings'
                    and column_name = 'qb_snapshot') then
    raise exception 'PROBLEM: finance_settings.qb_snapshot is missing';
  end if;
end $$;
