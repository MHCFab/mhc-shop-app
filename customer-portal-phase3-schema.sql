-- ============================================================
-- CUSTOMER PORTAL — PHASE 3: CHANGE REQUESTS
-- Review before running. Run the whole script once in the
-- Supabase SQL Editor. Safe to re-run if something interrupts it.
--
-- What this does, in order:
--   1. Creates job_change_requests — one row per customer request
--      to change an already-approved job. Two kinds:
--        'quantity' — "please change the quantity to N"
--        'cancel'   — "please cancel this job" (for jobs already
--                     released to the shop, which can't be
--                     cancelled online directly)
--      Requests are 'open' until you approve or decline them.
--   2. Enforces AT MOST ONE open request per job (a partial unique
--      index), so double-clicks or races can't stack requests.
--   3. RLS: you (admin) can do everything on your company's rows;
--      customer logins can only READ their own requests. Customers
--      get NO insert/update rights — exactly like orders, all
--      customer writes go through the portal API route using the
--      service role key. Employees have no access (they don't
--      need it).
--   4. Reloads the schema cache (new table — needed).
-- ============================================================


-- ------------------------------------------------------------
-- 1. The table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,

  request_type text NOT NULL CHECK (request_type IN ('quantity', 'cancel')),

  -- Only for 'quantity' requests: the quantity the customer wants.
  requested_quantity integer
    CHECK (requested_quantity IS NULL
           OR (requested_quantity >= 1 AND requested_quantity <= 1000000)),

  -- Optional note from the customer ("we only need 50 now", etc.)
  customer_note text,

  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'approved', 'declined')),

  -- Optional note back to the customer when you approve/decline.
  response_note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- A quantity request must actually carry a quantity.
  CONSTRAINT jcr_quantity_required
    CHECK (request_type <> 'quantity' OR requested_quantity IS NOT NULL)
);


-- ------------------------------------------------------------
-- 2. At most one OPEN request per job
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS jcr_one_open_per_job
  ON public.job_change_requests (job_id)
  WHERE status = 'open';

-- Speeds up "any open requests for my company?" lookups on the
-- Jobs page.
CREATE INDEX IF NOT EXISTS jcr_company_status
  ON public.job_change_requests (company_id, status);


-- ------------------------------------------------------------
-- 3. Row security
-- ------------------------------------------------------------
ALTER TABLE public.job_change_requests ENABLE ROW LEVEL SECURITY;

-- You: full control over your company's requests.
DROP POLICY IF EXISTS jcr_admin_all ON public.job_change_requests;
CREATE POLICY jcr_admin_all ON public.job_change_requests
  FOR ALL
  USING (is_admin() AND company_id = current_company_id())
  WITH CHECK (is_admin() AND company_id = current_company_id());

-- Customer logins: read their own requests only. No insert/update —
-- all customer writes go through /portal/api/orders (service role),
-- same deliberate pattern as orders.
DROP POLICY IF EXISTS jcr_customer_read ON public.job_change_requests;
CREATE POLICY jcr_customer_read ON public.job_change_requests
  FOR SELECT
  USING (
    company_id = current_company_id()
    AND customer_id = current_customer_id()
  );


-- ------------------------------------------------------------
-- 4. Reload the schema cache (then wait ~10 seconds before
--    using the new table from the app)
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- ============================================================
-- VERIFICATION — run this as a separate query afterwards and
-- paste me the results:
--
-- select
--   (select count(*) from information_schema.tables
--     where table_name = 'job_change_requests') as table_exists,
--   (select count(*) from pg_indexes
--     where indexname in ('jcr_one_open_per_job', 'jcr_company_status')) as indexes,
--   (select count(*) from pg_policies
--     where tablename = 'job_change_requests') as policies;
--
-- Expected: table_exists = 1, indexes = 2, policies = 2
-- ============================================================
