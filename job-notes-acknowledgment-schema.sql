-- ============================================================
-- Job notes acknowledgment
-- Review before running. Run in Supabase SQL Editor.
--
-- Adds an opt-in "require acknowledgment" flag to a job's notes, and a
-- per-employee record of who has acknowledged the CURRENT notes text.
-- Purely additive: every statement is guarded; no existing columns or
-- data are modified. Multi-tenant via company_id + RLS, consistent with
-- the other tables. Company isolation is preserved throughout.
-- ============================================================

-- 1) Opt-in flag on the job. When true, floor workers must acknowledge
--    this job's notes before they can clock in on any of its tasks.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS notes_require_ack boolean NOT NULL DEFAULT false;

-- 2) Per-employee acknowledgment. One row per (job, employee). The
--    acknowledged_notes snapshot records exactly what the worker agreed
--    to, so the app can re-prompt if the notes are later edited.
CREATE TABLE IF NOT EXISTS job_note_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES profiles(id),
  acknowledged_notes text NOT NULL,          -- snapshot of jobs.notes at ack time
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, employee_id)
);

ALTER TABLE job_note_acknowledgments ENABLE ROW LEVEL SECURITY;

-- Admins: full control within their own company (audit / manage).
CREATE POLICY job_note_ack_admin_all ON job_note_acknowledgments
  FOR ALL USING (company_id = current_company_id() AND is_admin())
  WITH CHECK (company_id = current_company_id() AND is_admin());

-- Employees: read acknowledgments in their company (to know their own
-- gate state) and record / refresh their OWN acknowledgment only.
CREATE POLICY job_note_ack_employee_select ON job_note_acknowledgments
  FOR SELECT USING (company_id = current_company_id());
CREATE POLICY job_note_ack_employee_insert ON job_note_acknowledgments
  FOR INSERT WITH CHECK (company_id = current_company_id() AND employee_id = auth.uid());
CREATE POLICY job_note_ack_employee_update ON job_note_acknowledgments
  FOR UPDATE USING (company_id = current_company_id() AND employee_id = auth.uid())
  WITH CHECK (company_id = current_company_id() AND employee_id = auth.uid());

-- Lookup index for the floor gate check.
CREATE INDEX IF NOT EXISTS idx_job_note_ack_job_employee
  ON job_note_acknowledgments (company_id, job_id, employee_id);

-- Refresh the PostgREST schema cache (required after ALTER TABLE / new table).
NOTIFY pgrst, 'reload schema';
