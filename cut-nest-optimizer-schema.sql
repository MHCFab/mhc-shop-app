-- ============================================================
-- CUTTING NEST OPTIMIZER - schema
-- Review before running. Run the whole script once in the
-- Supabase SQL Editor. Safe to re-run if something interrupts it.
--
-- Purely ADDITIVE. It creates two new tables and adds four new
-- columns. It does NOT alter or delete any existing table,
-- column, row, or policy. Every existing screen keeps working
-- exactly as it does today, because the new job toggle defaults
-- to false (optimizer OFF) on every job you already have.
--
-- What this does, in order:
--   1. jobs.cut_optimizer_enabled - the per-job toggle. False on
--      every existing job, so nothing changes until you flip it.
--   2. companies.nest_kerf_inches / nest_min_drop_inches - your
--      shop's saw defaults, so you don't retype them per job.
--   3. raw_materials.nest_depth_inches - how deep the profile is
--      in the plane of the cut (2 for HSS 2x2, 4 for a 4x2 laid
--      flat). This is what drives the miter math. Left empty it
--      just means "treat every cut as square" for that material.
--   4. job_cut_list_items - the cut list. One row per mark:
--      length, quantity, both end angles and which way each
--      leans. This is the piece ShopWorks has never had.
--   5. job_cut_nests - one row per job + material: the settings
--      that run was made with, the optimized plan itself, and
--      when it was applied to inventory.
--   6. Reloads the schema cache (new tables and columns - needed).
--
-- A NOTE ON UNITS, because the app is mixed and this matters:
-- raw material inventory stores FEET (stick_length_feet,
-- length_feet, cost_per_foot) and that does not change here.
-- Cut lists are inches in the shop and the optimizer works in
-- inches, so every new column below is named *_inches so the two
-- can never be confused. The app converts at the one boundary
-- where a nest turns into a stick pull or a saved drop.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The per-job toggle
-- ------------------------------------------------------------
-- False everywhere to start: every job you have today opens on
-- the Cutting Nest tab exactly as it does now.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS cut_optimizer_enabled boolean NOT NULL DEFAULT false;


-- ------------------------------------------------------------
-- 2. Shop-wide saw defaults
-- ------------------------------------------------------------
-- Kerf 1/8" is the usual cold-saw / bandsaw blade. Min usable
-- drop 12" means anything shorter than a foot is scrap, not
-- something worth racking. Both are editable per nest later.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS nest_kerf_inches     numeric NOT NULL DEFAULT 0.125,
  ADD COLUMN IF NOT EXISTS nest_min_drop_inches numeric NOT NULL DEFAULT 12;


-- ------------------------------------------------------------
-- 3. Profile depth, for the miter math
-- ------------------------------------------------------------
-- Nullable on purpose. Null = "I haven't told it the depth", and
-- the optimizer then treats that material's cuts as square
-- instead of guessing a number and quietly getting your yield
-- wrong. Section 7 below helps you fill these in.
ALTER TABLE public.raw_materials
  ADD COLUMN IF NOT EXISTS nest_depth_inches numeric;


-- ------------------------------------------------------------
-- 4. The cut list
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_cut_list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  raw_material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,

  -- Your mark for the piece: RAIL-A, POST, STRINGER-2.
  mark text,

  -- LONG POINT length, in inches. The miter runs back off the
  -- short face, the same way you'd call it out on a shop drawing.
  length_inches numeric NOT NULL CHECK (length_inches > 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),

  -- Each end: how many degrees off square, and which way it leans
  -- as the stick lies in the saw. 1 = "/", -1 = "\". Zero degrees
  -- is a square cut and the direction is then ignored.
  lead_angle  numeric  NOT NULL DEFAULT 0 CHECK (lead_angle  >= 0 AND lead_angle  < 90),
  lead_dir    smallint NOT NULL DEFAULT 1 CHECK (lead_dir  IN (-1, 1)),
  trail_angle numeric  NOT NULL DEFAULT 0 CHECK (trail_angle >= 0 AND trail_angle < 90),
  trail_dir   smallint NOT NULL DEFAULT 1 CHECK (trail_dir IN (-1, 1)),

  -- May the piece be turned end-for-end or rolled over so its cut
  -- can share a blade pass with its neighbour? False for anything
  -- handed, where left and right are not interchangeable.
  allow_flip boolean NOT NULL DEFAULT true,

  sort_order integer NOT NULL DEFAULT 0,

  -- Room for the later phase where cut lists come off the product
  -- template instead of being typed. 'manual' is everything today.
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'template')),
  product_template_id uuid REFERENCES public.product_templates(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Loading one job's cut list, in the order you typed it.
CREATE INDEX IF NOT EXISTS job_cut_list_items_job_sort
  ON public.job_cut_list_items (job_id, sort_order);

-- Pulling just the pieces cut from one material.
CREATE INDEX IF NOT EXISTS job_cut_list_items_job_material
  ON public.job_cut_list_items (job_id, raw_material_id);


-- ------------------------------------------------------------
-- 5. The nest itself
-- ------------------------------------------------------------
-- One row per job + material. Holds the settings the run was made
-- with, the resulting plan, and whether that plan has been
-- applied to inventory yet.
CREATE TABLE IF NOT EXISTS public.job_cut_nests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  raw_material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,

  -- Settings this nest was optimized with. They start from your
  -- shop defaults and can be nudged per nest.
  kerf_inches       numeric NOT NULL DEFAULT 0.125 CHECK (kerf_inches >= 0),
  min_drop_inches   numeric NOT NULL DEFAULT 12    CHECK (min_drop_inches >= 0),
  trim_start_inches numeric NOT NULL DEFAULT 0     CHECK (trim_start_inches >= 0),
  trim_end_inches   numeric NOT NULL DEFAULT 0     CHECK (trim_end_inches >= 0),

  -- How much a usable leftover is worth when scoring a nest:
  -- 0 = burn the whole stick, 1 = it goes back on the rack whole,
  -- 0.5 = the honest middle, and the default.
  drop_credit numeric NOT NULL DEFAULT 0.5 CHECK (drop_credit >= 0 AND drop_credit <= 1),

  effort text NOT NULL DEFAULT 'normal' CHECK (effort IN ('quick', 'normal', 'thorough')),

  -- The optimized plan: which sticks, what goes on each, what
  -- falls off the end. Written when you optimize, read back when
  -- you reopen the tab.
  result jsonb,
  optimized_at timestamptz,

  -- Stamped when the plan is pushed into inventory as stick pulls
  -- and saved drops. Null means the plan is still just a plan.
  applied_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One nest per material per job.
  CONSTRAINT job_cut_nests_job_material_unique UNIQUE (job_id, raw_material_id)
);

CREATE INDEX IF NOT EXISTS job_cut_nests_job
  ON public.job_cut_nests (job_id);


-- ------------------------------------------------------------
-- 6. Row security
-- ------------------------------------------------------------
-- Same shape as the rest of the app: admins do everything within
-- their own company; shop users get READ so a floor screen can
-- show the cut list later without another round of RLS debugging.
-- Customers get nothing - these tables are never exposed to the
-- portal.
ALTER TABLE public.job_cut_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_cut_nests      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_cut_list_items_admin_all ON public.job_cut_list_items;
CREATE POLICY job_cut_list_items_admin_all ON public.job_cut_list_items
  FOR ALL
  USING (is_admin() AND company_id = current_company_id())
  WITH CHECK (is_admin() AND company_id = current_company_id());

DROP POLICY IF EXISTS job_cut_list_items_employee_read ON public.job_cut_list_items;
CREATE POLICY job_cut_list_items_employee_read ON public.job_cut_list_items
  FOR SELECT
  USING (company_id = current_company_id() AND is_shop_user());

DROP POLICY IF EXISTS job_cut_nests_admin_all ON public.job_cut_nests;
CREATE POLICY job_cut_nests_admin_all ON public.job_cut_nests
  FOR ALL
  USING (is_admin() AND company_id = current_company_id())
  WITH CHECK (is_admin() AND company_id = current_company_id());

DROP POLICY IF EXISTS job_cut_nests_employee_read ON public.job_cut_nests;
CREATE POLICY job_cut_nests_employee_read ON public.job_cut_nests
  FOR SELECT
  USING (company_id = current_company_id() AND is_shop_user());


-- ------------------------------------------------------------
-- 7. Reload the schema cache (new tables AND new columns - needed)
--    Wait about 10 seconds after this before the app uses them.
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- ============================================================
-- VERIFICATION - run this separately afterwards. Expect
-- tables = 2, new_columns = 4, indexes = 3, policies = 4,
-- and both rls flags = t.
--
-- select
--   (select count(*) from information_schema.tables
--     where table_schema = 'public'
--       and table_name in ('job_cut_list_items','job_cut_nests')) as tables,
--   (select count(*) from information_schema.columns
--     where table_schema = 'public'
--       and ((table_name='jobs' and column_name='cut_optimizer_enabled')
--         or (table_name='companies' and column_name in ('nest_kerf_inches','nest_min_drop_inches'))
--         or (table_name='raw_materials' and column_name='nest_depth_inches'))) as new_columns,
--   (select count(*) from pg_indexes
--     where indexname in ('job_cut_list_items_job_sort',
--                         'job_cut_list_items_job_material',
--                         'job_cut_nests_job')) as indexes,
--   (select count(*) from pg_policies
--     where tablename in ('job_cut_list_items','job_cut_nests')) as policies,
--   (select relrowsecurity from pg_class where oid='public.job_cut_list_items'::regclass) as rls_cut_list,
--   (select relrowsecurity from pg_class where oid='public.job_cut_nests'::regclass) as rls_nests;
-- ============================================================


-- ============================================================
-- OPTIONAL, AND SEPARATE - filling in the profile depths
--
-- Nothing above needs this. The optimizer runs with the depths
-- empty; it just treats every cut as square, so an angled cut
-- costs you a whole extra blade pass instead of sharing one.
-- Fill them in when you want the miter math.
--
-- Depth means: how far the blade travels across the profile in
-- the plane of the cut. HSS 2x2 = 2. A 4x2 rectangle tube is 2
-- or 4 depending on which way it lies in the saw - call it the
-- way you actually cut it. Round tube: the outside diameter.
--
-- STEP 1 - look at what you have, and what the size text suggests:
--
-- select id, shape, size, wall_thickness, grade, nest_depth_inches
-- from public.raw_materials
-- where company_id = 'PASTE-YOUR-COMPANY-ID-HERE'
--   and is_active = true
-- order by shape, size;
--
-- STEP 2 - set them. Safest is one line per material, by id, so
-- you decide each one rather than trusting a parse of the size
-- text. Example:
--
-- update public.raw_materials set nest_depth_inches = 2
--  where id = 'the-hss-2x2-id' and company_id = 'PASTE-YOUR-COMPANY-ID-HERE';
--
-- You can also set them from the material's own page in the app
-- once this feature is deployed - no SQL needed after that.
-- ============================================================
