import { createClient } from "./supabase";

type SupabaseClient = ReturnType<typeof createClient>;

// Shape labels used when describing raw materials on pick lists.
// NOTE: this map also exists as SHAPES on the inventory page — keep both in sync
// when adding a shape. (The job/floor files import this one.)
export const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
  flat_bar: "Flat Bar",
};

function describeMaterial(m: {
  shape: string;
  size: string;
  wall_thickness: string | null;
  grade: string;
}) {
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

// Generates a job's pick list and tasks from its line items' product templates.
// Extracted from the New Job page so the same logic also runs when a portal
// order is approved. Custom line items (no template) are skipped by the caller.
export async function generateJobPickListAndTasks(
  supabase: SupabaseClient,
  companyId: string,
  jobId: string,
  items: { lineItemId: string; templateId: string; quantity: number }[]
) {
  if (!companyId) return;

  const allTemplateIds = new Set<string>();
  const queue = [...new Set(items.map((i) => i.templateId))];
  while (queue.length > 0) {
    const tid = queue.shift()!;
    if (allTemplateIds.has(tid)) continue;
    allTemplateIds.add(tid);
    const { data } = await supabase
      .from("product_template_sub_assemblies")
      .select("child_template_id")
      .eq("parent_template_id", tid);
    if (data) {
      for (const row of data) {
        if (!allTemplateIds.has(row.child_template_id)) queue.push(row.child_template_id);
      }
    }
  }

  const templateIdArr = Array.from(allTemplateIds);

  const [matsRes, partsRes, subLinksRes, tasksRes, templatesData] = await Promise.all([
    supabase
      .from("product_template_materials")
      .select("product_template_id, feet_per_unit, raw_materials(id, shape, size, wall_thickness, grade)")
      .in("product_template_id", templateIdArr),
    supabase
      .from("product_template_parts")
      .select("product_template_id, quantity_per_unit, purchased_parts(id, name, part_number)")
      .in("product_template_id", templateIdArr),
    supabase
      .from("product_template_sub_assemblies")
      .select("parent_template_id, child_template_id, quantity_per_unit")
      .in("parent_template_id", templateIdArr),
    supabase
      .from("product_template_tasks")
      .select("*")
      .in("product_template_id", templateIdArr)
      .order("sort_order"),
    supabase
      .from("product_templates")
      .select("id, name, is_stockable")
      .in("id", templateIdArr),
  ]);

  type TplMatRow = {
    product_template_id: string;
    feet_per_unit: number;
    raw_materials: { id: string; shape: string; size: string; wall_thickness: string | null; grade: string } | null;
  };
  type TplPartRow = {
    product_template_id: string;
    quantity_per_unit: number;
    purchased_parts: { id: string; name: string; part_number: string | null } | null;
  };
  type TplSubRow = { parent_template_id: string; child_template_id: string; quantity_per_unit: number };
  type TplTaskRow = {
    id: string;
    product_template_id: string;
    name: string;
    description: string | null;
    estimated_minutes_per_unit: number;
    sort_order: number;
  };

  const tplMaterials = (matsRes.data || []) as unknown as TplMatRow[];
  const tplParts = (partsRes.data || []) as unknown as TplPartRow[];
  const tplSubs = (subLinksRes.data || []) as unknown as TplSubRow[];
  const tplTasks = (tasksRes.data || []) as unknown as TplTaskRow[];
  const templateNames = new Map<string, string>(
    (templatesData.data || []).map((t: { id: string; name: string }) => [t.id, t.name])
  );
  // Stockable sub-assemblies are pulled from fabricated stock, not re-expanded.
  const stockableIds = new Set<string>(
    (templatesData.data || [])
      .filter((t: { id: string; is_stockable?: boolean | null }) => t.is_stockable)
      .map((t: { id: string }) => t.id)
  );

  const templateQtyTotals = new Map<string, number>();
  // How many finished units of each stockable sub-assembly the job needs.
  // We stop recursion at a stockable CHILD and pull it from stock instead.
  // The top-level item itself always expands — including a build order, which
  // is literally building the stockable item; only its stockable *children*
  // (e.g. welded halves stocked separately) are pulled rather than rebuilt.
  const fabricatedQtyTotals = new Map<string, number>();
  function expandTemplate(templateId: string, multiplier: number) {
    templateQtyTotals.set(templateId, (templateQtyTotals.get(templateId) || 0) + multiplier);
    const childLinks = tplSubs.filter((s) => s.parent_template_id === templateId);
    for (const link of childLinks) {
      const childQty = multiplier * Number(link.quantity_per_unit);
      if (stockableIds.has(link.child_template_id)) {
        fabricatedQtyTotals.set(
          link.child_template_id,
          (fabricatedQtyTotals.get(link.child_template_id) || 0) + childQty
        );
      } else {
        expandTemplate(link.child_template_id, childQty);
      }
    }
  }
  for (const item of items) {
    expandTemplate(item.templateId, item.quantity);
  }

  const matMap = new Map<string, { quantity: number; description: string }>();
  const partMap = new Map<string, { quantity: number; name: string; partNumber: string | null }>();

  for (const [tid, totalQty] of templateQtyTotals.entries()) {
    for (const m of tplMaterials.filter((x) => x.product_template_id === tid)) {
      if (!m.raw_materials) continue;
      const key = m.raw_materials.id;
      const total = Number(m.feet_per_unit) * totalQty;
      const existing = matMap.get(key);
      if (existing) existing.quantity += total;
      else matMap.set(key, { quantity: total, description: describeMaterial(m.raw_materials) });
    }
    for (const p of tplParts.filter((x) => x.product_template_id === tid)) {
      if (!p.purchased_parts) continue;
      const key = p.purchased_parts.id;
      const total = Number(p.quantity_per_unit) * totalQty;
      const existing = partMap.get(key);
      if (existing) existing.quantity += total;
      else partMap.set(key, { quantity: total, name: p.purchased_parts.name, partNumber: p.purchased_parts.part_number });
    }
  }

  const pickListRows = [
    ...Array.from(matMap.entries()).map(([rawMaterialId, info]) => ({
      company_id: companyId,
      job_id: jobId,
      item_type: "raw_material" as const,
      raw_material_id: rawMaterialId,
      purchased_part_id: null,
      product_template_id: null,
      planned_quantity: info.quantity,
      actual_quantity: 0,
      unit: "ft",
      notes: null,
    })),
    ...Array.from(partMap.entries()).map(([partId, info]) => ({
      company_id: companyId,
      job_id: jobId,
      item_type: "purchased_part" as const,
      raw_material_id: null,
      purchased_part_id: partId,
      product_template_id: null,
      planned_quantity: info.quantity,
      // Parts default to "all used" -- the normal case. Edit the pick list
      // actual (or remove the line) only when parts were NOT used.
      actual_quantity: info.quantity,
      unit: "ea",
      notes: null,
    })),
    // Stockable sub-assemblies: one row per finished unit pulled from fabricated stock.
    ...Array.from(fabricatedQtyTotals.entries()).map(([templateId, qty]) => ({
      company_id: companyId,
      job_id: jobId,
      item_type: "fabricated" as const,
      raw_material_id: null,
      purchased_part_id: null,
      product_template_id: templateId,
      planned_quantity: qty,
      // Fabricated units are pulled at the planned quantity, so they default
      // to "all used" as well.
      actual_quantity: qty,
      unit: "ea",
      notes: null,
    })),
  ];

  if (pickListRows.length > 0) {
    await supabase.from("job_pick_list_items").insert(pickListRows);
  }

  function expandForLine(templateId: string, multiplier: number, accumulator: Map<string, number>) {
    accumulator.set(templateId, (accumulator.get(templateId) || 0) + multiplier);
    const childLinks = tplSubs.filter((s) => s.parent_template_id === templateId);
    for (const link of childLinks) {
      // A stockable sub-assembly is pulled finished from stock — none of its
      // build tasks land on this job.
      if (stockableIds.has(link.child_template_id)) continue;
      expandForLine(link.child_template_id, multiplier * Number(link.quantity_per_unit), accumulator);
    }
  }

  const taskRows: Array<{
    company_id: string;
    job_id: string;
    job_line_item_id: string;
    source_task_id: string;
    name: string;
    description: string | null;
    batch_quantity: number;
    estimated_minutes_total: number;
    sort_order: number;
  }> = [];

  for (const item of items) {
    const perLineMap = new Map<string, number>();
    expandForLine(item.templateId, item.quantity, perLineMap);
    const orderedEntries = Array.from(perLineMap.entries()).sort((a, b) => {
      if (a[0] === item.templateId) return -1;
      if (b[0] === item.templateId) return 1;
      return 0;
    });
    let runningSortOrder = 0;
    for (const [tid, totalQty] of orderedEntries) {
      const tasksForTpl = tplTasks.filter((t) => t.product_template_id === tid).sort((a, b) => a.sort_order - b.sort_order);
      const isSubAssembly = tid !== item.templateId;
      const tplName = templateNames.get(tid) || "Sub-assembly";
      for (const t of tasksForTpl) {
        const labeledName = isSubAssembly ? t.name + " (" + tplName + ")" : t.name;
        taskRows.push({
          company_id: companyId,
          job_id: jobId,
          job_line_item_id: item.lineItemId,
          source_task_id: t.id,
          name: labeledName,
          description: t.description,
          batch_quantity: totalQty,
          estimated_minutes_total: Number(t.estimated_minutes_per_unit) * totalQty,
          sort_order: runningSortOrder++,
        });
      }
    }
  }

  if (taskRows.length > 0) {
    await supabase.from("job_tasks").insert(taskRows);
  }
}
