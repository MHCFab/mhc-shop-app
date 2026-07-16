-- ============================================================
-- CUSTOMER PORTAL — PHASE 1 FOUNDATION SCHEMA
-- Review before running. Run the whole script once in the
-- Supabase SQL Editor. Safe to re-run if something interrupts it.
--
-- What this does, in order:
--   1. Adds two new job statuses: 'pending' (customer order awaiting
--      your approval) and 'cancelled' (kept as a record, not deleted),
--      plus columns recording who cancelled and when.
--   2. Allows a third login role: 'customer'.
--   3. Adds profiles.customer_id — links a customer login to a row on
--      your Customers page. Staff logins must leave it empty; customer
--      logins must have it (enforced by a rule).
--   4. Teaches the new-user trigger to copy that customer link from
--      the invite.
--   5. Adds two helper functions: is_shop_user() (admin or employee,
--      active) and current_customer_id() (which customer a login
--      belongs to; empty for staff).
--   6. SECURITY FIX: adds "and is a shop user" to every rule that
--      currently says only "belongs to this company". Without this, a
--      customer login could read your inventory, costs, all customers'
--      jobs — and even EDIT jobs and tasks. After this, deactivated
--      employees also lose access (matching how is_admin already works).
--   7. Gives customer logins narrow read-only access: their own jobs +
--      line items, their own product templates + photos, and their own
--      customer record. Nothing else. (Ordering/cancelling come in the
--      next session.)
--   8. Creates the missing employee_invitations table your app already
--      expects (fixes the silently-empty pending-invites list) and a
--      matching customer_invitations table.
--   9. Reloads the schema cache.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Job statuses: add 'pending' and 'cancelled'
-- ------------------------------------------------------------
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text, 'ordered'::text, 'ready'::text,
    'in_progress'::text, 'complete'::text, 'cancelled'::text
  ]));

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS cancelled_by uuid
  REFERENCES public.profiles(id) ON DELETE SET NULL;


-- ------------------------------------------------------------
-- 2. Allow the 'customer' role
-- ------------------------------------------------------------
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'employee'::text, 'customer'::text]));


-- ------------------------------------------------------------
-- 3. Link customer logins to a customer record
-- ------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS customer_id uuid
  REFERENCES public.customers(id) ON DELETE CASCADE;

-- Customer logins must point at a customer; staff logins must not.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_customer_link_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_customer_link_check
  CHECK (
    (role = 'customer' AND customer_id IS NOT NULL)
    OR (role <> 'customer' AND customer_id IS NULL)
  );


-- ------------------------------------------------------------
-- 4. New-user trigger: carry the customer link from the invite
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  invited_company_id UUID;
  invited_role TEXT;
  invited_customer_id UUID;
BEGIN
  -- Pull company_id, role, and customer_id from user metadata if provided during invite
  invited_company_id := (NEW.raw_user_meta_data->>'company_id')::UUID;
  invited_role := COALESCE(NEW.raw_user_meta_data->>'role', 'employee');
  invited_customer_id := (NEW.raw_user_meta_data->>'customer_id')::UUID;
  INSERT INTO public.profiles (id, email, full_name, role, company_id, customer_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    invited_role,
    invited_company_id,
    invited_customer_id
  );
  RETURN NEW;
END;
$function$;


-- ------------------------------------------------------------
-- 5. Helper functions (built like your existing is_admin)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_shop_user()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'employee')
      AND is_active = true
  );
$function$;

CREATE OR REPLACE FUNCTION public.current_customer_id()
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT customer_id FROM public.profiles
  WHERE id = auth.uid()
    AND role = 'customer'
    AND is_active = true;
$function$;


-- ------------------------------------------------------------
-- 6. SECURITY FIX: company-wide rules become shop-staff-only.
--    Same access as today for you and your employees; customer
--    logins are excluded from all of these.
-- ------------------------------------------------------------
ALTER POLICY companies_self_read ON public.companies
  USING (id = current_company_id() AND is_shop_user());

ALTER POLICY customers_employee_read ON public.customers
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY cutting_nest_entries_employee_read ON public.cutting_nest_entries
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY job_line_items_employee_read ON public.job_line_items
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY job_material_variances_employee_read ON public.job_material_variances
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY job_material_variances_employee_insert ON public.job_material_variances
  WITH CHECK (company_id = current_company_id() AND is_shop_user());

ALTER POLICY job_pick_list_employee_read ON public.job_pick_list_items
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY job_tasks_employee_read ON public.job_tasks
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY job_tasks_employee_update ON public.job_tasks
  USING (company_id = current_company_id() AND is_shop_user())
  WITH CHECK (company_id = current_company_id() AND is_shop_user());

ALTER POLICY jobs_employee_read ON public.jobs
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY jobs_employee_update ON public.jobs
  USING (company_id = current_company_id() AND is_shop_user())
  WITH CHECK (company_id = current_company_id() AND is_shop_user());

ALTER POLICY ptm_employee_read ON public.product_template_materials
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY ptnotes_employee_read ON public.product_template_notes
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY ptnotes_employee_insert ON public.product_template_notes
  WITH CHECK (company_id = current_company_id() AND is_shop_user());

ALTER POLICY ptp_employee_read ON public.product_template_parts
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY ptphoto_employee_read ON public.product_template_photos
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY ptsa_employee_read ON public.product_template_sub_assemblies
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY ptt_employee_read ON public.product_template_tasks
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY product_templates_employee_read ON public.product_templates
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY purchased_parts_employee_read ON public.purchased_parts
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY raw_materials_employee_read ON public.raw_materials
  USING (company_id = current_company_id() AND is_shop_user());

ALTER POLICY time_entries_own ON public.time_entries
  USING (employee_id = auth.uid() AND company_id = current_company_id() AND is_shop_user())
  WITH CHECK (employee_id = auth.uid() AND company_id = current_company_id() AND is_shop_user());


-- ------------------------------------------------------------
-- 7. Customer read-only access (empty for staff logins, since
--    current_customer_id() is null for them)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS jobs_customer_read ON public.jobs;
CREATE POLICY jobs_customer_read ON public.jobs
  FOR SELECT
  USING (
    company_id = current_company_id()
    AND customer_id = current_customer_id()
  );

DROP POLICY IF EXISTS job_line_items_customer_read ON public.job_line_items;
CREATE POLICY job_line_items_customer_read ON public.job_line_items
  FOR SELECT
  USING (
    company_id = current_company_id()
    AND EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = job_line_items.job_id
        AND j.customer_id = current_customer_id()
    )
  );

DROP POLICY IF EXISTS product_templates_customer_read ON public.product_templates;
CREATE POLICY product_templates_customer_read ON public.product_templates
  FOR SELECT
  USING (
    company_id = current_company_id()
    AND customer_id = current_customer_id()
    AND is_active = true
  );

DROP POLICY IF EXISTS ptphoto_customer_read ON public.product_template_photos;
CREATE POLICY ptphoto_customer_read ON public.product_template_photos
  FOR SELECT
  USING (
    company_id = current_company_id()
    AND EXISTS (
      SELECT 1 FROM public.product_templates t
      WHERE t.id = product_template_photos.product_template_id
        AND t.customer_id = current_customer_id()
    )
  );

DROP POLICY IF EXISTS customers_customer_self_read ON public.customers;
CREATE POLICY customers_customer_self_read ON public.customers
  FOR SELECT
  USING (
    company_id = current_company_id()
    AND id = current_customer_id()
  );


-- ------------------------------------------------------------
-- 8. Invitation tracking tables
-- ------------------------------------------------------------
-- The table your app already writes to and reads from, but which
-- never existed (fixes the silently-empty pending-invites list on
-- the Employees page).
CREATE TABLE IF NOT EXISTS public.employee_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text,
  invited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);

ALTER TABLE public.employee_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_invitations_admin_all ON public.employee_invitations;
CREATE POLICY employee_invitations_admin_all ON public.employee_invitations
  FOR ALL
  USING (is_admin() AND company_id = current_company_id())
  WITH CHECK (is_admin() AND company_id = current_company_id());

-- Lets the invited person mark their own invite accepted when they
-- set their password (they aren't an admin at that moment).
DROP POLICY IF EXISTS employee_invitations_self_accept ON public.employee_invitations;
CREATE POLICY employee_invitations_self_accept ON public.employee_invitations
  FOR UPDATE
  USING (lower(email) = lower(coalesce(auth.jwt()->>'email', '')))
  WITH CHECK (lower(email) = lower(coalesce(auth.jwt()->>'email', '')));

-- Same thing for customer invites, plus which customer they belong to.
CREATE TABLE IF NOT EXISTS public.customer_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text,
  invited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);

ALTER TABLE public.customer_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_invitations_admin_all ON public.customer_invitations;
CREATE POLICY customer_invitations_admin_all ON public.customer_invitations
  FOR ALL
  USING (is_admin() AND company_id = current_company_id())
  WITH CHECK (is_admin() AND company_id = current_company_id());

DROP POLICY IF EXISTS customer_invitations_self_accept ON public.customer_invitations;
CREATE POLICY customer_invitations_self_accept ON public.customer_invitations
  FOR UPDATE
  USING (lower(email) = lower(coalesce(auth.jwt()->>'email', '')))
  WITH CHECK (lower(email) = lower(coalesce(auth.jwt()->>'email', '')));


-- ------------------------------------------------------------
-- 9. Reload the schema cache (then wait ~10 seconds)
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- ============================================================
-- VERIFICATION — run this as a separate query afterwards and
-- paste me the results:
--
-- select
--   (select pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'jobs_status_check') as job_statuses,
--   (select pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'profiles_role_check') as roles,
--   (select count(*) from pg_policies
--     where schemaname = 'public' and qual like '%is_shop_user%') as guarded_policies,
--   (select count(*) from pg_policies
--     where schemaname = 'public' and policyname like '%customer%') as customer_policies,
--   (select count(*) from information_schema.tables
--     where table_name in ('employee_invitations','customer_invitations')) as invite_tables;
-- ============================================================
