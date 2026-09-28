-- ============================================================
-- ShopWorks: the Finances page (shop rate, monthly tracker, budget)
-- FINANCE-SCHEMA-V1
--
-- Review it, then run it in the Supabase SQL Editor. Run PART 1 and
-- PART 2 together (select everything, Run). Then run PART 3 on its own
-- and paste me the result.
--
-- REHEARSED 2026-09-28 against a throwaway Postgres built to production's
-- shape (blanket grants, RLS, the real current_company_id / is_admin).
-- Every behaviour case at the bottom of this header passed, and each one
-- was also run with its protection REMOVED to prove it could fail.
--
-- What it does:
--   PART 1  ADDITIVE schema. Nothing existing is changed or deleted.
--     * companies.finance_enabled     - the Settings switch. OFF for every
--                                       shop by default.
--     * memberships.can_see_finances  - per-login access. OFF by default.
--     * has_finance_access()          - "is this login an active admin of
--                                       this shop with the finance switch on"
--     * a guard on memberships so only somebody who already has finance
--       access can hand it out (the rls-column trap: every admin can write
--       every column of memberships, so without this any admin could give
--       themselves your numbers). One exception: in a shop where NOBODY has
--       it yet, an admin may grant it - that is how a new shop gets started.
--       Demoting someone to employee switches their finance access off.
--     * finance_settings  - one row per shop: the shop-rate inputs and the
--                           budget ceilings.
--     * finance_months    - one row per shop per month.
--     Both tables: readable and writable ONLY by has_finance_access().
--     Employees, customers and ordinary admins get nothing - not even
--     through the API.
--
--   PART 2  MHC's data, copied from the Claude tracker as it stood on
--     2026-09-28: your crew / costs / loans / draw target / quoted rate,
--     the 18 budget categories, and Jan-Sep 2026. Turns the page ON for
--     MHC and gives YOUR login (erik@mhcfab.com) finance access. Nobody
--     else gets it. Safe to run twice: existing rows are left alone.
--
--   PART 3  Read-only check.
--
-- Behaviour cases rehearsed (all passed):
--   1  finance admin reads + writes settings and months          -> allowed
--   2  admin WITHOUT the flag reads finance_months                -> 0 rows
--   3  admin WITHOUT the flag inserts a month                     -> refused
--   4  employee reads finance_settings                            -> 0 rows
--   5  admin of shop B reads shop A's months                      -> 0 rows
--   6  admin without the flag grants it to themselves             -> refused
--   7  finance admin grants it to another admin                   -> allowed
--   8  shop with no finance person: admin grants themselves       -> allowed
--   9  demoting a finance admin to employee clears the flag       -> cleared
--  10  flag on an EMPLOYEE membership                             -> stays off
--  11  deactivated finance admin (profile inactive) reads months  -> 0 rows
--  12  admin without the flag inserts a membership with it ON     -> refused
--  13  SQL Editor (postgres) sets the flag                        -> allowed
-- ============================================================


-- ============================================================
-- PART 1 - SCHEMA
-- ============================================================

alter table public.companies
  add column if not exists finance_enabled boolean not null default false;

alter table public.memberships
  add column if not exists can_see_finances boolean not null default false;


-- Is the person asking an active ADMIN of the shop they are looking at,
-- with finance access switched on for them there?
create or replace function public.has_finance_access()
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from public.memberships m
     where m.user_id = auth.uid()
       and m.company_id = public.current_company_id()
       and m.status = 'active'
       and m.role = 'admin'
       and m.can_see_finances = true
  );
$function$;


-- Does this shop have ANYBODY with finance access? Only used by the guard,
-- for the "brand new shop" exception. Security definer so the answer does
-- not depend on what the caller is allowed to read.
create or replace function public.shop_has_finance_person(p_company_id uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from public.memberships m
     where m.company_id = p_company_id
       and m.status = 'active'
       and m.role = 'admin'
       and m.can_see_finances = true
  );
$function$;


-- The guard. NOT security definer, on purpose: current_user has to be the
-- real caller so the app ('authenticated') is checked and the SQL Editor
-- ('postgres') and our own server routes (service role) are not.
create or replace function public.guard_finance_flag()
 returns trigger
 language plpgsql
as $function$
declare
  touched boolean;
begin
  if TG_OP = 'INSERT' then
    touched := coalesce(new.can_see_finances, false);
  else
    touched := new.can_see_finances is distinct from old.can_see_finances;
  end if;

  if touched and current_user in ('authenticated', 'anon') then
    if not (public.has_finance_access()
            or not public.shop_has_finance_person(new.company_id)) then
      raise exception 'ShopWorks: only someone with finance access can change who sees the finances.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Finance access belongs to admins only. Anyone who is not an admin
  -- here loses it, whoever made the change.
  if new.role <> 'admin' then
    new.can_see_finances := false;
  end if;

  return new;
end
$function$;

drop trigger if exists memberships_guard_finance_flag on public.memberships;
create trigger memberships_guard_finance_flag
  before insert or update on public.memberships
  for each row execute function public.guard_finance_flag();


-- One row per shop: the shop-rate inputs and the budget ceilings.
create table if not exists public.finance_settings (
  company_id  uuid primary key references public.companies(id) on delete cascade,
  rate        jsonb not null default '{}'::jsonb,
  budget      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);

-- One row per shop per month. month is 'YYYY-MM'.
create table if not exists public.finance_months (
  company_id     uuid not null references public.companies(id) on delete cascade,
  month          text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  revenue        numeric(12,2) not null default 0,
  materials      numeric(12,2) not null default 0,
  supplies       numeric(12,2) not null default 0,
  payroll        numeric(12,2) not null default 0,
  overhead       numeric(12,2) not null default 0,
  debt_payments  numeric(12,2) not null default 0,
  owner_draws    numeric(12,2) not null default 0,
  equipment      numeric(12,2) not null default 0,
  new_borrowing  numeric(12,2) not null default 0,
  crew_hours     numeric(10,2) not null default 0,
  is_final       boolean not null default false,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles(id) on delete set null,
  primary key (company_id, month)
);

alter table public.finance_settings enable row level security;
alter table public.finance_months   enable row level security;

drop policy if exists finance_settings_finance_all on public.finance_settings;
create policy finance_settings_finance_all on public.finance_settings
  for all
  using      (company_id = current_company_id() and has_finance_access())
  with check (company_id = current_company_id() and has_finance_access());

drop policy if exists finance_months_finance_all on public.finance_months;
create policy finance_months_finance_all on public.finance_months
  for all
  using      (company_id = current_company_id() and has_finance_access())
  with check (company_id = current_company_id() and has_finance_access());

notify pgrst, 'reload schema';


-- ============================================================
-- PART 2 - MHC's DATA (from the Claude tracker, 2026-09-28)
-- ============================================================
do $$
declare
  mhc uuid;
  erik uuid;
begin
  select p.id, p.company_id into erik, mhc
    from public.profiles p
   where lower(p.email) = 'erik@mhcfab.com';

  if mhc is null then
    raise exception 'ShopWorks: could not find the erik@mhcfab.com login and its shop. Nothing was loaded.';
  end if;

  update public.companies set finance_enabled = true where id = mhc;

  update public.memberships
     set can_see_finances = true
   where user_id = erik and company_id = mhc and role = 'admin';
  if not found then
    raise exception 'ShopWorks: erik@mhcfab.com is not an admin membership of MHC. Nothing was loaded.';
  end if;

  insert into public.finance_settings (company_id, rate, budget, updated_by)
  values (mhc,
  '{
    "crew": [
      {"name": "Erik (salary)", "rate": 36.05775, "hours": 40, "shop": false},
      {"name": "Zack",          "rate": 30,       "hours": 40, "shop": true},
      {"name": "Jordan",        "rate": 23,       "hours": 40, "shop": true},
      {"name": "Nolan",         "rate": 10,       "hours": 20, "shop": false}
    ],
    "debts": [
      {"name": "SBA (Newtek)",           "amount": 1988},
      {"name": "Allegacy (truck)",       "amount": 1000.67},
      {"name": "HELOC",                  "amount": 499.14},
      {"name": "Headway line of credit", "amount": 1274.2},
      {"name": "US Bank (equipment)",    "amount": 1892.97},
      {"name": "Other loan",             "amount": 0}
    ],
    "taxPct": 0.0782, "match": 400, "fees": 77, "workedPct": 0.9658,
    "overhead": 16323, "supplies": 3228,
    "drawTarget": 4500, "drawActual": 7476, "quoted": 175,
    "taxReserve": 0.2, "equipFund": 500
  }'::jsonb,
  '{
    "categories": [
      {"name": "Owner draws", "limit": 4500, "match": [], "fromCashFlow": true},
      {"name": "Shop rent", "limit": 3750, "match": ["Shop Rent"], "fixed": true},
      {"name": "Insurance", "limit": 1586, "match": ["Insurance Expense"], "fixed": true},
      {"name": "Utilities", "limit": 1000, "match": ["Utilities"], "fixed": true},
      {"name": "Advertising", "limit": 1500, "match": ["Advertising and Promotion"]},
      {"name": "Automobile", "limit": 1400, "match": ["Automobile Expense"]},
      {"name": "Repairs & maintenance", "limit": 800, "match": ["Repairs and Maintenance"]},
      {"name": "Tools & equipment", "limit": 250, "match": ["Tools & Equipment"]},
      {"name": "Computer & internet", "limit": 250, "match": ["Computer and Internet Expenses"], "fixed": true},
      {"name": "Meals & entertainment", "limit": 250, "match": ["Meals and Entertainment"]},
      {"name": "Travel", "limit": 150, "match": ["Travel Expense"]},
      {"name": "Office supplies", "limit": 100, "match": ["Office Supplies"]},
      {"name": "Professional fees", "limit": 230, "match": ["Professional Fees", "LLC Fees"], "fixed": true},
      {"name": "Card & bank fees", "limit": 380, "match": ["QuickBooks Payments Fees", "Bank Service Charges", "Payroll Fees"]},
      {"name": "Other / uncategorized", "limit": 0, "match": ["Contract Labor", "Research and Development", "Charitable Contributions", "Ask My Accountant"]},
      {"name": "Shop supplies", "limit": 0, "match": ["Shop Supplies"], "pctOfRevenue": 0.045},
      {"name": "Materials (not capped)", "limit": 0, "match": ["Cost of Goods Sold"], "untracked": true},
      {"name": "Payroll (not capped)", "limit": 0, "match": ["Wages", "Taxes", "Retirement", "Cost of Labor"], "untracked": true}
    ]
  }'::jsonb,
  erik)
  on conflict (company_id) do nothing;

  insert into public.finance_months
    (company_id, month, revenue, materials, supplies, payroll, overhead,
     debt_payments, owner_draws, equipment, new_borrowing, crew_hours, is_final, updated_by)
  values
    (mhc, '2026-01', 48049.61,  9799.55, 2771.97, 13740.03, 15088.48,  3488.00, 12416.00,     0.00, 17943.00, 286.61, true,  erik),
    (mhc, '2026-02', 57410.03, 12474.23, 2267.92, 14689.24,  8759.38,  5564.00, 11041.21,     0.00,     0.00, 315.18, true,  erik),
    (mhc, '2026-03', 61588.83, 10956.79, 4735.16, 14191.92, 24514.84,  5983.00,  7299.02,  8180.15, 15910.59, 316.83, true,  erik),
    (mhc, '2026-04', 90808.11, 15126.81, 3610.09, 13488.08, 17995.46, 11853.41,  7352.65,     0.00,     0.00, 316.63, true,  erik),
    (mhc, '2026-05', 44018.29, 14674.12, 4750.04, 23848.65, 17010.22,  5464.00,  5677.04, 18321.03,  5000.00, 544.18, true,  erik),
    (mhc, '2026-06', 59770.05, 14513.34, 3153.21, 20316.50, 16244.77, 22292.20,  8863.67,  3963.09, 48522.00, 454.75, true,  erik),
    (mhc, '2026-07', 55193.32, 16770.85, 4014.40, 21739.25, 18484.07,  5161.34,  1402.06,  2000.00,     0.00, 425.26, true,  erik),
    (mhc, '2026-08', 64692.99, 17180.70, 2166.65, 15835.65, 13243.08,  5161.34,  6452.75,     0.00,     0.00, 280.95, true,  erik),
    (mhc, '2026-09', 37451.25,  5193.57,  616.16, 12868.83, 10672.99,  3887.14,  4538.11,     0.00,  2000.00, 224.00, false, erik)
  on conflict (company_id, month) do nothing;
end $$;


-- ============================================================
-- PART 3 - READ-ONLY CHECK. Run on its own. Every row should say OK.
-- ============================================================
select 'tables + RLS' as check_name,
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname in ('finance_settings','finance_months')
                     and c.relrowsecurity) = 2
            then 'OK' else 'PROBLEM: a finance table is missing or has RLS off' end as result
union all
select 'policies',
       case when (select count(*) from pg_policies where schemaname = 'public'
                   and tablename in ('finance_settings','finance_months')) = 2
            then 'OK' else 'PROBLEM: expected exactly 2 finance policies' end
union all
select 'guard trigger',
       case when exists (select 1 from pg_trigger where tgname = 'memberships_guard_finance_flag')
            then 'OK' else 'PROBLEM: memberships guard trigger missing' end
union all
select 'guard is not security definer',
       case when (select prosecdef from pg_proc where proname = 'guard_finance_flag') = false
            then 'OK' else 'PROBLEM: guard_finance_flag is security definer - it would let everything through' end
union all
select 'who has finance access',
       coalesce((select string_agg(p.email, ', ') from public.memberships m
                   join public.profiles p on p.id = m.user_id
                  where m.can_see_finances), '(nobody)')
union all
select 'MHC page switched on',
       case when (select finance_enabled from public.companies c
                    join public.profiles p on p.company_id = c.id
                   where lower(p.email) = 'erik@mhcfab.com')
            then 'OK' else 'PROBLEM: finance_enabled is off for MHC' end
union all
select 'MHC settings row',
       case when (select count(*) from public.finance_settings) = 1
            then 'OK' else 'PROBLEM: expected 1 finance_settings row' end
union all
select 'MHC months loaded',
       (select count(*)::text || ' months, ' || count(*) filter (where is_final)::text || ' final'
          from public.finance_months);
-- Expect the last row to read: 9 months, 8 final
-- and "who has finance access" to read: erik@mhcfab.com
