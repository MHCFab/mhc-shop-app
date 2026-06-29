-- ============================================================
-- Allow admins to EDIT raw material inventory rows from the app
-- Review before running. Run in Supabase SQL Editor.
--
-- Why: the material detail page (History tab) now lets you edit purchase / opening /
-- adjustment entries. Editing needs an UPDATE row-level-security policy on
-- raw_material_inventory. (INSERT and DELETE already work today; this only adds UPDATE
-- if it isn't already present.)
--
-- Scope: admins, restricted to your own company_id — same pattern as every other
-- admin policy in the app. Idempotent: the DROP makes it safe to re-run.
--
-- Note: RLS policy changes take effect immediately — no schema-cache reload needed.
-- ============================================================

DROP POLICY IF EXISTS raw_material_inventory_admin_update ON raw_material_inventory;
CREATE POLICY raw_material_inventory_admin_update ON raw_material_inventory
  FOR UPDATE USING (company_id = current_company_id() AND is_admin())
  WITH CHECK (company_id = current_company_id() AND is_admin());
