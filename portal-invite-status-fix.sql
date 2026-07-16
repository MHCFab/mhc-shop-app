-- ============================================================
-- FIX: invitations stuck on "Awaiting password"
-- Review before running. Run once in the Supabase SQL Editor.
--
-- Cause: setting a password through the reset-password page (or
-- the old broken invite flow) never marked the invitation row
-- 'accepted', so the admin view still shows "Awaiting password"
-- even though the account works.
--
-- This marks any PENDING invitation as accepted when a matching
-- live login already exists (same email + same customer/company).
-- No rows are deleted. Policy-only data fix — no schema change,
-- no cache reload needed.
-- ============================================================

UPDATE public.customer_invitations ci
SET status = 'accepted', accepted_at = now()
FROM public.profiles p
WHERE ci.status = 'pending'
  AND p.role = 'customer'
  AND p.customer_id = ci.customer_id
  AND p.company_id = ci.company_id
  AND lower(p.email) = lower(ci.email);

-- Same cleanup for employee invites, in case any are stuck too.
UPDATE public.employee_invitations ei
SET status = 'accepted', accepted_at = now()
FROM public.profiles p
WHERE ei.status = 'pending'
  AND p.role IN ('admin', 'employee')
  AND p.company_id = ei.company_id
  AND lower(p.email) = lower(ei.email);

-- ============================================================
-- VERIFICATION — run afterwards; both counts should be 0 for
-- anyone who already has a working login:
--
-- select 'customer' as kind, email from public.customer_invitations where status = 'pending'
-- union all
-- select 'employee', email from public.employee_invitations where status = 'pending';
-- ============================================================
