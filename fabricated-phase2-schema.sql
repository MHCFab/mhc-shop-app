-- ============================================================
-- Fabricated sub-assemblies — Phase 2 schema
-- Review before running. Run in Supabase SQL Editor.
--
-- Purpose: let a job line and an inventory allocation point at a
-- stockable sub-assembly (a product template) as a third line type,
-- 'fabricated', alongside raw materials and purchased parts.
--
-- Fully additive: adds one nullable column to two tables and WIDENS the
-- existing CHECK constraints to allow the new type. No existing columns,
-- rows, or values are changed or removed. Re-running is safe.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Pick list: a fabricated line carries a product_template_id
--    (the stockable sub-assembly) instead of a raw_material_id /
--    purchased_part_id.
-- ------------------------------------------------------------
ALTER TABLE job_pick_list_items
  ADD COLUMN IF NOT EXISTS product_template_id uuid REFERENCES product_templates(id);

-- Widen the allowed item_type values to include 'fabricated'.
ALTER TABLE job_pick_list_items DROP CONSTRAINT IF EXISTS job_pick_list_items_item_type_check;
ALTER TABLE job_pick_list_items
  ADD CONSTRAINT job_pick_list_items_item_type_check
  CHECK (item_type = ANY (ARRAY['raw_material'::text, 'purchased_part'::text, 'fabricated'::text]));

-- Widen the per-row consistency check. A fabricated row has a
-- product_template_id and no raw_material_id / purchased_part_id.
-- (Existing raw_material / purchased_part rows have product_template_id
-- NULL, so they still satisfy the first two branches.)
ALTER TABLE job_pick_list_items DROP CONSTRAINT IF EXISTS job_pick_list_items_check;
ALTER TABLE job_pick_list_items
  ADD CONSTRAINT job_pick_list_items_check CHECK (
       (item_type = 'raw_material'   AND raw_material_id   IS NOT NULL AND purchased_part_id IS NULL     AND product_template_id IS NULL)
    OR (item_type = 'purchased_part' AND purchased_part_id IS NOT NULL AND raw_material_id   IS NULL     AND product_template_id IS NULL)
    OR (item_type = 'fabricated'     AND product_template_id IS NOT NULL AND raw_material_id IS NULL     AND purchased_part_id   IS NULL)
  );

-- ------------------------------------------------------------
-- 2) Allocations: same widening, so a job can reserve fabricated units
--    against fabricated stock.
-- ------------------------------------------------------------
ALTER TABLE inventory_allocations
  ADD COLUMN IF NOT EXISTS product_template_id uuid REFERENCES product_templates(id);

ALTER TABLE inventory_allocations DROP CONSTRAINT IF EXISTS inventory_allocations_item_type_check;
ALTER TABLE inventory_allocations
  ADD CONSTRAINT inventory_allocations_item_type_check
  CHECK (item_type = ANY (ARRAY['raw_material'::text, 'purchased_part'::text, 'fabricated'::text]));

ALTER TABLE inventory_allocations DROP CONSTRAINT IF EXISTS inventory_allocations_check;
ALTER TABLE inventory_allocations
  ADD CONSTRAINT inventory_allocations_check CHECK (
       (item_type = 'raw_material'   AND raw_material_id   IS NOT NULL AND purchased_part_id IS NULL     AND product_template_id IS NULL)
    OR (item_type = 'purchased_part' AND purchased_part_id IS NOT NULL AND raw_material_id   IS NULL     AND product_template_id IS NULL)
    OR (item_type = 'fabricated'     AND product_template_id IS NOT NULL AND raw_material_id IS NULL     AND purchased_part_id   IS NULL)
  );

-- ------------------------------------------------------------
-- Notes:
--  * fabricated_inventory.source already allows 'consumption'
--    (added in costing-schema.sql), so no change is needed there for
--    the negative consumption ledger row written at job release.
--  * No employee read policy is added on fabricated_inventory:
--    fabricated stock and its unit cost stay admin-only, matching
--    raw_material_inventory. The floor sees fabricated items through
--    job_pick_list_items, which already has an employee read policy.
-- ------------------------------------------------------------

-- Refresh the PostgREST schema cache (required after ALTER TABLE).
NOTIFY pgrst, 'reload schema';
