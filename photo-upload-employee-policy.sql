-- ============================================================
-- FIX: employees can't add product photos
-- (the floor page says "uploaded" and the photo never appears)
--
-- WHY IT HAPPENS
-- Adding a photo is two steps: the file goes into storage, then a row
-- goes into product_template_photos so the app knows the photo exists.
-- That table has rules for admins (everything), employees (read only)
-- and customers (read only) — but nobody ever added "employees can add
-- a photo." So step 1 works, step 2 is silently blocked, and the page
-- doesn't check step 2 for an error. Admins never saw it because the
-- admin rule covers everything.
--
-- This is NOT related to the security fixes applied 2026-08-21. It has
-- been this way since the floor upload button shipped.
--
-- Run PART 0 first (read-only). Send me the results. Then PART 1.
-- ============================================================


-- ============================================================
-- PART 0 — READ ONLY. What exists now, and what got orphaned.
-- ============================================================
select 'current rules on product_template_photos' as section,
       policyname as name,
       cmd as applies_to,
       coalesce(qual, '') || coalesce(with_check, '') as rule
from pg_policies
where schemaname = 'public' and tablename = 'product_template_photos'

union all
select 'photo files in storage with no record pointing at them',
       o.name,
       to_char(o.created_at, 'YYYY-MM-DD HH24:MI'),
       'orphan - invisible in the app'
from storage.objects o
where o.bucket_id = 'product-photos'
  and not exists (
    select 1 from public.product_template_photos p
    where p.storage_path = o.name
  )
order by 1, 2;


-- ============================================================
-- PART 1 — THE FIX. One new rule. Nothing else changes.
--
-- Employees may add a photo to a product in their own shop — the same
-- trust level they already have for adding notes to a product. They
-- still cannot edit or delete photos; that stays with admins, matching
-- the buttons the app actually shows them.
-- ============================================================
DROP POLICY IF EXISTS ptphoto_employee_insert ON public.product_template_photos;
CREATE POLICY ptphoto_employee_insert ON public.product_template_photos
  FOR INSERT
  WITH CHECK ((company_id = current_company_id()) AND is_shop_user());


-- ============================================================
-- PART 2 — CHECK IT WORKED (read-only)
-- ============================================================
select case when count(*) = 1 then 'OK' else '*** NOT APPLIED ***' end as status,
       'employees can add product photos' as fix
from pg_policies
where schemaname = 'public'
  and tablename = 'product_template_photos'
  and policyname = 'ptphoto_employee_insert';


-- ============================================================
-- THEN TEST IT, on the floor tablet or as an employee login:
--   1. Open a product on the floor
--   2. Add a photo
--   3. It should appear straight away. Refresh the page to be sure.
-- ============================================================


-- ============================================================
-- OPTIONAL — the 14 orphaned files from the failed attempts
-- (all uploaded 2026-08-19 between 20:59 and 21:07).
--
-- DON'T use SQL for this. Deleting rows from storage.objects removes
-- the record but leaves the actual file sitting in the bucket, so you
-- end up with a different kind of orphan. Use the Supabase Dashboard
-- instead: Storage -> product-photos -> open the folder shown in
-- PART 0 -> select the files dated 2026-08-19 -> Delete. That removes
-- the record and the file together.
--
-- Or leave them. They're 14 small files, invisible in the app, and
-- they cost you nothing.
-- ============================================================


-- ============================================================
-- UNDO, if ever needed:
--   DROP POLICY ptphoto_employee_insert ON public.product_template_photos;
-- ============================================================
