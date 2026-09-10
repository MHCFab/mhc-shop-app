-- ============================================================
-- PRODUCT TEMPLATE CUT LISTS - schema
--
-- REHEARSED against a throwaway Postgres 16 in a sandbox before
-- you were handed this: the table, both triggers, all four
-- policies, and eleven behaviour cases (including the negative
-- ones - can an admin of another shop reach these rows, does the
-- feet total follow a DELETE, does a cross-company parent get
-- rejected). Results are in the header of section 8.
--
-- Review before running. Run the whole script once in the
-- Supabase SQL Editor. Safe to re-run if something interrupts it.
--
-- Purely ADDITIVE. One new table, two new trigger functions, and
-- the triggers that call them. It does NOT alter or delete any
-- existing table, column, row, or policy. Every screen you have
-- today keeps working exactly as it does, because no template has
-- a cut list until you type one.
--
-- WHAT THIS IS FOR
-- A product template today says "this railing uses 24 feet of
-- HSS 2x2". It has never said WHICH PIECES - a 76 1/2 rail, four
-- 42 posts. That is why the cutting nest optimizer makes you type
-- the cut list by hand on every single job. This table is where
-- those pieces live, once, on the template.
--
-- THE ONE BEHAVIOUR CHANGE, AND IT IS DELIBERATE
-- When a material on a template HAS a cut list, its "feet per
-- unit" stops being something you type and becomes something the
-- app adds up for you: total inches of every piece, divided by 12.
-- A material with NO cut list is completely untouched - you keep
-- typing its feet exactly as you do now. That is the rule you
-- picked: the cut list drives the feet, but only where you made
-- one.
--
-- ⚠️ WORTH KNOWING BEFORE YOU RUN IT: derived feet are EXACT cut
-- footage. No kerf, no drop, no waste allowance. So on a material
-- with a cut list, the estimated feet on the pick list - and the
-- material cost on the template - will read slightly LOWER than
-- what really comes off the rack. Your actuals still come from
-- the nest (pulled minus saved), so the variance you see will be
-- real waste rather than a padded number. If you would rather pad
-- it, say so and I will add a waste percent per material later.
--
-- WHAT IT DOES, IN ORDER:
--   1. product_template_cut_items - the pieces themselves.
--   2. Indexes for loading one material's list in order.
--   3. Row security, same shape as the rest of the app.
--   4. A guard trigger: a cut item's company always follows its
--      parent BOM row, so it can never be pointed at another shop.
--   5. The sync trigger: keeps feet per unit equal to the sum of
--      the pieces.
--   6. Reloads the schema cache (new table - needed).
--   7. Verification to run afterwards.
--
-- UNITS, because the app is mixed and this bites:
-- raw material inventory stores FEET. Cut lists are INCHES in the
-- shop, so every length column below is named *_inches. The one
-- and only place the two meet is the divide-by-12 in section 5.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The pieces
-- ------------------------------------------------------------
-- A cut item hangs off a MATERIAL ROW of the template, not off a
-- raw material directly. That is on purpose: it makes it
-- impossible to have a cut list for steel that is not on the
-- bill of materials, and it means the sum in section 5 has an
-- obvious row to write back to.
CREATE TABLE IF NOT EXISTS public.product_template_cut_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- The BOM line this piece is cut from. Delete the material off
  -- the template and its pieces go with it.
  product_template_material_id uuid NOT NULL
    REFERENCES public.product_template_materials(id) ON DELETE CASCADE,

  -- Your mark for the piece: RAIL-A, POST, STRINGER-2.
  mark text,

  -- LONG POINT length, in inches - the miter runs back off the
  -- short face, the way you would call it out on a shop drawing.
  length_inches numeric NOT NULL CHECK (length_inches > 0),

  -- How many of this piece in ONE finished unit of the product.
  -- Four posts per railing is 4 here, and a job for six railings
  -- turns that into 24.
  quantity_per_unit integer NOT NULL DEFAULT 1 CHECK (quantity_per_unit > 0),

  -- Each end: how many degrees off square, and which way it leans
  -- as the stick lies in the saw. 1 = "/", -1 = "\". Zero degrees
  -- is a square cut and the direction is then ignored. Same
  -- convention as job_cut_list_items, so the copy across is
  -- column for column.
  lead_angle  numeric  NOT NULL DEFAULT 0 CHECK (lead_angle  >= 0 AND lead_angle  < 90),
  lead_dir    smallint NOT NULL DEFAULT 1 CHECK (lead_dir  IN (-1, 1)),
  trail_angle numeric  NOT NULL DEFAULT 0 CHECK (trail_angle >= 0 AND trail_angle < 90),
  trail_dir   smallint NOT NULL DEFAULT 1 CHECK (trail_dir IN (-1, 1)),

  -- May the piece be turned end for end so its cut can share a
  -- blade pass with its neighbour? False for anything handed,
  -- where left and right are not interchangeable.
  allow_flip boolean NOT NULL DEFAULT true,

  notes text,
  sort_order integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- 2. Indexes
-- ------------------------------------------------------------
-- Loading one material's cut list, in the order you typed it.
CREATE INDEX IF NOT EXISTS product_template_cut_items_material_sort
  ON public.product_template_cut_items (product_template_material_id, sort_order);


-- ------------------------------------------------------------
-- 3. Row security
-- ------------------------------------------------------------
-- Admins do everything inside their own shop. Shop staff get
-- READ, so a floor screen can show a template's pieces later
-- without another round of RLS debugging. Customers get nothing.
ALTER TABLE public.product_template_cut_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_template_cut_items_admin_all ON public.product_template_cut_items;
CREATE POLICY product_template_cut_items_admin_all ON public.product_template_cut_items
  FOR ALL
  USING (is_admin() AND company_id = current_company_id())
  WITH CHECK (is_admin() AND company_id = current_company_id());

DROP POLICY IF EXISTS product_template_cut_items_employee_read ON public.product_template_cut_items;
CREATE POLICY product_template_cut_items_employee_read ON public.product_template_cut_items
  FOR SELECT
  USING (company_id = current_company_id() AND is_shop_user());


-- ------------------------------------------------------------
-- 4. The guard: a piece always belongs to its parent's shop
-- ------------------------------------------------------------
-- Without this, somebody could insert a row carrying their OWN
-- company_id (which is all the policy above checks) while pointing
-- product_template_material_id at another shop's bill of
-- materials. This forces the company to whatever the parent row
-- says, and refuses the row outright if the parent cannot be seen.
-- SECURITY INVOKER on purpose: if row security hides the parent,
-- the lookup finds nothing and the insert is rejected, which is
-- exactly the answer we want.
CREATE OR REPLACE FUNCTION public.product_template_cut_item_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
  parent_company uuid;
BEGIN
  SELECT company_id
    INTO parent_company
    FROM public.product_template_materials
   WHERE id = NEW.product_template_material_id;

  IF parent_company IS NULL THEN
    RAISE EXCEPTION
      'That material is not on a bill of materials you can edit.';
  END IF;

  NEW.company_id := parent_company;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS product_template_cut_items_guard
  ON public.product_template_cut_items;
CREATE TRIGGER product_template_cut_items_guard
  BEFORE INSERT OR UPDATE ON public.product_template_cut_items
  FOR EACH ROW EXECUTE FUNCTION public.product_template_cut_item_guard();


-- ------------------------------------------------------------
-- 5. The sync: feet per unit follows the pieces
-- ------------------------------------------------------------
-- Runs after any piece is added, changed or removed, and writes
-- the total back onto the BOM row.
--
-- Two details that matter:
--   * COALESCE(NEW.x, OLD.x) is NOT used to find the parent.
--     On a DELETE plpgsql leaves NEW unassigned and touching it
--     RAISES - that exact mistake cost a day on the memberships
--     trigger. TG_OP is checked instead.
--   * If a piece is moved from one BOM row to another, BOTH rows
--     are recalculated, not just the new one.
--
-- When the LAST piece is deleted the total is NULL and feet per
-- unit is deliberately LEFT WHERE IT IS. The old hand-typed
-- number is long gone by then, and zeroing it would silently wipe
-- a material off the pick list. Deleting the last piece simply
-- hands the field back to you to type again.
CREATE OR REPLACE FUNCTION public.sync_template_material_feet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
  target uuid;
  total  numeric;
BEGIN
  FOREACH target IN ARRAY (
    CASE TG_OP
      WHEN 'INSERT' THEN ARRAY[NEW.product_template_material_id]
      WHEN 'DELETE' THEN ARRAY[OLD.product_template_material_id]
      ELSE ARRAY[NEW.product_template_material_id,
                 OLD.product_template_material_id]
    END
  )
  LOOP
    SELECT SUM(length_inches * quantity_per_unit) / 12.0
      INTO total
      FROM public.product_template_cut_items
     WHERE product_template_material_id = target;

    IF total IS NOT NULL THEN
      UPDATE public.product_template_materials
         SET feet_per_unit = ROUND(total, 4)
       WHERE id = target
         AND feet_per_unit IS DISTINCT FROM ROUND(total, 4);
    END IF;
  END LOOP;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS product_template_cut_items_sync_feet
  ON public.product_template_cut_items;
CREATE TRIGGER product_template_cut_items_sync_feet
  AFTER INSERT OR UPDATE OR DELETE ON public.product_template_cut_items
  FOR EACH ROW EXECUTE FUNCTION public.sync_template_material_feet();


-- ------------------------------------------------------------
-- 6. Reload the schema cache (new table - needed)
--    Wait about 10 seconds after this before the app uses it.
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- ============================================================
-- 7. VERIFICATION - run this separately afterwards.
-- Expect: table = 1, index = 1, policies = 2, functions = 2,
-- triggers = 2, and rls = t.
--
-- select
--   (select count(*) from information_schema.tables
--     where table_schema = 'public'
--       and table_name = 'product_template_cut_items') as table_made,
--   (select count(*) from pg_indexes
--     where indexname = 'product_template_cut_items_material_sort') as index_made,
--   (select count(*) from pg_policies
--     where tablename = 'product_template_cut_items') as policies,
--   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in ('product_template_cut_item_guard',
--                         'sync_template_material_feet')) as functions,
--   (select count(*) from pg_trigger
--     where tgrelid = 'public.product_template_cut_items'::regclass
--       and not tgisinternal) as triggers,
--   (select relrowsecurity from pg_class
--     where oid = 'public.product_template_cut_items'::regclass) as rls;
-- ============================================================


-- ============================================================
-- 8. WHAT THE REHEARSAL PROVED (Postgres 16, throwaway database,
--    row security ON and acting as a real authenticated user)
--
--   1. Admin of shop A can insert pieces on their own template.      PASS
--   2. Feet per unit followed the insert: 1 x 76 1/2 + 4 x 42
--      = 244.5 inches = 20.3750 ft, written automatically.            PASS
--   3. Editing a length (76.5 -> 90) gave 21.5000.                    PASS
--   4. Editing a quantity (4 -> 6 posts) gave 28.5000.                PASS
--   5. DELETE recalculated to 21.0000 - and did NOT raise on the
--      unassigned NEW record, which is the bug that bit before.       PASS
--   6. Deleting the LAST piece left feet per unit at 21.0000
--      rather than zeroing the material off the pick list.            PASS
--   7. Moving a piece between two BOM rows recalculated BOTH
--      (0.8333 and 7.1667, not just the row it moved to).             PASS
--   8. A material with no pieces kept its hand-typed feet, and
--      hand-editing that number still worked.                         PASS
--   9. A shop employee could READ the pieces but was refused a
--      write. (The refusal comes from the section 4 guard rather
--      than the policy, because a non-admin cannot see the parent
--      BOM row either. Blocked either way - the message is just
--      worded for the wrong reason. Employees do not edit
--      templates, so this is cosmetic.)                               PASS
--  10. Admin of shop B could not see shop A's pieces (0 rows).        PASS
--  11. Admin of shop B pointing a piece at shop A's BOM row was
--      REJECTED by the guard, and shop A's feet were unchanged.       PASS
--  12. Run again with the guard trigger REMOVED, case 11 SUCCEEDED
--      and planted a foreign row - so the test can genuinely fail,
--      and the guard is what stops it.                                PASS
-- ============================================================
