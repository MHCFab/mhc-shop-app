-- ============================================================
-- Costing rework — Phase: schema foundation
-- Review before running. Run in Supabase SQL Editor.
-- Adds an entry_type tag to inventory movements so cost layers
-- can be built reliably (purchase vs drop vs pull vs adjustment),
-- and lets fabricated stock record an explicit 'opening' layer.
-- Additive + a best-effort backfill of existing rows. No data removed.
-- ============================================================

-- 1) Raw material inventory: tag each movement.
ALTER TABLE raw_material_inventory
  ADD COLUMN IF NOT EXISTS entry_type text;

-- Best-effort backfill from sign + source_note (first match wins).
UPDATE raw_material_inventory SET entry_type =
  CASE
    WHEN quantity_sticks < 0 AND source_note = 'Pulled for cutting nest' THEN 'pull'
    WHEN source_note ILIKE 'Reversed%'        THEN 'reversal'
    WHEN source_note ILIKE 'Drop from job%'   THEN 'drop'
    WHEN source_note ILIKE 'Opening stock%'   THEN 'opening'
    WHEN source_note IS NULL AND quantity_sticks > 0 THEN 'purchase'
    ELSE 'adjustment'
  END
WHERE entry_type IS NULL;

-- 2) Purchased parts inventory: tag each movement.
--    (This table has no source_note column, so we use notes + sign.)
ALTER TABLE purchased_parts_inventory
  ADD COLUMN IF NOT EXISTS entry_type text;

UPDATE purchased_parts_inventory SET entry_type =
  CASE
    WHEN notes ILIKE 'Opening stock%'       THEN 'opening'
    WHEN notes ILIKE '%Manual adjustment%'  THEN 'adjustment'
    WHEN quantity > 0                        THEN 'purchase'
    ELSE 'adjustment'
  END
WHERE entry_type IS NULL;

-- 3) Fabricated inventory: allow an explicit 'opening' source so opening
--    stock counts as a price layer (like a build), distinct from a generic
--    quantity-only 'adjustment'.
ALTER TABLE fabricated_inventory DROP CONSTRAINT IF EXISTS fabricated_inventory_source_check;
ALTER TABLE fabricated_inventory
  ADD CONSTRAINT fabricated_inventory_source_check
  CHECK (source IN ('build','opening','adjustment','consumption'));

-- Refresh the PostgREST schema cache (required after ALTER TABLE).
NOTIFY pgrst, 'reload schema';
