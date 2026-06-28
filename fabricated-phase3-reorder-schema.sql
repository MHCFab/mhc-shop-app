-- ============================================================
-- Fabricated sub-assemblies — Phase 3 (reorder targets) schema
-- Review before running. Run in Supabase SQL Editor.
--
-- Adds a reorder point and a build-to target to product templates, used by the
-- stockable fabricated items to flag low stock and suggest a build quantity.
-- Fully additive: two nullable numeric columns, nothing else changes.
-- NULL means "no reorder target set" (the item is simply not tracked for reorder).
-- ============================================================

ALTER TABLE product_templates
  ADD COLUMN IF NOT EXISTS reorder_point  numeric,  -- flag when on-hand <= this
  ADD COLUMN IF NOT EXISTS reorder_target numeric;  -- build back up to this level

-- Refresh the PostgREST schema cache (required after ALTER TABLE).
NOTIFY pgrst, 'reload schema';
