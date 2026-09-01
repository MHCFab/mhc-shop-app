-- ============================================================
-- Product template types — schema change
-- Review before running. Run in the Supabase SQL Editor.
--
-- WHAT THIS DOES
-- Today one checkbox (is_sub_assembly) means three things at once:
-- "not orderable", "has no customer", and "shows in the sub-assembly
-- list". We are splitting that into a single explicit type:
--
--   'product'      finished good you sell to a customer
--   'sub_assembly' a complete part, sellable on its own, that can ALSO
--                  be used inside a bigger product
--   'fabricated'   a piece of a larger assembly, never sold on its own,
--                  built and held as shop inventory
--
-- This is additive. No existing column is dropped and no existing
-- behavior changes until the app code is updated. is_sub_assembly stays
-- exactly where it is as a safety net.
-- ============================================================


-- ------------------------------------------------------------
-- STEP 1 — LOOK FIRST (read-only, changes nothing).
-- Run this on its own and read the result. It shows every template
-- and which type it is about to get.
-- ------------------------------------------------------------
SELECT
  name,
  product_number,
  is_sub_assembly,
  is_stockable,
  customer_id IS NOT NULL AS has_customer,
  CASE WHEN is_sub_assembly THEN 'fabricated' ELSE 'product' END AS type_it_will_get
FROM product_templates
ORDER BY is_sub_assembly DESC, name;


-- ------------------------------------------------------------
-- STEP 2 — ADD THE COLUMN.
-- Every row gets 'product' to begin with. Safe to re-run.
-- ------------------------------------------------------------
ALTER TABLE product_templates
  ADD COLUMN IF NOT EXISTS template_type text NOT NULL DEFAULT 'product';


-- ------------------------------------------------------------
-- STEP 3 — BACKFILL from the flag that is already there.
--
-- Note on scoping: this is deliberately NOT filtered by company_id.
-- It is a 1-to-1 translation of a column that already exists on every
-- row, so it is correct for every shop, and it is idempotent — the
-- "template_type = 'product'" guard means running it twice does
-- nothing the second time. Step 1 shows you exactly which rows move.
-- ------------------------------------------------------------
UPDATE product_templates
SET template_type = 'fabricated'
WHERE is_sub_assembly = true
  AND template_type = 'product';


-- ------------------------------------------------------------
-- STEP 4 — LOCK THE ALLOWED VALUES.
-- Stops a typo from ever landing in this column.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_templates_template_type_check'
  ) THEN
    ALTER TABLE product_templates
      ADD CONSTRAINT product_templates_template_type_check
      CHECK (template_type IN ('product', 'sub_assembly', 'fabricated'));
  END IF;
END $$;


-- ------------------------------------------------------------
-- STEP 5 — REFRESH THE SCHEMA CACHE.
-- Required after ALTER TABLE, then wait about 10 seconds.
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- ------------------------------------------------------------
-- STEP 6 — CHECK IT WORKED (read-only).
-- Expect: every old sub-assembly now reads 'fabricated', everything
-- else reads 'product', and nothing reads 'sub_assembly' yet — you
-- will promote the sellable ones yourself in the app.
-- ------------------------------------------------------------
SELECT template_type, count(*) AS how_many
FROM product_templates
GROUP BY template_type
ORDER BY template_type;
