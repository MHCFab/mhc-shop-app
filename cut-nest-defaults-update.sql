-- ============================================================
-- CUTTING NEST OPTIMIZER - new defaults
-- Review, then run the whole thing once in the Supabase SQL Editor.
-- Safe to re-run.
--
-- Two changes, both just defaults - every value stays editable on
-- each individual nest.
--
--   1. Kerf 1/8" -> .035", the bandsaw blade you actually cut with.
--      (Worth a sanity check on a real cut: tooth set usually makes
--      the slot a bit wider than the blade itself.)
--
--   2. A usable drop is now worth FULL credit instead of half.
--      Meaning: if a leftover is longer than the minimum usable
--      drop it goes back on the rack whole, so it costs the job
--      nothing. The optimizer will now prefer a nest that leaves
--      one long saveable drop over one that leaves several short
--      pieces of scrap.
--
-- Nothing is deleted. Nests you have already optimized keep the
-- numbers they were figured with - only untouched ones move.
-- ============================================================


-- 1. The shop-wide default kerf, and MHC's current value.
ALTER TABLE public.companies
  ALTER COLUMN nest_kerf_inches SET DEFAULT 0.035;

UPDATE public.companies
   SET nest_kerf_inches = 0.035
 WHERE nest_kerf_inches = 0.125;


-- 2. Defaults for nests created from here on.
ALTER TABLE public.job_cut_nests
  ALTER COLUMN kerf_inches SET DEFAULT 0.035,
  ALTER COLUMN drop_credit SET DEFAULT 1;


-- 3. Nests that exist but have never been optimized are still
--    carrying the old defaults - bring them along. A nest you have
--    already run is deliberately left alone.
UPDATE public.job_cut_nests
   SET kerf_inches = 0.035,
       drop_credit = 1,
       updated_at  = now()
 WHERE optimized_at IS NULL
   AND kerf_inches = 0.125;


NOTIFY pgrst, 'reload schema';


-- ------------------------------------------------------------
-- VERIFICATION - run separately afterwards.
-- Expect company_kerf = 0.035, and no rows left on the old defaults.
--
-- select
--   (select min(nest_kerf_inches) from public.companies) as company_kerf,
--   (select count(*) from public.job_cut_nests
--     where optimized_at is null and kerf_inches = 0.125) as stale_nests,
--   (select column_default from information_schema.columns
--     where table_name='job_cut_nests' and column_name='kerf_inches') as kerf_default,
--   (select column_default from information_schema.columns
--     where table_name='job_cut_nests' and column_name='drop_credit') as credit_default;
-- ------------------------------------------------------------
