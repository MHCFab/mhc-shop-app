-- ============================================================
-- Phase 2: Snapshot custom jobs to archive for reproducibility
-- Creates three tables that store a custom job's full "recipe"
-- (materials, parts, tasks) at the moment it's invoiced, so a
-- once-a-year repeat part can be rebuilt from history.
--
-- Design: store the live item IDs where they exist (so re-picking
-- uses current inventory + costing) PLUS a text fallback for
-- everything, so history still reads correctly if an item is later
-- deleted. No foreign keys to raw_materials / purchased_parts on
-- purpose, so a deleted catalog item never breaks the archive.
--
-- Scoped to MHC Fab. Review, then run in the Supabase SQL Editor.
-- Company: 86aecd1e-d42c-43c0-976d-44189c1eb1b9
-- ============================================================

-- ---------- 1) Recipe header (one row per invoiced custom job) ----------
create table if not exists public.archived_job_recipes (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null,
  -- Link back to the cost summary row (nullable; ON DELETE SET NULL so
  -- removing a summary never deletes the recipe).
  completed_job_archive_id  uuid references public.completed_jobs_archive(id) on delete set null,
  job_number                text not null,
  line_item_name            text,            -- the custom build description ("what you're building")
  customer_name             text,
  customer_po               text,
  quantity                  numeric not null default 1,   -- job units this recipe was built for
  unit_price                numeric,         -- custom per-unit price at invoice time
  job_notes                 text,
  invoiced_on               date not null default current_date,
  created_at                timestamptz not null default now()
);

create index if not exists archived_job_recipes_company_idx
  on public.archived_job_recipes (company_id);
create index if not exists archived_job_recipes_archive_idx
  on public.archived_job_recipes (completed_job_archive_id);

-- ---------- 2) Recipe items (pick-list materials + parts) ----------
create table if not exists public.archived_job_recipe_items (
  id                  uuid primary key default gen_random_uuid(),
  recipe_id           uuid not null references public.archived_job_recipes(id) on delete cascade,
  company_id          uuid not null,
  item_type           text not null check (item_type in ('raw_material','purchased_part')),
  raw_material_id     uuid,                 -- live id if it still existed at snapshot time (no FK on purpose)
  purchased_part_id   uuid,
  description         text not null,        -- human-readable fallback (material desc or part name)
  part_number         text,                 -- for purchased parts
  planned_quantity    numeric not null default 0,
  actual_quantity     numeric not null default 0,
  unit                text not null default 'ea',
  notes               text,
  sort_order          integer not null default 0
);

create index if not exists archived_job_recipe_items_recipe_idx
  on public.archived_job_recipe_items (recipe_id);
create index if not exists archived_job_recipe_items_company_idx
  on public.archived_job_recipe_items (company_id);

-- ---------- 3) Recipe tasks ----------
create table if not exists public.archived_job_recipe_tasks (
  id                        uuid primary key default gen_random_uuid(),
  recipe_id                 uuid not null references public.archived_job_recipes(id) on delete cascade,
  company_id                uuid not null,
  name                      text not null,
  description               text,
  batch_quantity            numeric not null default 1,
  estimated_minutes_total   numeric not null default 0,
  minutes_per_unit          numeric not null default 0,  -- lets reproduce rescale to a new quantity
  sort_order                integer not null default 0
);

create index if not exists archived_job_recipe_tasks_recipe_idx
  on public.archived_job_recipe_tasks (recipe_id);
create index if not exists archived_job_recipe_tasks_company_idx
  on public.archived_job_recipe_tasks (company_id);

-- ============================================================
-- Row Level Security
-- Archive + reproduce is an admin-only feature, so a single
-- admin-scoped policy per table (mirrors completed_jobs_archive).
-- ============================================================

alter table public.archived_job_recipes       enable row level security;
alter table public.archived_job_recipe_items   enable row level security;
alter table public.archived_job_recipe_tasks   enable row level security;

drop policy if exists archived_job_recipes_admin_all on public.archived_job_recipes;
create policy archived_job_recipes_admin_all
  on public.archived_job_recipes
  for all
  using (company_id = current_company_id() and is_admin())
  with check (company_id = current_company_id() and is_admin());

drop policy if exists archived_job_recipe_items_admin_all on public.archived_job_recipe_items;
create policy archived_job_recipe_items_admin_all
  on public.archived_job_recipe_items
  for all
  using (company_id = current_company_id() and is_admin())
  with check (company_id = current_company_id() and is_admin());

drop policy if exists archived_job_recipe_tasks_admin_all on public.archived_job_recipe_tasks;
create policy archived_job_recipe_tasks_admin_all
  on public.archived_job_recipe_tasks
  for all
  using (company_id = current_company_id() and is_admin())
  with check (company_id = current_company_id() and is_admin());

-- ============================================================
-- Refresh PostgREST schema cache so the app sees the new tables.
-- ============================================================
notify pgrst, 'reload schema';
