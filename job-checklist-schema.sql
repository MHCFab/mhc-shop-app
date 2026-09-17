-- ============================================================
-- ShopWorks: admin job checklist
-- Review this, then run it in the Supabase SQL Editor.
--
-- Purely ADDITIVE. Two new tables, one trigger. No existing table,
-- column, policy or row is modified or deleted. Re-runnable.
--
-- What it gives you:
--   * A shop-wide DEFAULT list of admin to-dos (Settings page).
--   * A per-job COPY of that list, which you tick off on the job's
--     Overview tab. Editing a job's list never touches the defaults.
--   * New jobs get the list automatically, however they are created
--     (new job screen, reproduce from archive, customer portal order).
-- ============================================================

-- ------------------------------------------------------------
-- 1) The shop-wide default list. One row per item, per shop.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_checklist_defaults (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  label       text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.job_checklist_defaults ENABLE ROW LEVEL SECURITY;

-- Admins only, and only inside their own shop. Employees and customer
-- logins have NO policy here at all, so they see nothing.
DROP POLICY IF EXISTS job_checklist_defaults_admin_all ON public.job_checklist_defaults;
CREATE POLICY job_checklist_defaults_admin_all ON public.job_checklist_defaults
  FOR ALL USING (company_id = current_company_id() AND is_admin())
  WITH CHECK (company_id = current_company_id() AND is_admin());

CREATE INDEX IF NOT EXISTS idx_job_checklist_defaults_company
  ON public.job_checklist_defaults (company_id, sort_order);

-- ------------------------------------------------------------
-- 2) The per-job checklist. completed_by_name is a snapshot of the
--    name at tick time, so the card never has to join profiles.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_checklist_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_id            uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  label             text NOT NULL,
  note              text,
  sort_order        integer NOT NULL DEFAULT 0,
  completed_at      timestamptz,
  completed_by      uuid REFERENCES public.profiles(id),
  completed_by_name text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.job_checklist_items ENABLE ROW LEVEL SECURITY;

-- Admins only. Same reasoning as above: this is your purchasing and
-- engineering list, not shop work, so the floor never sees it.
DROP POLICY IF EXISTS job_checklist_items_admin_all ON public.job_checklist_items;
CREATE POLICY job_checklist_items_admin_all ON public.job_checklist_items
  FOR ALL USING (company_id = current_company_id() AND is_admin())
  WITH CHECK (company_id = current_company_id() AND is_admin());

CREATE INDEX IF NOT EXISTS idx_job_checklist_items_job
  ON public.job_checklist_items (company_id, job_id, sort_order);

-- ------------------------------------------------------------
-- 3) Copy the defaults onto every newly created job.
--
--    SECURITY DEFINER so it works no matter who inserts the job --
--    an admin on the new-job screen, or a customer placing an order
--    through the portal. It only ever copies rows that already belong
--    to the same company as the job, so it cannot leak across shops.
--    If a shop has no defaults, it inserts nothing and does nothing.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_job_checklist()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.job_checklist_items (company_id, job_id, label, sort_order)
  SELECT d.company_id, NEW.id, d.label, d.sort_order
    FROM public.job_checklist_defaults d
   WHERE d.company_id = NEW.company_id;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_seed_job_checklist ON public.jobs;
CREATE TRIGGER trg_seed_job_checklist
  AFTER INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.seed_job_checklist();

-- ------------------------------------------------------------
-- 4) Let the API see the new tables.
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ------------------------------------------------------------
-- OPTIONAL: seed your four starting items with SQL instead of typing
-- them into Settings. Replace YOUR-COMPANY-ID with the value from:
--     SELECT id, name FROM public.companies;
-- Safe to run twice -- it will not create duplicates.
-- ------------------------------------------------------------
-- INSERT INTO public.job_checklist_defaults (company_id, label, sort_order)
-- SELECT 'YOUR-COMPANY-ID'::uuid, v.label, v.sort_order
--   FROM (VALUES
--     ('Design parts',   1),
--     ('Order parts',    2),
--     ('Order material', 3),
--     ('Order hardware', 4)
--   ) AS v(label, sort_order)
--  WHERE NOT EXISTS (
--    SELECT 1 FROM public.job_checklist_defaults d
--     WHERE d.company_id = 'YOUR-COMPANY-ID'::uuid AND d.label = v.label
--  );
