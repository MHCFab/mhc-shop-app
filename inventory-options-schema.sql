-- ShopWorks: per-shop inventory options (v1 toggles)
-- SAFE & ADDITIVE. Adds 6 boolean columns to the companies table, every one
-- DEFAULT true, so every existing shop (MHC) keeps ALL inventory features ON.
-- Nothing is read, changed, or deleted. Re-runnable (IF NOT EXISTS).
--
-- Review it, then run it in the Supabase SQL Editor.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS inv_show_purchased_parts boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inv_show_fabricated      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inv_track_grade          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inv_track_wall_thickness boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inv_track_drops          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inv_use_nesting          boolean NOT NULL DEFAULT true;

-- Let the API pick up the new columns (schema cache refresh).
NOTIFY pgrst, 'reload schema';

-- Optional check — run this after, should show all true for your shop:
-- SELECT id, name,
--        inv_show_purchased_parts, inv_show_fabricated,
--        inv_track_grade, inv_track_wall_thickness,
--        inv_track_drops, inv_use_nesting
-- FROM public.companies;
