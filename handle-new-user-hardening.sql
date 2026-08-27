-- ===========================================================================
-- ShopWorks — harden the new-user trigger
-- ===========================================================================
-- WHAT THIS FIXES
--
-- Today, when a login is created, the trigger `handle_new_user` copies the
-- role and the shop straight out of the sign-up request and writes them into
-- the profiles table without checking anything. Whoever creates the login gets
-- to say "I am an admin of shop X" and the database believes it.
--
-- That is safe ONLY because you turned public sign-up off on 2026-08-22. The
-- day self-serve sign-up ships, it stops being safe: anyone could register
-- themselves as an admin of any shop whose id they can see (and every signed-in
-- user can read their own profile row, which contains their shop id).
--
-- After this change the trigger no longer takes anybody's word for it:
--   * the role is NEVER read from the sign-up request — it is decided by which
--     kind of invitation matched, so nobody can ever sign themselves up as an
--     admin;
--   * the shop is taken from the INVITATION ROW, not from the sign-up request,
--     so even a forged request lands in the shop that actually invited them —
--     which, for a forged request, is no shop at all;
--   * if there is no pending invitation for that email address, no account is
--     created. The sign-up fails.
--
-- ---------------------------------------------------------------------------
-- ORDER OF OPERATIONS — THIS MATTERS
-- ---------------------------------------------------------------------------
-- The app code MUST be deployed BEFORE you run this file.
--
-- The two invite routes used to send the invite first and record the
-- invitation row afterwards. The invite email is what creates the login, so
-- with the old order the trigger would run BEFORE the invitation row existed,
-- find nothing, and refuse every invite. The updated routes record the
-- invitation first. Deploy them, then run this.
--
-- ---------------------------------------------------------------------------
-- IF YOU EVER NEED TO CREATE A LOGIN BY HAND (your way back in)
-- ---------------------------------------------------------------------------
-- Creating a user in the Supabase dashboard will now be REFUSED unless a
-- pending invitation exists for that email. To do it by hand, run this first:
--
--   INSERT INTO public.employee_invitations (company_id, email, status)
--   VALUES ('<your-company-id>', 'the.email@example.com', 'pending');
--
-- then create the user in the dashboard, then promote them if needed:
--
--   UPDATE public.profiles SET role = 'admin' WHERE email = 'the.email@example.com';
--
-- (There is no admin invitation path in the app, on purpose. A second admin is
-- invited as an employee and then promoted with that one line of SQL.)
--
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- PART 0 — LOOK BEFORE YOU LEAP (read-only, run this first)
-- ---------------------------------------------------------------------------
-- 0a. The trigger function as it exists RIGHT NOW. Copy the result somewhere
--     safe — it is your undo.
SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) AS current_definition;

-- 0b. Confirm the trigger is still the only one on the login table, and still
--     AFTER INSERT only.
SELECT tgname, tgtype, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'auth.users'::regclass
  AND NOT tgisinternal;

-- 0c. Any logins currently sitting in profiles with no shop attached? Should
--     be zero. Anything here is an account that already can't see anything.
SELECT id, email, role, company_id, is_active
FROM public.profiles
WHERE company_id IS NULL;

-- 0d. Pending invitations right now (these are the ones that will still work
--     after the change).
SELECT 'employee' AS kind, email, company_id, status, created_at
FROM public.employee_invitations WHERE status = 'pending'
UNION ALL
SELECT 'customer' AS kind, email, company_id, status, created_at
FROM public.customer_invitations WHERE status = 'pending'
ORDER BY created_at DESC;


-- ---------------------------------------------------------------------------
-- PART 1 — THE CHANGE
-- ---------------------------------------------------------------------------
-- Run this only after PART 0 looks the way you expect AND the updated invite
-- routes are deployed.

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  claimed_role      TEXT;
  normalized_email  TEXT;
  granted_company   UUID;
  granted_customer  UUID;
  granted_role      TEXT;
  invite_full_name  TEXT;
BEGIN
  -- The email address is the only thing we trust from the sign-up request,
  -- because Supabase owns it. Everything else has to be earned by an
  -- invitation row that a signed-in admin of a real shop created.
  normalized_email := lower(trim(COALESCE(NEW.email, '')));

  -- We read the requested role only to know WHICH invitation list to search.
  -- It never becomes the stored role by itself.
  claimed_role := lower(trim(COALESCE(NEW.raw_user_meta_data->>'role', 'employee')));

  IF claimed_role = 'customer' THEN
    SELECT ci.company_id, ci.customer_id, ci.full_name
      INTO granted_company, granted_customer, invite_full_name
      FROM public.customer_invitations ci
     WHERE lower(trim(ci.email)) = normalized_email
       AND ci.status = 'pending'
     ORDER BY ci.created_at DESC
     LIMIT 1;

    granted_role := 'customer';
  ELSE
    -- Anything that is not a customer invite is treated as an employee
    -- invite. Note there is no branch that can ever produce 'admin'.
    SELECT ei.company_id, ei.full_name
      INTO granted_company, invite_full_name
      FROM public.employee_invitations ei
     WHERE lower(trim(ei.email)) = normalized_email
       AND ei.status = 'pending'
     ORDER BY ei.created_at DESC
     LIMIT 1;

    granted_customer := NULL;
    granted_role := 'employee';
  END IF;

  -- No pending invitation means nobody with authority asked for this account.
  -- Refuse it outright: no login, no profile, nothing left behind.
  IF granted_company IS NULL THEN
    RAISE EXCEPTION
      'ShopWorks: no pending invitation for %. Account not created.',
      normalized_email
      USING ERRCODE = 'check_violation';
  END IF;

  -- A customer invitation without a customer attached is a broken row; refuse
  -- rather than create a portal login that belongs to nobody.
  IF granted_role = 'customer' AND granted_customer IS NULL THEN
    RAISE EXCEPTION
      'ShopWorks: customer invitation for % has no customer attached. Account not created.',
      normalized_email
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, role, company_id, customer_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
      NULLIF(trim(COALESCE(invite_full_name, '')), ''),
      ''
    ),
    granted_role,
    granted_company,
    granted_customer
  );

  RETURN NEW;
END;
$function$;


-- ---------------------------------------------------------------------------
-- PART 2 — VERIFY (read-only)
-- ---------------------------------------------------------------------------
-- 2a. The function should now contain the words 'no pending invitation'
--     and should NOT contain the word 'invited_role'.
SELECT
  CASE WHEN pg_get_functiondef('public.handle_new_user()'::regprocedure)
            LIKE '%no pending invitation%'
       THEN 'OK — hardened version is live'
       ELSE 'PROBLEM — still the old version' END AS check_1_new_version,
  CASE WHEN pg_get_functiondef('public.handle_new_user()'::regprocedure)
            LIKE '%invited_role%'
       THEN 'PROBLEM — old variables still present'
       ELSE 'OK — old trust-the-request path is gone' END AS check_2_old_gone;

-- 2b. Still SECURITY DEFINER with a pinned search_path (the classic escalation
--     hole stays shut).
SELECT p.proname,
       p.prosecdef AS security_definer,
       p.proconfig AS settings
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'handle_new_user';

-- 2c. Nobody's existing profile was touched — this should return the same
--     numbers as before the change.
SELECT role, count(*) AS logins, count(*) FILTER (WHERE company_id IS NULL) AS no_shop
FROM public.profiles
GROUP BY role
ORDER BY role;


-- ---------------------------------------------------------------------------
-- THE TEST THAT ACTUALLY MATTERS
-- ---------------------------------------------------------------------------
-- After running PART 1, invite a real employee to a spare email address you
-- control, from the Employees page, and accept it end to end. If it works,
-- this is done. If it fails, run the UNDO below and tell me the error.


-- ---------------------------------------------------------------------------
-- UNDO — puts the old behavior back exactly
-- ---------------------------------------------------------------------------
-- Only run this if invites break.
/*
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
*/
