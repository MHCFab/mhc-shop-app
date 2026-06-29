-- ============================================================
-- Let employees advance a job's status from the floor
-- Review before running. Run in Supabase SQL Editor.
--
-- Problem: when an employee clocks into a task, the app flips the job
-- ready -> in_progress, and when the last task is finished it marks the job
-- complete. Both writes are UPDATEs on the jobs table. Employees can already
-- update job_tasks and time_entries, but they have no UPDATE permission on
-- jobs, so row-level security silently blocks those status changes and the
-- job stays "ready".
--
-- Fix: add an employee-friendly UPDATE policy on jobs, scoped to the user's
-- own company (the same trust level they already have for tasks and time).
-- This is a permissive policy, so it sits alongside the existing admin
-- policies without removing or changing them. Company isolation is preserved:
-- a user can only ever touch jobs in their own company.
--
-- Idempotent: the DROP makes it safe to re-run. RLS changes take effect
-- immediately (no schema-cache reload needed).
-- ============================================================

-- Confirmed via pg_policy: jobs currently has only jobs_admin_all (admins, ALL) and
-- jobs_employee_read (employees, SELECT). This adds the missing employee UPDATE,
-- named to match the existing jobs_employee_read policy.
DROP POLICY IF EXISTS jobs_employee_update ON jobs;
CREATE POLICY jobs_employee_update ON jobs
  FOR UPDATE USING (company_id = current_company_id())
  WITH CHECK (company_id = current_company_id());
