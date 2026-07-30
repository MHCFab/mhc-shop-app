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

export type PlanLine = { lineItemId: string; templateId: string; quantity: number };

export type PlannedTask = {
  sourceTaskId: string;
  name: string;
  description: string | null;
  batchQuantity: number;
  minutes: number;
  sortOrder: number;
  lineItemId: string | null;
};

export type JobPlan = {
  // Aggregated across every product line on the job: shared items merge into one entry.
  materials: Map<string, { quantity: number; description: string }>;
  parts: Map<string, { quantity: number; name: string; partNumber: string | null }>;
  fabricated: Map<string, number>;
  tasks: PlannedTask[];
};

// Works out everything a job needs from its product lines: material, parts,
// stockable sub-assemblies pulled from fabricated stock, and tasks.
//
// Tasks: a job with ONE product line keeps its tasks tied to that line (exactly
// how single-product jobs have always worked). A job with SEVERAL product lines
// merges tasks that share a name into one job-wide task — "Cut" covers every
// variation on the job, with the batch quantity and time estimate added up —
// because variations grouped onto one job are built together. Tasks unique to a
// single variation simply stay on their own.
export async function computeJobPlan(
  supabase: SupabaseClient,
  items: PlanLine[],
  options?: { mergeTasks?: boolean }
): Promise<JobPlan> {
  const empty: JobPlan = { materials: new Map(), parts: new Map(), fabricated: new Map(), tasks: [] };
  if (items.length === 0) return empty;

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

  // One product line: keep tasks tied to that line. Several: merge by name.
  // A build order is the exception -- its outputs have always carried their own
  // task lists, so that behaviour is left exactly as it was.
  const mergeTasks = options?.mergeTasks ?? items.length > 1;
  const mergedTasks = new Map<string, PlannedTask>();
  const perLineTasks: PlannedTask[] = [];
  let mergedSortOrder = 0;

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
        const minutes = Number(t.estimated_minutes_per_unit) * totalQty;
        if (mergeTasks) {
          const existing = mergedTasks.get(labeledName);
          if (existing) {
            existing.batchQuantity += totalQty;
            existing.minutes += minutes;
          } else {
            mergedTasks.set(labeledName, {
              sourceTaskId: t.id,
              name: labeledName,
              description: t.description,
              batchQuantity: totalQty,
              minutes,
              sortOrder: mergedSortOrder++,
              lineItemId: null,
            });
          }
        } else {
          perLineTasks.push({
            sourceTaskId: t.id,
            name: labeledName,
            description: t.description,
            batchQuantity: totalQty,
            minutes,
            sortOrder: runningSortOrder++,
            lineItemId: item.lineItemId,
          });
        }
      }
    }
  }

  return {
    materials: matMap,
    parts: partMap,
    fabricated: fabricatedQtyTotals,
    tasks: mergeTasks ? Array.from(mergedTasks.values()) : perLineTasks,
  };
}

// Generates a job's pick list and tasks from its line items' product templates.
// Extracted from the New Job page so the same logic also runs when a portal
// order is approved. Custom line items (no template) are skipped by the caller.
export async function generateJobPickListAndTasks(
  supabase: SupabaseClient,
  companyId: string,
  jobId: string,
  items: PlanLine[],
  options?: { mergeTasks?: boolean }
) {
  if (!companyId) return;

  const plan = await computeJobPlan(supabase, items, options);

  const pickListRows = [
    ...Array.from(plan.materials.entries()).map(([rawMaterialId, info]) => ({
      company_id: companyId,
      job_id: jobId,
      item_type: "raw_material" as const,
      raw_material_id: rawMaterialId,
      purchased_part_id: null,
      product_template_id: null,
      planned_quantity: Math.round(info.quantity * 10000) / 10000,
      actual_quantity: 0,
      unit: "ft",
      notes: null,
    })),
    ...Array.from(plan.parts.entries()).map(([partId, info]) => ({
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
    ...Array.from(plan.fabricated.entries()).map(([templateId, qty]) => ({
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

  const taskRows = plan.tasks.map((t) => ({
    company_id: companyId,
    job_id: jobId,
    job_line_item_id: t.lineItemId,
    source_task_id: t.sourceTaskId,
    name: t.name,
    description: t.description,
    batch_quantity: t.batchQuantity,
    estimated_minutes_total: t.minutes,
    sort_order: t.sortOrder,
  }));

  if (taskRows.length > 0) {
    await supabase.from("job_tasks").insert(taskRows);
  }
}

// Re-plans a job after its product lines change (a quantity edited, a product
// added or removed) WITHOUT destroying work already recorded against it.
//
// Pick list rows are shared across every product line on the job, so a single
// line's quantity can't just be scaled by a ratio -- that would drag the other
// products' material with it. Instead the template-driven quantities are worked
// out fresh from all the lines and written back:
//   - Template-driven pick lines have their PLANNED quantity recalculated.
//     Raw-material actuals are left alone (they come from the cutting nest).
//     Part/fabricated actuals follow planned only while they still match the
//     old planned figure, i.e. the "all used" default was never hand-edited.
//   - Pick lines for items the templates no longer call for, plus custom one-offs
//     and anything added by hand, are left completely alone.
//   - Tasks are matched BY NAME so logged time, status and history survive:
//     matching tasks get their batch quantity and time estimate recalculated,
//     genuinely new tasks are inserted, and tasks no longer called for are left
//     in place to be removed by hand (they may already carry logged time).
//
// Custom jobs (no product template on any line) are skipped entirely -- their
// pick list and tasks are built by hand and are not ours to recalculate.
export async function recomputeJobPlan(
  supabase: SupabaseClient,
  companyId: string,
  jobId: string
): Promise<void> {
  if (!companyId) return;

  const { data: jobRow } = await supabase.from("jobs").select("is_build_order").eq("id", jobId).single();
  const isBuildOrder = !!(jobRow as { is_build_order: boolean | null } | null)?.is_build_order;

  const { data: liData } = await supabase
    .from("job_line_items")
    .select("id, product_template_id, quantity")
    .eq("job_id", jobId)
    .order("sort_order");
  const lineItems = (liData || []) as unknown as { id: string; product_template_id: string | null; quantity: number }[];
  const templateLines: PlanLine[] = lineItems
    .filter((li) => li.product_template_id)
    .map((li) => ({ lineItemId: li.id, templateId: li.product_template_id as string, quantity: Number(li.quantity) }));

  if (templateLines.length === 0) return;

  const mergeTasks = !isBuildOrder && templateLines.length > 1;
  const plan = await computeJobPlan(supabase, templateLines, { mergeTasks });

  // ---- Pick list ----
  const { data: pickData } = await supabase
    .from("job_pick_list_items")
    .select("id, item_type, raw_material_id, purchased_part_id, product_template_id, planned_quantity, actual_quantity")
    .eq("job_id", jobId)
    // Oldest first, so when the same item appears twice (a hand-added duplicate)
    // the ORIGINAL template-driven row is always the one carrying the plan.
    .order("created_at");
  type PickRow = {
    id: string;
    item_type: string;
    raw_material_id: string | null;
    purchased_part_id: string | null;
    product_template_id: string | null;
    planned_quantity: number;
    actual_quantity: number;
  };
  const pickRows = (pickData || []) as unknown as PickRow[];

  const seen = new Set<string>();
  for (const row of pickRows) {
    let target: number | undefined;
    let key = "";
    if (row.item_type === "raw_material" && row.raw_material_id) {
      key = "m:" + row.raw_material_id;
      target = plan.materials.get(row.raw_material_id)?.quantity;
    } else if (row.item_type === "purchased_part" && row.purchased_part_id) {
      key = "p:" + row.purchased_part_id;
      target = plan.parts.get(row.purchased_part_id)?.quantity;
    } else if (row.item_type === "fabricated" && row.product_template_id) {
      key = "f:" + row.product_template_id;
      target = plan.fabricated.get(row.product_template_id);
    }
    // Not template-driven (custom or added by hand), or already handled: leave it be.
    if (target === undefined || seen.has(key)) continue;
    seen.add(key);

    const rounded = Math.round(target * 10000) / 10000;
    if (Number(row.planned_quantity) === rounded) continue;

    const updates: { planned_quantity: number; actual_quantity?: number } = { planned_quantity: rounded };
    // Parts and fabricated units default to "all used"; keep that default in step
    // with the new plan unless somebody typed a different actual.
    if (row.item_type !== "raw_material" && Number(row.actual_quantity) === Number(row.planned_quantity)) {
      updates.actual_quantity = rounded;
    }
    const { error: pickUpdErr } = await supabase.from("job_pick_list_items").update(updates).eq("id", row.id);
    if (pickUpdErr) throw new Error("Failed to update the pick list: " + pickUpdErr.message);
  }

  const newPickRows: Record<string, unknown>[] = [];
  for (const [rawMaterialId, info] of plan.materials.entries()) {
    if (seen.has("m:" + rawMaterialId)) continue;
    newPickRows.push({
      company_id: companyId,
      job_id: jobId,
      item_type: "raw_material",
      raw_material_id: rawMaterialId,
      purchased_part_id: null,
      product_template_id: null,
      planned_quantity: Math.round(info.quantity * 10000) / 10000,
      actual_quantity: 0,
      unit: "ft",
      notes: null,
    });
  }
  for (const [partId, info] of plan.parts.entries()) {
    if (seen.has("p:" + partId)) continue;
    const qty = Math.round(info.quantity * 10000) / 10000;
    newPickRows.push({
      company_id: companyId,
      job_id: jobId,
      item_type: "purchased_part",
      raw_material_id: null,
      purchased_part_id: partId,
      product_template_id: null,
      planned_quantity: qty,
      actual_quantity: qty,
      unit: "ea",
      notes: null,
    });
  }
  for (const [templateId, quantity] of plan.fabricated.entries()) {
    if (seen.has("f:" + templateId)) continue;
    const qty = Math.round(quantity * 10000) / 10000;
    newPickRows.push({
      company_id: companyId,
      job_id: jobId,
      item_type: "fabricated",
      raw_material_id: null,
      purchased_part_id: null,
      product_template_id: templateId,
      planned_quantity: qty,
      actual_quantity: qty,
      unit: "ea",
      notes: null,
    });
  }
  if (newPickRows.length > 0) {
    const { error: pickInsErr } = await supabase.from("job_pick_list_items").insert(newPickRows);
    if (pickInsErr) throw new Error("Failed to add to the pick list: " + pickInsErr.message);
  }

  // ---- Tasks (matched by name so logged time survives) ----
  const { data: taskData } = await supabase
    .from("job_tasks")
    .select("id, name, batch_quantity, estimated_minutes_total, job_line_item_id, status")
    .eq("job_id", jobId);
  const existingTasks = (taskData || []) as unknown as {
    id: string;
    name: string;
    batch_quantity: number;
    estimated_minutes_total: number;
    job_line_item_id: string | null;
    status: string;
  }[];

  // Several planned tasks can share a name (a build order whose outputs each have
  // a "Cut", or one template listing the same task twice). Queue the existing rows
  // per name and take one per planned task, so each row is written exactly once
  // and no real task is left holding a stale estimate.
  const byName = new Map<string, { id: string; batch_quantity: number; estimated_minutes_total: number; job_line_item_id: string | null; status: string }[]>();
  for (const t of existingTasks) {
    const queue = byName.get(t.name);
    if (queue) queue.push(t);
    else byName.set(t.name, [t]);
  }

  const newTaskRows: Record<string, unknown>[] = [];
  for (const planned of plan.tasks) {
    const match = byName.get(planned.name)?.shift();
    const batch = Math.round(planned.batchQuantity * 10000) / 10000;
    const minutes = Math.round(planned.minutes * 100) / 100;
    if (match) {
      const updates: {
        batch_quantity?: number;
        estimated_minutes_total?: number;
        job_line_item_id?: null;
        status?: string;
        completed_at?: null;
      } = {};
      if (Number(match.batch_quantity) !== batch) updates.batch_quantity = batch;
      if (Number(match.estimated_minutes_total) !== minutes) updates.estimated_minutes_total = minutes;
      // A job that has just gained a second product switches to shared, job-wide
      // tasks. Tasks created back when it had one product still point at that
      // line, so hand them over to the job or they would keep showing under the
      // first product's name on the job page and the floor.
      if (mergeTasks && match.job_line_item_id !== null) updates.job_line_item_id = null;
      // There is more to do than when this task was ticked off, so reopen it --
      // otherwise the floor sees "complete" and the extra units never get made.
      if (batch > Number(match.batch_quantity) && match.status === "complete") {
        updates.status = "not_started";
        updates.completed_at = null;
      }
      if (Object.keys(updates).length > 0) {
        const { error: taskUpdErr } = await supabase.from("job_tasks").update(updates).eq("id", match.id);
        if (taskUpdErr) throw new Error("Failed to update tasks: " + taskUpdErr.message);
      }
    } else {
      newTaskRows.push({
        company_id: companyId,
        job_id: jobId,
        job_line_item_id: planned.lineItemId,
        source_task_id: planned.sourceTaskId,
        name: planned.name,
        description: planned.description,
        batch_quantity: batch,
        estimated_minutes_total: minutes,
        sort_order: planned.sortOrder,
      });
    }
  }
  if (newTaskRows.length > 0) {
    const { error: taskInsErr } = await supabase.from("job_tasks").insert(newTaskRows);
    if (taskInsErr) throw new Error("Failed to add tasks: " + taskInsErr.message);
  }

  // Any existing task the new plan didn't claim (a duplicate name, or one whose
  // template task was renamed or removed since) would otherwise keep pointing at
  // a single product line and show as a stray group of its own. Hand those to the
  // job too, so a merged job never displays a lone product heading.
  if (mergeTasks) {
    for (const queue of byName.values()) {
      for (const leftover of queue) {
        if (leftover.job_line_item_id === null) continue;
        const { error: reparentErr } = await supabase
          .from("job_tasks")
          .update({ job_line_item_id: null })
          .eq("id", leftover.id);
        if (reparentErr) throw new Error("Failed to update tasks: " + reparentErr.message);
      }
    }
  }
}
