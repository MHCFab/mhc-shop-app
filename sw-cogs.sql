-- ===========================================================================
-- sw-cogs.sql  (2026-09-28)  SW-COGS-V1
-- ShopWorks COGS on the Finances page: every archived job's cost except labor,
-- by the month it was marked invoiced. Build orders are left out (their cost is
-- counted when the fabricated units are used on a customer job instead), so the
-- archive needs to know which rows were build orders.
--
-- Run PART 1, then PART 2, then PART 3, in the Supabase SQL Editor.
-- Safe to re-run: PART 1 is "if not exists", PART 2 only ever sets true.
-- ===========================================================================

-- PART 1: the flag. Every existing row starts as "not a build order".
alter table public.completed_jobs_archive
  add column if not exists is_build_order boolean not null default false;

notify pgrst, 'reload schema';

-- PART 2: mark past build orders. A build order that was received into
-- fabricated stock left a stock row whose note reads
-- "Received from build order <job number>", and that note survives the
-- archive. Matched inside the same shop only (company_id = company_id).
update public.completed_jobs_archive a
set is_build_order = true
where a.is_build_order = false
  and exists (
    select 1
    from public.fabricated_inventory f
    where f.company_id = a.company_id
      and f.source = 'build'
      and f.notes = 'Received from build order ' || a.job_number
  );

-- PART 3: check (one list - the SQL Editor only shows the last result).
--   "marked build order"   = rows PART 2 marked. Should be your stock builds only.
--   "no customer, NOT marked" = look here for a build order that was archived
--      without being received into stock. Tell Claude any job numbers you see.
select 'marked build order' as what, job_number, customer_name, invoiced_on,
       total_actual - labor_cost as cost_without_labor
from public.completed_jobs_archive
where is_build_order
union all
select 'no customer, NOT marked', job_number, customer_name, invoiced_on,
       total_actual - labor_cost
from public.completed_jobs_archive
where not is_build_order and coalesce(customer_name, '') = ''
order by 1, 4;
