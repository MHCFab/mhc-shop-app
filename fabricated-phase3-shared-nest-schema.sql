-- ============================================================
-- Fabricated sub-assemblies — Phase 3 (shared-nest builds) schema
-- Review before running. Run in Supabase SQL Editor.
--
-- Purpose: let ONE build order produce several different stockable
-- sub-assemblies from a single shared cutting nest (e.g. a rear-bumper
-- nest that yields the shared lower section + the FC upper + the LP upper).
--
-- Model: a new child table `build_outputs` lists the (template, quantity)
-- pairs a build order produces. A normal single-output build order keeps
-- using jobs.build_template_id / jobs.build_quantity exactly as today and
-- writes NO build_outputs rows — so nothing about existing builds changes.
-- A build has multiple outputs ONLY when it has build_outputs rows.
--
-- Fully additive: one new table + its RLS, mirroring fabricated_inventory
-- (Phase 1). No existing columns, rows, or constraints are touched.
-- Re-running is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS build_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  product_template_id uuid NOT NULL REFERENCES product_templates(id),
  quantity numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE build_outputs ENABLE ROW LEVEL SECURITY;

-- Admin-only, matching fabricated_inventory: build orders and their
-- captured costs stay admin-only. The floor crew still clocks onto the
-- build and sees what to cut through the pick list (job_pick_list_items),
-- which already has its own employee read policy — so no employee policy
-- is needed here.
CREATE POLICY build_outputs_admin_select ON build_outputs
  FOR SELECT USING (company_id = current_company_id() AND is_admin());
CREATE POLICY build_outputs_admin_insert ON build_outputs
  FOR INSERT WITH CHECK (company_id = current_company_id() AND is_admin());
CREATE POLICY build_outputs_admin_update ON build_outputs
  FOR UPDATE USING (company_id = current_company_id() AND is_admin())
  WITH CHECK (company_id = current_company_id() AND is_admin());
CREATE POLICY build_outputs_admin_delete ON build_outputs
  FOR DELETE USING (company_id = current_company_id() AND is_admin());

-- Look up a build order's outputs quickly.
CREATE INDEX IF NOT EXISTS idx_build_outputs_job
  ON build_outputs (company_id, job_id);

-- Refresh the PostgREST schema cache (required after creating a table).
NOTIFY pgrst, 'reload schema';
