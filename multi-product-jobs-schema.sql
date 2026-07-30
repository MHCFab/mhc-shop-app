-- ============================================================
-- Multi-product jobs — schema change
-- Run these in the Supabase SQL Editor, one step at a time.
-- ============================================================

-- ------------------------------------------------------------
-- STEP 1 — LOOK FIRST (this changes nothing).
-- Shows whether job_tasks.job_line_item_id currently requires a value.
-- Read the "is_nullable" column in the result:
--    NO  = required today -> run Step 2.
--    YES = already optional -> skip Step 2, you're done.
-- ------------------------------------------------------------
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'job_tasks'
  and column_name = 'job_line_item_id';


-- ------------------------------------------------------------
-- STEP 2 — Only if Step 1 said "NO".
-- Lets a task belong to the whole job instead of to one product line.
-- That is what makes a single shared "Cut" task possible on a job that
-- has two product variations on it.
--
-- This does NOT change any existing task. Every task you have today keeps
-- pointing at its product line exactly as it does now.
-- ------------------------------------------------------------
alter table public.job_tasks
  alter column job_line_item_id drop not null;


-- ------------------------------------------------------------
-- STEP 3 — Refresh Supabase's schema cache, then wait ~10 seconds.
-- ------------------------------------------------------------
notify pgrst, 'reload schema';


-- ------------------------------------------------------------
-- STEP 4 — CONFIRM (changes nothing).
-- Should now report is_nullable = YES.
-- ------------------------------------------------------------
select column_name, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'job_tasks'
  and column_name = 'job_line_item_id';
