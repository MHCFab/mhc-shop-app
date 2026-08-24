-- ============================================================
-- SHOPWORKS SECURITY FIXES — from the P0 audit, 2026-08-21
--
-- ***  DO NOT RUN THE WHOLE FILE.  ***
-- PART 0 is read-only. Run it first and send me the results.
-- PART 1 makes the changes. Only run it after I confirm PART 0 is clean.
--
-- What PART 1 changes, in plain language:
--   1. Switching someone off on the Employees page now actually cuts off
--      ALL their access. Today they keep raw material stock and inventory
--      reservations until their login is deleted.
--   2. Customer portal logins can no longer read your stock levels or write
--      into your inventory, cutting nest, or material variance tables.
--      (Nothing in the portal ever did this — the door was just unlocked.)
--   3. The "mark my invitation accepted" rule stops reaching across shops.
--   4. Product photos become shop-private. Right now ANY signed-in user can
--      view, upload and DELETE any photo in the bucket.
--
-- What it does NOT touch: no tables, no columns, no data, no app code.
-- Only rules and one function. Rule changes take effect immediately —
-- no schema reload, no redeploy.
--
-- Every change is written so YOUR access and your employees' access is
-- exactly what it is today. Nothing you can do now stops working.
-- ============================================================


-- ============================================================
-- ============ PART 0 — PRE-FLIGHT (READ ONLY) ===============
-- Run this by itself. Send me the result. Three things must be true
-- before PART 1 is safe, and this checks all three.
-- ============================================================
select 'A. logins that would LOSE access (must be 0)' as check_name,
       count(*)::text as result,
       coalesce(string_agg(email, ', '), '-') as detail
from public.profiles
where is_active is distinct from true

union all
select 'B. is_active default (must be true, not null)',
       coalesce(column_default::text, 'NO DEFAULT'),
       'nullable: ' || is_nullable::text
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_active'

union all
select 'C. photos NOT filed under a real shop (must be 0)',
       count(*)::text,
       coalesce(string_agg(distinct coalesce((storage.foldername(name))[1], '(root)'), ', '), '-')
from storage.objects
where bucket_id = 'product-photos'
  and coalesce((storage.foldername(name))[1], '') not in (select id::text from public.companies);


-- ============================================================
-- ============ PART 1 — THE FIXES ============================
-- Run this ONLY after PART 0 comes back clean. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- FIX 1 — deactivated logins lose access everywhere
--
-- current_company_id() answers "which shop is this person in?" and every
-- rule in the database leans on it. Its three sibling functions all check
-- that the account is still active; this one never did. One line closes it
-- on every table at once.
--
-- WAS: SELECT company_id FROM profiles WHERE id = auth.uid();
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_company_id()
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT company_id FROM profiles
  WHERE id = auth.uid()
    AND is_active = true;
$function$;


-- ------------------------------------------------------------
-- FIX 2 — eight rules become shop-STAFF-only, not just same-shop
--
-- These eight say "same shop" and stop there, so a customer portal login
-- passes them. is_shop_user() means "an active admin or employee of this
-- shop" — the exact guard every other rule already uses. Your access and
-- your employees' access is unchanged.
-- ------------------------------------------------------------

-- Cutting nest: employees log cuts from the floor
ALTER POLICY cutting_nest_entries_employee_insert ON public.cutting_nest_entries
  WITH CHECK ((company_id = current_company_id()) AND is_shop_user());

-- Inventory reservations: read, create, adjust
ALTER POLICY inventory_allocations_employee_select ON public.inventory_allocations
  USING ((company_id = current_company_id()) AND is_shop_user());

ALTER POLICY inventory_allocations_employee_insert ON public.inventory_allocations
  WITH CHECK ((company_id = current_company_id()) AND is_shop_user());

ALTER POLICY inventory_allocations_employee_update ON public.inventory_allocations
  USING ((company_id = current_company_id()) AND is_shop_user())
  WITH CHECK ((company_id = current_company_id()) AND is_shop_user());

-- Extra material used on a job
ALTER POLICY job_material_variances_employee_insert ON public.job_material_variances
  WITH CHECK ((company_id = current_company_id()) AND is_shop_user());

-- Who acknowledged which job notes
ALTER POLICY job_note_ack_employee_select ON public.job_note_acknowledgments
  USING ((company_id = current_company_id()) AND is_shop_user());

-- Raw material stock: the floor reads it and logs scrap into it
ALTER POLICY raw_material_inventory_employee_select ON public.raw_material_inventory
  USING ((company_id = current_company_id()) AND is_shop_user());

ALTER POLICY raw_material_inventory_employee_insert ON public.raw_material_inventory
  WITH CHECK ((company_id = current_company_id()) AND is_shop_user());


-- ------------------------------------------------------------
-- FIX 3 — invitations stop reaching across shops
--
-- These let a person mark their own invitation accepted when they set
-- their password (they aren't an admin at that moment, so they need their
-- own rule). They matched on email address ALONE — no shop check — which
-- is the only rule in the whole database that could touch another shop's
-- row. Adding the shop check and "still pending" keeps the accept flow
-- working exactly as it does today: the app already filters on pending,
-- and the person IS signed in to their own shop at that moment.
-- ------------------------------------------------------------
ALTER POLICY employee_invitations_self_accept ON public.employee_invitations
  USING (
    company_id = current_company_id()
    AND status = 'pending'
    AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  WITH CHECK (
    company_id = current_company_id()
    AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

ALTER POLICY customer_invitations_self_accept ON public.customer_invitations
  USING (
    company_id = current_company_id()
    AND status = 'pending'
    AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  WITH CHECK (
    company_id = current_company_id()
    AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );


-- ------------------------------------------------------------
-- FIX 4 — product photos become shop-private
--
-- Today all three rules say only "is this the product-photos bucket?", so
-- ANY signed-in user — including a customer portal login, and tomorrow any
-- other shop — can view, upload and DELETE every photo in it.
--
-- Nothing moves: every photo is already stored at
--     <shop id>/<product id>/<file>
-- so checking the first folder against the caller's shop is enough.
--
-- Who gets what, matching what your app actually does:
--   view   - shop staff (the portal never shows photos)
--   upload - shop staff (admin Photos tab + the floor product page)
--   delete - admins only (the admin Photos tab is the only delete button)
-- If you'd rather employees could delete photos too, say so and I'll swap
-- is_admin() for is_shop_user() on the delete rule.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can view product photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload product photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete product photos" ON storage.objects;

DROP POLICY IF EXISTS "Shop staff can view their own product photos" ON storage.objects;
CREATE POLICY "Shop staff can view their own product photos"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'product-photos'
    AND (storage.foldername(name))[1] = current_company_id()::text
    AND is_shop_user()
  );

DROP POLICY IF EXISTS "Shop staff can upload their own product photos" ON storage.objects;
CREATE POLICY "Shop staff can upload their own product photos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'product-photos'
    AND (storage.foldername(name))[1] = current_company_id()::text
    AND is_shop_user()
  );

DROP POLICY IF EXISTS "Shop admins can delete their own product photos" ON storage.objects;
CREATE POLICY "Shop admins can delete their own product photos"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'product-photos'
    AND (storage.foldername(name))[1] = current_company_id()::text
    AND is_admin()
  );


-- ============================================================
-- ============ PART 2 — CHECK IT WORKED (READ ONLY) ==========
-- Run this after PART 1. Every line should say OK.
-- ============================================================
select case when (select count(*) from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'current_company_id'
                    and pg_get_functiondef(p.oid) like '%is_active%') = 1
            then 'OK' else '*** NOT APPLIED ***' end as status,
       'FIX 1 - deactivated logins are cut off' as fix

union all
select case when (select count(*) from pg_policies
                  where schemaname = 'public'
                    and policyname in (
                      'cutting_nest_entries_employee_insert',
                      'inventory_allocations_employee_select',
                      'inventory_allocations_employee_insert',
                      'inventory_allocations_employee_update',
                      'job_material_variances_employee_insert',
                      'job_note_ack_employee_select',
                      'raw_material_inventory_employee_select',
                      'raw_material_inventory_employee_insert')
                    and coalesce(qual, '') || coalesce(with_check, '') like '%is_shop_user%') = 8
            then 'OK' else '*** NOT APPLIED ***' end,
       'FIX 2 - all 8 staff rules are staff-only'

union all
select case when (select count(*) from pg_policies
                  where schemaname = 'public'
                    and policyname like '%_self_accept'
                    and coalesce(qual, '') like '%company_id%') = 2
            then 'OK' else '*** NOT APPLIED ***' end,
       'FIX 3 - invitations are shop-scoped'

union all
select case when (select count(*) from pg_policies
                  where schemaname = 'storage'
                    and coalesce(qual, '') || coalesce(with_check, '') like '%current_company_id%') = 3
            then 'OK' else '*** NOT APPLIED ***' end,
       'FIX 4 - photos are shop-private'

order by 2;


-- ============================================================
-- HOW TO UNDO, if anything misbehaves. Each of these puts one fix
-- back exactly the way it was before.
-- ============================================================
--
-- UNDO FIX 1:
--   CREATE OR REPLACE FUNCTION public.current_company_id()
--    RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
--   AS $function$ SELECT company_id FROM profiles WHERE id = auth.uid(); $function$;
--
-- UNDO FIX 2 (drop "AND is_shop_user()" from each), e.g.:
--   ALTER POLICY raw_material_inventory_employee_select ON public.raw_material_inventory
--     USING (company_id = current_company_id());
--
-- UNDO FIX 3:
--   ALTER POLICY employee_invitations_self_accept ON public.employee_invitations
--     USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
--     WITH CHECK (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
--   (same for customer_invitations_self_accept)
--
-- UNDO FIX 4:
--   DROP the three new policies and recreate the old ones:
--   CREATE POLICY "Authenticated users can view product photos"
--     ON storage.objects FOR SELECT TO authenticated
--     USING (bucket_id = 'product-photos');   -- and the same shape for INSERT / DELETE
-- ============================================================
