import { createClient } from "./supabase";
import { consumeJobInventoryOnInvoice, getJobCostReport } from "./inventory";
import { SHAPES_MAP } from "./job-generation";

// The one and only copy of "mark this job invoiced / archive it".
//
// This used to live inside the job detail page. It now lives here so the job
// page and the Invoices list can both run the exact same steps -- they can
// never drift apart. It freezes the cost report, saves task-time history,
// snapshots a custom job's recipe, deducts the stock the job used, and finally
// deletes the job row. Every failure throws; the caller shows the message.

function describeMaterial(m: { shape: string; size: string; wall_thickness: string | null; grade: string }) {
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

export type InvoiceableJob = {
  id: string;
  job_number: string;
  customer_po: string | null;
  completed_at: string | null;
  notes: string | null;
  customers: { name: string } | null;
};

export async function markJobInvoiced(job: InvoiceableJob): Promise<void> {
  const supabase = createClient();

  const { data: { user } } = await supabase.auth.getUser();
  let companyId: string | null = null;
  if (user) {
    const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    companyId = profile?.company_id || null;
  }
  if (!companyId) throw new Error("Could not determine your company.");

  // Build the cost report to freeze
  const report = await getJobCostReport(job.id);

  // Archive the cost summary (capture its id so a custom-job recipe can link back to it)
  const { data: archiveRow, error: archiveErr } = await supabase
    .from("completed_jobs_archive")
    .insert({
      company_id: companyId,
      job_number: job.job_number,
      customer_name: job.customers?.name || null,
      customer_po: job.customer_po,
      completed_on: job.completed_at ? job.completed_at.slice(0, 10) : null,
      invoiced_on: new Date().toISOString().slice(0, 10),
      labor_cost: report.laborCost,
      material_cost: report.materialActualCost,
      parts_cost: report.partsActualCost,
      scrap_cost: report.scrapCost,
      total_actual: report.totalActualCost,
      total_estimate: report.totalEstimate,
      variance_amount: report.totalActualCost - report.totalEstimate,
      variance_percent: report.totalEstimate > 0 ? ((report.totalActualCost - report.totalEstimate) / report.totalEstimate) * 100 : 0,
      labor_minutes: report.laborMinutes,
      burden_rate: report.burdenRate,
    })
    .select("id")
    .single();
  if (archiveErr) throw new Error("Failed to save cost summary: " + archiveErr.message);
  const archiveId = (archiveRow as { id: string } | null)?.id || null;

  // Save per-task time history
  const { data: jobTasks } = await supabase
    .from("job_tasks")
    .select("id, name, source_task_id, batch_quantity, job_line_items(product_template_id)")
    .eq("job_id", job.id);

  const { data: timeRows } = await supabase
    .from("time_entries")
    .select("job_task_id, started_at, ended_at")
    .eq("job_id", job.id);

  type JT = { id: string; name: string; source_task_id: string | null; batch_quantity: number; job_line_items: { product_template_id: string } | null };
  const tasksArr = (jobTasks || []) as unknown as JT[];

  // Tasks shared across a job's products aren't tied to one product line, so
  // fall back to the template the task was copied from. Without this the
  // learned "actual minutes per unit" history would silently stop building.
  const sourceIds = Array.from(new Set(tasksArr.map((t) => t.source_task_id).filter((x): x is string => !!x)));
  const templateBySourceTask = new Map<string, string>();
  if (sourceIds.length > 0) {
    const { data: srcData } = await supabase
      .from("product_template_tasks")
      .select("id, product_template_id")
      .in("id", sourceIds);
    for (const row of (srcData || []) as unknown as { id: string; product_template_id: string }[]) {
      templateBySourceTask.set(row.id, row.product_template_id);
    }
  }
  const times = (timeRows || []) as unknown as { job_task_id: string; started_at: string; ended_at: string | null }[];

  const historyRows = tasksArr.map((t) => {
    const taskTimes = times.filter((x) => x.job_task_id === t.id);
    const totalMin = taskTimes.reduce((sum, e) => {
      const end = e.ended_at ? new Date(e.ended_at).getTime() : new Date(e.started_at).getTime();
      return sum + Math.max(0, (end - new Date(e.started_at).getTime()) / 60000);
    }, 0);
    const qty = Number(t.batch_quantity) || 1;
    return {
      company_id: companyId,
      source_task_id: t.source_task_id,
      product_template_id:
        t.job_line_items?.product_template_id ||
        (t.source_task_id ? templateBySourceTask.get(t.source_task_id) || null : null),
      task_name: t.name,
      job_number: job.job_number,
      batch_quantity: qty,
      actual_minutes: totalMin,
      minutes_per_unit: qty > 0 ? totalMin / qty : 0,
      completed_on: job.completed_at ? job.completed_at.slice(0, 10) : null,
    };
  }).filter((r) => r.actual_minutes > 0);

  if (historyRows.length > 0) {
    await supabase.from("task_time_history").insert(historyRows);
  }

  // Keep this job's raw time entries on the time reports for 30 days:
  // stamp them with the job number and task names so they can still be
  // labeled after the job row is deleted (job_id / job_task_id null out
  // automatically when the job goes).
  const invoicedOnStr = new Date().toISOString().slice(0, 10);
  await supabase
    .from("time_entries")
    .update({ archived_job_number: job.job_number, invoiced_on: invoicedOnStr })
    .eq("job_id", job.id);
  for (const t of tasksArr) {
    await supabase.from("time_entries").update({ archived_task_name: t.name }).eq("job_task_id", t.id);
  }

  // Sweep entries whose job was invoiced more than 30 days ago (the
  // time report pages run this same sweep on load).
  const purgeCutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  await supabase.from("time_entries").delete().not("invoiced_on", "is", null).lt("invoiced_on", purgeCutoff);

  // ---- Phase 2: snapshot a CUSTOM job's recipe so it can be reproduced later ----
  // A job is "custom" if any of its line items has no product template. Templated
  // jobs can already be rebuilt from their template, so we only snapshot custom ones.
  // This runs BEFORE the job is deleted, and any failure throws (caught below) so
  // the job is never deleted with its recipe lost.
  const { data: liSnapData } = await supabase
    .from("job_line_items")
    .select("name, quantity, unit_price, product_template_id")
    .eq("job_id", job.id)
    .order("sort_order");
  type LiSnapRow = { name: string | null; quantity: number; unit_price: number | null; product_template_id: string | null };
  const lineItemsForSnap = (liSnapData || []) as unknown as LiSnapRow[];
  const isCustomJob = lineItemsForSnap.some((li) => li.product_template_id === null);

  if (isCustomJob) {
    const customLine = lineItemsForSnap.find((li) => li.product_template_id === null) || null;
    const totalUnits = lineItemsForSnap.reduce((s, li) => s + Number(li.quantity), 0);
    const recipeQty = customLine ? Number(customLine.quantity) : (totalUnits || 1);

    // 1) Recipe header
    const { data: recipeRow, error: recipeErr } = await supabase
      .from("archived_job_recipes")
      .insert({
        company_id: companyId,
        completed_job_archive_id: archiveId,
        job_number: job.job_number,
        line_item_name: customLine?.name || job.job_number,
        customer_name: job.customers?.name || null,
        customer_po: job.customer_po,
        quantity: recipeQty,
        unit_price: customLine?.unit_price ?? null,
        job_notes: job.notes,
        invoiced_on: new Date().toISOString().slice(0, 10),
      })
      .select("id")
      .single();
    if (recipeErr) throw new Error("Failed to save recipe: " + recipeErr.message);
    const recipeId = (recipeRow as { id: string } | null)?.id;

    if (recipeId) {
      // 2) Recipe items (pick-list materials + parts, with a text description fallback)
      const { data: pickData } = await supabase
        .from("job_pick_list_items")
        .select("item_type, raw_material_id, purchased_part_id, planned_quantity, actual_quantity, unit, notes, raw_materials(shape, size, wall_thickness, grade), purchased_parts(name, part_number)")
        .eq("job_id", job.id)
        .neq("item_type", "custom")
        .order("item_type")
        .order("created_at");
      type PickSnap = {
        item_type: "raw_material" | "purchased_part";
        raw_material_id: string | null;
        purchased_part_id: string | null;
        planned_quantity: number;
        actual_quantity: number;
        unit: string;
        notes: string | null;
        raw_materials: { shape: string; size: string; wall_thickness: string | null; grade: string } | null;
        purchased_parts: { name: string; part_number: string | null } | null;
      };
      const pickSnap = (pickData || []) as unknown as PickSnap[];
      const itemRows = pickSnap.map((p, idx) => {
        const isRaw = p.item_type === "raw_material";
        const description = isRaw
          ? (p.raw_materials ? describeMaterial(p.raw_materials) : "Material")
          : (p.purchased_parts ? p.purchased_parts.name : "Part");
        return {
          recipe_id: recipeId,
          company_id: companyId,
          item_type: p.item_type,
          raw_material_id: p.raw_material_id,
          purchased_part_id: p.purchased_part_id,
          description,
          part_number: isRaw ? null : (p.purchased_parts?.part_number ?? null),
          planned_quantity: Number(p.planned_quantity) || 0,
          actual_quantity: Number(p.actual_quantity) || 0,
          unit: p.unit || (isRaw ? "ft" : "ea"),
          notes: p.notes,
          sort_order: idx,
        };
      });
      if (itemRows.length > 0) {
        const { error: itemErr } = await supabase.from("archived_job_recipe_items").insert(itemRows);
        if (itemErr) throw new Error("Failed to save recipe items: " + itemErr.message);
      }

      // 3) Recipe tasks (store minutes-per-unit so reproduce can rescale to a new quantity)
      const { data: taskSnapData } = await supabase
        .from("job_tasks")
        .select("name, description, batch_quantity, estimated_minutes_total, sort_order")
        .eq("job_id", job.id)
        .order("sort_order");
      type TaskSnap = { name: string; description: string | null; batch_quantity: number; estimated_minutes_total: number; sort_order: number };
      const taskSnap = (taskSnapData || []) as unknown as TaskSnap[];
      const recipeTaskRows = taskSnap.map((t, idx) => {
        const batch = Number(t.batch_quantity) || 0;
        const total = Number(t.estimated_minutes_total) || 0;
        return {
          recipe_id: recipeId,
          company_id: companyId,
          name: t.name,
          description: t.description,
          batch_quantity: batch,
          estimated_minutes_total: total,
          minutes_per_unit: batch > 0 ? total / batch : total,
          sort_order: t.sort_order ?? idx,
        };
      });
      if (recipeTaskRows.length > 0) {
        const { error: rtErr } = await supabase.from("archived_job_recipe_tasks").insert(recipeTaskRows);
        if (rtErr) throw new Error("Failed to save recipe tasks: " + rtErr.message);
      }
    }
  }

  // Deduct the parts and fabricated stock this job actually used. Its soft
  // reservations vanish when the job row is deleted below, so without this
  // real deduction the stock would bounce back into inventory.
  await consumeJobInventoryOnInvoice(job.id, companyId, job.job_number);

  // Keep the job's material transaction history: pulls stay consumed and
  // saved drops stay in stock. Just unlink the rows, then delete the job.
  // (Deleting them here -- as the cancel path does -- would put every stick
  // this job pulled back into inventory.)
  await supabase.from("raw_material_inventory").update({ source_job_id: null }).eq("source_job_id", job.id);
  await supabase.from("fabricated_inventory").update({ source_job_id: null }).eq("source_job_id", job.id);

  const { error: delErr } = await supabase.from("jobs").delete().eq("id", job.id);
  if (delErr) throw new Error("Archived, but failed to delete the job: " + delErr.message);
}
