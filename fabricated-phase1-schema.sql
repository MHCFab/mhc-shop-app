-- ============================================================
-- Fabricated sub-assemblies — Phase 1 schema
-- Review before running. Run in Supabase SQL Editor.
-- Purely additive: every statement is guarded; no existing
-- columns or data are modified. Multi-tenant via company_id + RLS,
-- consistent with the other inventory tables.
-- ============================================================

-- 1) Mark a product template as a stockable fabricated item.
ALTER TABLE product_templates
  ADD COLUMN IF NOT EXISTS is_stockable boolean NOT NULL DEFAULT false;

-- 2) Build-order fields on jobs (a build order IS an internal job).
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS is_build_order boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS build_template_id uuid REFERENCES product_templates(id),
  ADD COLUMN IF NOT EXISTS build_quantity numeric;

-- 3) Fabricated stock ledger (append-only, signed quantity —
--    mirrors raw_material_inventory / purchased_parts_inventory).
CREATE TABLE IF NOT EXISTS fabricated_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  product_template_id uuid NOT NULL REFERENCES product_templates(id),
  quantity numeric NOT NULL,                 -- signed: + receive / build, - pull / adjust
  cost_per_unit numeric NOT NULL DEFAULT 0,  -- actual captured cost at receive time
  source text NOT NULL DEFAULT 'build'       -- 'build' | 'adjustment' | 'consumption'
    CHECK (source IN ('build','adjustment','consumption')),
  source_job_id uuid REFERENCES jobs(id),    -- the build order that produced these units
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fabricated_inventory ENABLE ROW LEVEL SECURITY;

-- Admin-only in Phase 1. (An employee SELECT policy comes in Phase 2,
-- when the floor pick list starts pulling from fabricated stock.)
CREATE POLICY fabricated_inventory_admin_select ON fabricated_inventory
  FOR SELECT USING (company_id = current_company_id() AND is_admin());
CREATE POLICY fabricated_inventory_admin_insert ON fabricated_inventory
  FOR INSERT WITH CHECK (company_id = current_company_id() AND is_admin());
CREATE POLICY fabricated_inventory_admin_update ON fabricated_inventory
  FOR UPDATE USING (company_id = current_company_id() AND is_admin())
  WITH CHECK (company_id = current_company_id() AND is_admin());
CREATE POLICY fabricated_inventory_admin_delete ON fabricated_inventory
  FOR DELETE USING (company_id = current_company_id() AND is_admin());

-- Indexes for the inventory roll-up and the build-order list.
CREATE INDEX IF NOT EXISTS idx_fabricated_inventory_template
  ON fabricated_inventory (company_id, product_template_id);
CREATE INDEX IF NOT EXISTS idx_jobs_build_order
  ON jobs (company_id, is_build_order) WHERE is_build_order = true;

-- Refresh the PostgREST schema cache (required after ALTER TABLE / new table).
NOTIFY pgrst, 'reload schema';
