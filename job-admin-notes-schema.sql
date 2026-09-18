-- ============================================================
-- ShopWorks: private admin notes on a job
-- Review this, then run it in the Supabase SQL Editor.
--
-- Purely ADDITIVE. One new table. No existing table, column,
-- policy or row is modified or deleted. Safe to run twice.
--
-- What it gives you:
--   * A free-text notes box on the job's Overview tab that ONLY
--     admins can see -- deposits collected, contact details,
--     anything you don't want on the shop floor.
--
-- WHY A SEPARATE TABLE instead of a column on jobs:
--   Row-level security controls WHICH ROWS a user can read, never
--   WHICH COLUMNS. Employees already have permission to read the
--   jobs table, so a jobs.admin_notes column would be readable by
--   the floor through the API even though no screen displays it.
--   Its own table with no employee policy is the only real lock.
-- ============================================================

-- ------------------------------------------------------------
-- 1) The table. One row per job (job_id is the primary key), so
--    saving simply overwrites what's there.
--    updated_by_name is a snapshot of the name at save time, so
--    the card never has to join profiles.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_admin_notes (
  job_id          uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  notes           text,
  updated_at      timestamptz,
  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.job_admin_notes ENABLE ROW LEVEL SECURITY;

-- Admins only, and only inside their own shop. Employees and
-- customer logins have NO policy here at all, so they see nothing.
DROP POLICY IF EXISTS job_admin_notes_admin_all ON public.job_admin_notes;
CREATE POLICY job_admin_notes_admin_all ON public.job_admin_notes
  FOR ALL USING (company_id = current_company_id() AND is_admin())
  WITH CHECK (company_id = current_company_id() AND is_admin());

CREATE INDEX IF NOT EXISTS idx_job_admin_notes_company
  ON public.job_admin_notes (company_id);

-- ------------------------------------------------------------
-- 2) Let the API see the new table.
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ------------------------------------------------------------
-- 3) Read-only check. Run this after the above and paste me the
--    result. Expect exactly one row: table_present = t,
--    rls_on = t, policy_count = 1.
-- ------------------------------------------------------------
SELECT
  (SELECT count(*) FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'job_admin_notes') = 1 AS table_present,
  (SELECT c.relrowsecurity FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'job_admin_notes')    AS rls_on,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'job_admin_notes')   AS policy_count;
