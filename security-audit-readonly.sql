-- ============================================================
-- SHOPWORKS SECURITY AUDIT — READ ONLY
-- Part of P0 (make it safe to share the database with other shops).
--
-- NOTHING IN THIS FILE CHANGES ANYTHING. Every statement is a SELECT.
-- There is no CREATE, ALTER, DROP, INSERT, UPDATE or DELETE anywhere in it.
-- You can run it on production with zero risk.
--
-- HOW TO RUN IT
--   1. Open Supabase -> SQL Editor -> New query.
--   2. Run ONE numbered query at a time (the editor only shows the
--      result of the last statement, so don't paste the whole file).
--   3. For QUERY 1 and QUERY 3-6: paste the results back to me.
--      For QUERY 2 (the big one): click "Download CSV", save the file
--      into your mhc-shop-app folder as rls-policies.csv, and tell me —
--      I'll read it straight off your PC, no pasting needed.
-- ============================================================


-- ============================================================
-- QUERY 1 — RED FLAGS
-- The short list of anything that looks wrong. If this comes back
-- with "No rows returned", the database rules are in good shape.
-- ============================================================
with t as (
  select tablename, rowsecurity
  from pg_tables
  where schemaname = 'public'
),
c as (
  select table_name
  from information_schema.columns
  where table_schema = 'public' and column_name = 'company_id'
),
p as (
  select tablename, policyname, cmd, roles::text as roles,
         coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
  from pg_policies
  where schemaname = 'public'
)
select 1 as sort,
       'RLS IS OFF' as issue,
       t.tablename as where_it_is,
       'No row security at all - any signed-in user of ANY shop can read/write every row' as what_it_means
from t
where not t.rowsecurity

union all
select 2, 'RLS ON BUT NO RULES', t.tablename,
       'Row security is on but no policies exist - nobody can use this table (or something got dropped)'
from t
where t.rowsecurity
  and not exists (select 1 from p where p.tablename = t.tablename)

union all
select 3, 'NO company_id COLUMN', t.tablename,
       'Nothing on this table says which shop it belongs to - we need to check by hand how it is isolated'
from t
where t.tablename not in (select table_name from c)

union all
select 4, 'RULE IGNORES THE SHOP', p.tablename || '  ->  ' || p.policyname,
       'cmd=' || p.cmd || ' - this rule never checks company_id, so it can reach another shop''s rows'
from p
join c on c.table_name = p.tablename
where p.expr not like '%company_id%'

union all
select 5, 'RULE OPEN TO CUSTOMER LOGINS', p.tablename || '  ->  ' || p.policyname,
       'cmd=' || p.cmd || ' - any login in the shop passes this, including customer portal accounts'
from p
where p.expr like '%current_company_id%'
  and p.expr not like '%is_admin%'
  and p.expr not like '%is_shop_user%'
  and p.expr not like '%current_customer_id%'
  and p.expr not like '%auth.uid%'

union all
select 6, 'RULE OPEN TO NOT-SIGNED-IN VISITORS', p.tablename || '  ->  ' || p.policyname,
       'roles = ' || p.roles || ' - granted to anon, which is the public internet'
from p
where p.roles like '%anon%'

order by 1, 3;


-- ============================================================
-- QUERY 2 — FULL RULE BOOK (download as CSV, don't paste)
-- Every row-security rule on every table, in full. This is what I
-- read line by line to find holes QUERY 1 can't spot.
-- Click "Download CSV" -> save as rls-policies.csv in your
-- mhc-shop-app folder.
-- ============================================================
select tablename,
       policyname,
       cmd,
       roles::text as applies_to_roles,
       coalesce(qual, '') as rule_for_existing_rows,
       coalesce(with_check, '') as rule_for_new_rows
from pg_policies
where schemaname = 'public'
order by tablename, policyname;


-- ============================================================
-- QUERY 3 — THE FOUR GATEKEEPER FUNCTIONS
-- Every rule in the database leans on these. If one of them is
-- wrong, every table is wrong.
-- ============================================================
select p.proname as function_name,
       p.prosecdef as runs_with_owner_powers,
       coalesce(array_to_string(p.proconfig, ', '), '*** NO search_path SET ***') as settings,
       pg_get_functiondef(p.oid) as full_definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_admin', 'is_shop_user', 'current_company_id',
                    'current_customer_id', 'handle_new_user')
order by p.proname;


-- ============================================================
-- QUERY 4 — OTHER OWNER-POWER FUNCTIONS AND VIEWS
-- Functions that run with owner powers bypass row security, so any
-- one of them with no fixed search_path is a way in. Views can also
-- bypass row security unless they are marked security_invoker.
-- ============================================================
select 'function' as kind,
       p.proname as name,
       coalesce(array_to_string(p.proconfig, ', '), '*** NO search_path SET ***') as detail
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef

union all
select 'view',
       c.relname,
       case when c.reloptions::text like '%security_invoker%'
            then 'security_invoker set (good)'
            else '*** bypasses row security - runs as the view owner ***' end
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'

union all
select 'trigger on auth.users',
       t.tgname,
       pg_get_triggerdef(t.oid)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal

order by 1, 2;


-- ============================================================
-- QUERY 5 — PHOTO STORAGE
-- 5a: are the storage buckets private?
-- ============================================================
select id as bucket, name, public as is_public_to_the_internet, created_at
from storage.buckets
order by name;

-- 5b: who can see the files in them?
select policyname, cmd, roles::text as applies_to_roles,
       coalesce(qual, '') as rule_for_existing_rows,
       coalesce(with_check, '') as rule_for_new_rows
from pg_policies
where schemaname = 'storage'
order by policyname;


-- ============================================================
-- QUERY 6 — IS ANY DATA ALREADY CROSSED BETWEEN SHOPS?
-- Every number here should be 0. A number above 0 means a row is
-- filed under one shop but its parent record belongs to another —
-- worth fixing before a second shop's data ever lands in here.
-- Also shows how many shops and logins exist today.
-- ============================================================
select 'jobs filed under the wrong shop for their customer' as check_name,
       count(*) as bad_rows
from jobs j join customers c on c.id = j.customer_id
where c.company_id <> j.company_id

union all
select 'job line items vs their job',
       count(*)
from job_line_items li join jobs j on j.id = li.job_id
where li.company_id <> j.company_id

union all
select 'job tasks vs their job',
       count(*)
from job_tasks t join jobs j on j.id = t.job_id
where t.company_id <> j.company_id

union all
select 'pick list items vs their job',
       count(*)
from job_pick_list_items i join jobs j on j.id = i.job_id
where i.company_id <> j.company_id

union all
select 'job messages vs their job',
       count(*)
from job_messages m join jobs j on j.id = m.job_id
where m.company_id <> j.company_id

union all
select 'time entries vs their job',
       count(*)
from time_entries te join jobs j on j.id = te.job_id
where te.company_id <> j.company_id

union all
select 'product templates vs their customer',
       count(*)
from product_templates pt join customers c on c.id = pt.customer_id
where pt.company_id <> c.company_id

union all
select 'stock rows vs their material',
       count(*)
from raw_material_inventory ri join raw_materials rm on rm.id = ri.raw_material_id
where ri.company_id <> rm.company_id

union all
select 'portal logins vs the customer they are linked to',
       count(*)
from profiles p join customers c on c.id = p.customer_id
where p.company_id <> c.company_id

union all
select '--- how many shops exist today ---',
       (select count(*) from companies)

union all
select '--- how many logins have no shop at all ---',
       (select count(*) from profiles where company_id is null)

order by 1;
