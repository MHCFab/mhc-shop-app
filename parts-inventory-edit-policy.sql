-- ============================================================
-- Allow admins to EDIT purchased-part inventory rows from the app
-- (laser parts, fasteners, hardware, etc.)
-- Review before running. Run in Supabase SQL Editor.
--
-- Why: the part detail page (Purchase history) now lets you edit purchase / opening /
-- adjustment entries. Editing needs an UPDATE row-level-security policy on
-- purchased_parts_inventory. Same pattern as inventory-edit-update-policy.sql, which
-- did this for raw_material_inventory.
--
-- Scope: admins only, restricted to your own company_id. Employees get nothing new.
-- Idempotent: the DROP makes it safe to re-run.
--
-- RLS policy changes take effect immediately - no schema-cache reload needed.
-- ============================================================

DROP POLICY IF EXISTS purchased_parts_inventory_admin_update ON purchased_parts_inventory;
CREATE POLICY purchased_parts_inventory_admin_update ON purchased_parts_inventory
  FOR UPDATE USING (company_id = current_company_id() AND is_admin())
  WITH CHECK (company_id = current_company_id() AND is_admin());

-- Check: lists every policy on the table. You should see an UPDATE row named
-- purchased_parts_inventory_admin_update, and a DELETE (or ALL) row for admins.
SELECT policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'purchased_parts_inventory'
ORDER BY cmd, policyname;
