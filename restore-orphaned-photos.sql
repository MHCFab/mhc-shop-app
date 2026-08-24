-- ============================================================
-- RESTORE THE ORPHANED PHOTOS
-- Point the files uploaded 2026-08-19 at the product they belong to,
-- so they show up in the app instead of sitting invisible in storage.
--
-- HOW THIS WORKS
-- Every photo is stored at  <shop id>/<product id>/<file name>
-- so the folder a file sits in already says which product it belongs
-- to. Nothing has to be guessed and no file moves — we just create the
-- database row that was blocked when the employee uploaded it.
--
-- Run PART 0 first and look at the list. Then run EITHER option in
-- PART 1 — not both.
--
-- NOTE: run photo-upload-employee-policy.sql first if you haven't.
-- Otherwise the same thing happens again the next time the crew
-- uploads a photo.
-- ============================================================


-- ============================================================
-- PART 0 — READ ONLY. What would be restored, and what's a duplicate.
--
-- Files that are the same size are almost certainly the same photo
-- uploaded again — they'll share a "dup_group" number. If every row
-- shows the same dup_group, it was one photo uploaded 14 times.
-- ============================================================
with orphans as materialized (
  select o.name,
         o.created_at,
         coalesce((o.metadata ->> 'size')::bigint, 0) as bytes,
         (storage.foldername(o.name))[1] as shop_folder,
         (storage.foldername(o.name))[2] as product_folder
  from storage.objects o
  where o.bucket_id = 'product-photos'
    and not exists (
      select 1 from public.product_template_photos p
      where p.storage_path = o.name
    )
    and (storage.foldername(o.name))[2] ~ '^[0-9a-fA-F-]{36}$'
)
select dense_rank() over (order by orphans.bytes) as dup_group,
       round(orphans.bytes / 1024.0) || ' KB' as size,
       to_char(orphans.created_at, 'Mon DD HH24:MI:SS') as uploaded,
       coalesce(t.name, '*** product not found ***') as goes_on_product,
       orphans.name as file
from orphans
left join public.product_templates t
  on t.id = orphans.product_folder::uuid
 and t.company_id = orphans.shop_folder::uuid
order by dup_group, uploaded;


-- ============================================================
-- PART 1 — PICK ONE OPTION. Don't run both.
-- ============================================================

-- ------------------------------------------------------------
-- OPTION A — restore ONE photo per duplicate group (recommended)
--
-- Keeps the earliest upload of each identical-size file and leaves the
-- rest orphaned. If the crew really did upload the same photo 14 times,
-- this gives you one clean photo instead of fourteen copies.
-- ------------------------------------------------------------
with orphans as materialized (
  select o.name,
         o.created_at,
         coalesce((o.metadata ->> 'size')::bigint, 0) as bytes,
         (storage.foldername(o.name))[1] as shop_folder,
         (storage.foldername(o.name))[2] as product_folder
  from storage.objects o
  where o.bucket_id = 'product-photos'
    and not exists (
      select 1 from public.product_template_photos p
      where p.storage_path = o.name
    )
    and (storage.foldername(o.name))[2] ~ '^[0-9a-fA-F-]{36}$'
),
keepers as (
  select distinct on (product_folder, bytes) *
  from orphans
  order by product_folder, bytes, created_at
)
insert into public.product_template_photos
  (company_id, product_template_id, storage_path, caption, sort_order)
select t.company_id,
       t.id,
       k.name,
       null,
       coalesce((select max(p2.sort_order)
                 from public.product_template_photos p2
                 where p2.product_template_id = t.id), -1)
       + row_number() over (partition by t.id order by k.created_at)
from keepers k
join public.product_templates t
  on t.id = k.product_folder::uuid
 and t.company_id = k.shop_folder::uuid;


-- ------------------------------------------------------------
-- OPTION B — restore ALL of them
--
-- Use this if PART 0 shows several different dup_group numbers and you
-- want everything back. You can delete any extras afterwards from the
-- product's Photos tab in the app, which removes the file too.
-- ------------------------------------------------------------
-- with orphans as materialized (
--   select o.name,
--          o.created_at,
--          (storage.foldername(o.name))[1] as shop_folder,
--          (storage.foldername(o.name))[2] as product_folder
--   from storage.objects o
--   where o.bucket_id = 'product-photos'
--     and not exists (
--       select 1 from public.product_template_photos p
--       where p.storage_path = o.name
--     )
--     and (storage.foldername(o.name))[2] ~ '^[0-9a-fA-F-]{36}$'
-- )
-- insert into public.product_template_photos
--   (company_id, product_template_id, storage_path, caption, sort_order)
-- select t.company_id,
--        t.id,
--        orphans.name,
--        null,
--        coalesce((select max(p2.sort_order)
--                  from public.product_template_photos p2
--                  where p2.product_template_id = t.id), -1)
--        + row_number() over (partition by t.id order by orphans.created_at)
-- from orphans
-- join public.product_templates t
--   on t.id = orphans.product_folder::uuid
--  and t.company_id = orphans.shop_folder::uuid;


-- ============================================================
-- PART 2 — CHECK IT (read-only)
-- Shows how many photos that product now has, and how many files are
-- still orphaned.
-- ============================================================
select t.name as product,
       count(p.id) as photos_now_showing
from public.product_templates t
join public.product_template_photos p on p.product_template_id = t.id
group by t.name

union all
select '--- files still orphaned in storage ---',
       (select count(*)
        from storage.objects o
        where o.bucket_id = 'product-photos'
          and not exists (
            select 1 from public.product_template_photos p
            where p.storage_path = o.name
          ))
order by 1;


-- ============================================================
-- THEN LOOK: open that product's Photos tab in the app, and the floor
-- product page. The photos should be there.
--
-- TO UNDO: delete them from the Photos tab in the app like any other
-- photo. That removes the record and the file together, which is
-- cleaner than undoing this in SQL.
-- ============================================================
