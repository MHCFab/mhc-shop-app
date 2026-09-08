-- ============================================================
-- CUTTING NEST OPTIMIZER - move the toggle onto each material
-- Review, then run the whole thing once in the Supabase SQL Editor.
-- Safe to re-run.
--
-- Why: a job can run its square tube through the optimizer while the
-- round tube goes to the plasma untouched. So the switch belongs on
-- the per-material nest row, not on the job.
--
-- Purely ADDITIVE, and it defaults to false, so nothing turns itself
-- on and no existing job changes behaviour.
--
-- NOTE: job_cut_nests.depth_inches was already added and is live -
-- this file does NOT repeat it.
-- ============================================================

ALTER TABLE public.job_cut_nests
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';

-- ------------------------------------------------------------
-- VERIFICATION - run separately afterwards. Expect both = 1.
--
-- select
--   (select count(*) from information_schema.columns
--     where table_schema='public' and table_name='job_cut_nests'
--       and column_name='enabled') as enabled_col,
--   (select count(*) from information_schema.columns
--     where table_schema='public' and table_name='job_cut_nests'
--       and column_name='depth_inches') as depth_col;
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- OPTIONAL, whenever you like - jobs.cut_optimizer_enabled is now
-- unused. It was the job-wide toggle this replaces. It holds no data
-- (false on every row) and nothing reads it after this change.
-- Left in place because dropping a column is the one thing here that
-- can't be undone by re-running a script.
--
-- ALTER TABLE public.jobs DROP COLUMN IF EXISTS cut_optimizer_enabled;
-- NOTIFY pgrst, 'reload schema';
-- ------------------------------------------------------------
