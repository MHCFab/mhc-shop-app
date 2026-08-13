-- ============================================================
-- JOB MESSAGES - per-job customer <-> shop message threads
-- Review before running. Run the whole script once in the
-- Supabase SQL Editor. Safe to re-run if something interrupts it.
--
-- Purely ADDITIVE: creates one new table + its indexes + RLS.
-- Does NOT alter or delete any existing table, column, or row.
--
-- What this does, in order:
--   1. Creates job_messages - one row per message in a job's
--      customer<->shop thread. sender_side says who wrote it
--      ('staff' = you/admin, 'customer' = the portal customer).
--      read_by_staff / read_by_customer drive the unread badges.
--   2. Indexes for fast thread loads and unread lookups.
--   3. RLS: you (admin) can do everything on your company's rows;
--      customer logins can only READ their own jobs' messages.
--      Customers get NO insert/update rights - all customer writes
--      go through the portal API route using the service role key,
--      exactly like orders and change requests.
--   4. Reloads the schema cache (new table - needed).
-- ============================================================


-- ------------------------------------------------------------
-- 1. The table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,

  -- Who wrote the message.
  sender_side text NOT NULL CHECK (sender_side IN ('staff', 'customer')),
  -- The profile that sent it (for display / attribution). Nullable so a
  -- deleted login doesn't take its messages with it.
  sender_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  body text NOT NULL CHECK (btrim(body) <> '' AND char_length(body) <= 4000),

  -- Read receipts, one per side. A message is "unread for staff" when a
  -- customer wrote it and read_by_staff is still false, and vice versa.
  read_by_staff boolean NOT NULL DEFAULT false,
  read_by_customer boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- 2. Indexes
-- ------------------------------------------------------------
-- Fast per-thread load in date order.
CREATE INDEX IF NOT EXISTS job_messages_job_created
  ON public.job_messages (job_id, created_at);

-- "Which of my company's jobs have messages the shop hasn't read yet?"
CREATE INDEX IF NOT EXISTS job_messages_staff_unread
  ON public.job_messages (company_id)
  WHERE sender_side = 'customer' AND read_by_staff = false;

-- "Which of my jobs have messages I (the customer) haven't read yet?"
CREATE INDEX IF NOT EXISTS job_messages_customer_unread
  ON public.job_messages (customer_id)
  WHERE sender_side = 'staff' AND read_by_customer = false;


-- ------------------------------------------------------------
-- 3. Row security
-- ------------------------------------------------------------
ALTER TABLE public.job_messages ENABLE ROW LEVEL SECURITY;

-- You: full control over your company's messages.
DROP POLICY IF EXISTS job_messages_admin_all ON public.job_messages;
CREATE POLICY job_messages_admin_all ON public.job_messages
  FOR ALL
  USING (is_admin() AND company_id = current_company_id())
  WITH CHECK (is_admin() AND company_id = current_company_id());

-- Customer logins: read the messages on their own jobs only. No insert or
-- update - all customer writes go through /portal/api/messages (service
-- role), the same deliberate pattern as orders and change requests.
DROP POLICY IF EXISTS job_messages_customer_read ON public.job_messages;
CREATE POLICY job_messages_customer_read ON public.job_messages
  FOR SELECT
  USING (
    company_id = current_company_id()
    AND customer_id = current_customer_id()
  );


-- ------------------------------------------------------------
-- 4. Reload the schema cache (then wait ~10 seconds before the
--    app uses the new table)
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- ============================================================
-- VERIFICATION - run this separately afterwards; expect
-- table_exists = 1, indexes = 3, policies = 2, rls_enabled = t
--
-- select
--   (select count(*) from information_schema.tables
--     where table_schema = 'public' and table_name = 'job_messages') as table_exists,
--   (select count(*) from pg_indexes
--     where indexname in ('job_messages_job_created',
--                         'job_messages_staff_unread',
--                         'job_messages_customer_unread')) as indexes,
--   (select count(*) from pg_policies
--     where tablename = 'job_messages') as policies,
--   (select relrowsecurity from pg_class
--     where oid = 'public.job_messages'::regclass) as rls_enabled;
-- ============================================================
