-- ============================================================
-- IS SCRAP ALREADY IN YOUR ACTUAL COST? - read-only diagnostic
--
-- ⚠️ This script only READS. There is no INSERT, UPDATE or DELETE
-- anywhere in it. It cannot change a number on any job.
--
-- WHY: the Cost tab shows an "of which scrap" line, and the code
-- claims that figure is already inside the actual cost above it.
-- Before changing how cost is totalled, that claim has to be
-- checked against a real finalized job - because if scrap IS
-- already in there and we add it again, every scrapped stick gets
-- counted TWICE and your cost reads high.
--
-- HOW TO RUN IT: fill in the two values just below, then run each
-- of the three queries and paste the results back.
-- ============================================================

-- Your company id, and the job number you just finalized and
-- didn't like the look of.
--   \set is not available in the Supabase editor, so just replace
--   the two literals in each query below.
--   company: 'PASTE-YOUR-COMPANY-ID'
--   job:     'PASTE-THE-JOB-NUMBER'


-- ------------------------------------------------------------
-- QUERY 1 - the job, and what its cutting nest recorded
-- ------------------------------------------------------------
-- net_pulled_feet is what finalize turns into the material actual.
-- If scrap went through the floor's scrap form, the extra stick is
-- part of pulled_feet here.
select
  j.job_number,
  j.cutting_nest_finalized_at,
  rm.shape,
  rm.size,
  rm.grade,
  round(sum(case when e.entry_type = 'pull'
                 then e.length_feet * e.quantity else 0 end)::numeric, 4) as pulled_feet,
  round(sum(case when e.entry_type = 'drop'
                 then e.length_feet * e.quantity else 0 end)::numeric, 4) as saved_drop_feet,
  round(sum(case when e.entry_type = 'pull' then e.length_feet * e.quantity
                 when e.entry_type = 'drop' then -e.length_feet * e.quantity
                 else 0 end)::numeric, 4) as net_pulled_feet
from public.jobs j
join public.cutting_nest_entries e on e.job_id = j.id
join public.raw_materials rm on rm.id = e.raw_material_id
where j.company_id = 'PASTE-YOUR-COMPANY-ID'
  and j.job_number = 'PASTE-THE-JOB-NUMBER'
group by j.job_number, j.cutting_nest_finalized_at, rm.shape, rm.size, rm.grade
order by rm.shape, rm.size;


-- ------------------------------------------------------------
-- QUERY 2 - THE ONE THAT ANSWERS THE QUESTION
-- ------------------------------------------------------------
-- For every line on the pick list: what was planned, what the
-- report is charging you (actual), and how much scrap was reported
-- against that same item.
--
-- READ IT LIKE THIS:
--   * raw_material rows - if `actual` is roughly `planned + scrap`,
--     then scrap IS already inside your cost and must NOT be added
--     again. If `actual` is roughly `planned`, it is NOT in there.
--   * purchased_part rows - if `actual` equals `planned` while
--     `scrap` is above zero, those scrapped parts are missing from
--     your cost. That is the gap.
select
  p.item_type,
  coalesce(
    rm.shape || ' ' || rm.size || ' (' || rm.grade || ')',
    pp.name,
    'custom / fabricated'
  )                                              as item,
  p.unit,
  round(p.planned_quantity::numeric, 4)          as planned,
  round(p.actual_quantity::numeric, 4)           as actual,
  round(coalesce(v.scrap_qty, 0)::numeric, 4)    as scrap,
  round((p.actual_quantity - p.planned_quantity)::numeric, 4) as actual_minus_planned,
  -- The tell. Near zero on a raw_material line means scrap is
  -- already inside actual. Equal to the scrap figure means it is not.
  round((p.actual_quantity - p.planned_quantity
         - coalesce(v.scrap_qty, 0))::numeric, 4) as unexplained_gap
from public.job_pick_list_items p
join public.jobs j on j.id = p.job_id
left join public.raw_materials  rm on rm.id = p.raw_material_id
left join public.purchased_parts pp on pp.id = p.purchased_part_id
left join (
  select job_id, item_type, raw_material_id, purchased_part_id,
         sum(extra_quantity) as scrap_qty
  from public.job_material_variances
  group by job_id, item_type, raw_material_id, purchased_part_id
) v
  on  v.job_id = p.job_id
  and v.item_type = p.item_type
  and coalesce(v.raw_material_id::text, '')   = coalesce(p.raw_material_id::text, '')
  and coalesce(v.purchased_part_id::text, '') = coalesce(p.purchased_part_id::text, '')
where j.company_id = 'PASTE-YOUR-COMPANY-ID'
  and j.job_number = 'PASTE-THE-JOB-NUMBER'
order by p.item_type, item;


-- ------------------------------------------------------------
-- QUERY 3 - what was scrapped, why, and what it cost
-- ------------------------------------------------------------
-- Straight from the scrap reports the floor filed.
select
  v.item_type,
  coalesce(
    rm.shape || ' ' || rm.size || ' (' || rm.grade || ')',
    pp.name
  )                                    as item,
  v.extra_quantity,
  v.unit,
  v.reason,
  v.notes,
  round((v.extra_quantity * coalesce(rm.current_cost_per_foot,
                                     pp.current_cost_each, 0))::numeric, 2) as scrap_cost,
  v.created_at
from public.job_material_variances v
join public.jobs j on j.id = v.job_id
left join public.raw_materials   rm on rm.id = v.raw_material_id
left join public.purchased_parts pp on pp.id = v.purchased_part_id
where j.company_id = 'PASTE-YOUR-COMPANY-ID'
  and j.job_number = 'PASTE-THE-JOB-NUMBER'
order by v.created_at;
