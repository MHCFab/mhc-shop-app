"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "../../../lib/supabase";
import { allocateJobInventory, releaseJobInventory, getJobCostReport, getJobStockShortfall, getBuildOutputsCostSplit, type JobStockShortfallItem } from "../../../lib/inventory";
import { generateJobPickListAndTasks } from "../../../lib/job-generation";
import OverviewTab from "./OverviewTab";
import PickListTab from "./PickListTab";
import CuttingNestTab from "./CuttingNestTab";
import TasksTab from "./TasksTab";
import TimeTab from "./TimeTab";
import CostTab from "./CostTab";

const STATUSES = [
  { value: "ordered", label: "Ordered", color: "bg-gray-100 text-gray-800" },
  { value: "ready", label: "Ready", color: "bg-blue-100 text-blue-800" },
  { value: "in_progress", label: "In Progress", color: "bg-amber-100 text-amber-800" },
  { value: "complete", label: "Complete", color: "bg-green-100 text-green-800" },
] as const;

type Status = (typeof STATUSES)[number]["value"] | "pending" | "cancelled";

type Job = {
  id: string;
  job_number: string;
  customer_po: string | null;
  status: Status;
  due_date: string | null;
  notes: string | null;
  released_at: string | null;
  completed_at: string | null;
  is_build_order: boolean;
  build_template_id: string | null;
  build_quantity: number | null;
  customers: { id: string; name: string } | null;
};

type ChangeRequest = {
  id: string;
  request_type: "quantity" | "cancel";
  requested_quantity: number | null;
  customer_note: string | null;
  status: string;
  created_at: string;
};

function money(n: number) {
  return "$" + n.toFixed(2);
}

type Tab = "overview" | "picklist" | "cuttingnest" | "tasks" | "time" | "cost";

const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
  flat_bar: "Flat Bar",
};

function describeMaterial(m: { shape: string; size: string; wall_thickness: string | null; grade: string }) {
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

const EXTRA_BADGES: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending approval", color: "bg-yellow-100 text-yellow-800" },
  cancelled: { label: "Cancelled", color: "bg-red-100 text-red-800" },
};

function statusBadge(status: Status) {
  const s = STATUSES.find((x) => x.value === status) || EXTRA_BADGES[status];
  return s
    ? <span className={"inline-flex items-center px-3 py-1 rounded-full text-sm font-medium " + s.color}>{s.label}</span>
    : <span className="text-sm text-gray-500">{status}</span>;
}

function shortfallStrings(item: JobStockShortfallItem) {
  const isFt = item.unit === "ft";
  const short = isFt ? item.short.toFixed(2) + " ft" : Math.round(item.short) + " pcs";
  const required = isFt ? item.required.toFixed(2) + " ft" : Math.round(item.required) + " pcs";
  const have = isFt ? Math.max(0, item.available).toFixed(2) + " ft" : Math.round(Math.max(0, item.available)) + " pcs";
  return { short, required, have };
}

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const supabase = createClient();
  const router = useRouter();

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [changingStatus, setChangingStatus] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [invoicing, setInvoicing] = useState(false);

  // Build order: receive into fabricated stock
  const [receiving, setReceiving] = useState(false);
  const [buildOutputs, setBuildOutputs] = useState<{ templateId: string; name: string; quantity: number }[]>([]);
  const [received, setReceived] = useState<{ at: string; lines: { name: string; qty: number; costPerUnit: number }[] } | null>(null);

  // Edit job (name + quantity + due date + custom price)
  const [lineItem, setLineItem] = useState<{ id: string; quantity: number; unit_price: number | null; isCustom: boolean } | null>(null);
  const [multipleLineItems, setMultipleLineItems] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [qtyDraft, setQtyDraft] = useState("");
  const [dueDateDraft, setDueDateDraft] = useState("");
  const [priceDraft, setPriceDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Stockout alert
  const [shortfall, setShortfall] = useState<JobStockShortfallItem[]>([]);

  // Open customer change request (quantity change / cancellation), if any
  const [changeRequest, setChangeRequest] = useState<ChangeRequest | null>(null);
  const [resolvingRequest, setResolvingRequest] = useState(false);
  const [responseNote, setResponseNote] = useState("");

  const loadJob = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("jobs")
      .select("*, customers(id, name)")
      .eq("id", id)
      .single();
    if (error) setError(error.message);
    else setJob(data as Job);

    const { data: liData } = await supabase
      .from("job_line_items")
      .select("id, quantity, unit_price, product_template_id")
      .eq("job_id", id)
      .order("sort_order");
    const items = (liData || []) as unknown as { id: string; quantity: number; unit_price: number | null; product_template_id: string | null }[];
    if (items.length > 0) {
      setLineItem({
        id: items[0].id,
        quantity: Number(items[0].quantity),
        unit_price: items[0].unit_price != null ? Number(items[0].unit_price) : null,
        isCustom: items[0].product_template_id === null,
      });
      setMultipleLineItems(items.length > 1);
    } else {
      setLineItem(null);
      setMultipleLineItems(false);
    }

    try {
      const sf = await getJobStockShortfall(id);
      setShortfall(sf);
    } catch (e) {
      console.error("Stock shortfall check failed:", e);
      setShortfall([]);
    }

    // Open customer change request on this job (at most one, by DB rule)
    const { data: crData } = await supabase
      .from("job_change_requests")
      .select("id, request_type, requested_quantity, customer_note, status, created_at")
      .eq("job_id", id)
      .eq("status", "open")
      .limit(1);
    const crRows = (crData || []) as unknown as ChangeRequest[];
    setChangeRequest(crRows.length > 0 ? crRows[0] : null);

    // Build-order extras: the items this build produces, and whether it's already
    // been received into fabricated stock.
    const jobData = data as Job | null;
    if (jobData?.is_build_order) {
      // Outputs come from build_outputs (shared-nest builds). Older single-output
      // builds have no rows, so fall back to the job's build_template_id / quantity.
      const { data: boData } = await supabase
        .from("build_outputs")
        .select("product_template_id, quantity, product_templates(name)")
        .eq("job_id", id);
      const bo = (boData || []) as unknown as { product_template_id: string; quantity: number; product_templates: { name: string } | null }[];
      if (bo.length > 0) {
        setBuildOutputs(bo.map((r) => ({ templateId: r.product_template_id, name: r.product_templates?.name || "Item", quantity: Number(r.quantity) })));
      } else if (jobData.build_template_id) {
        const { data: tpl } = await supabase
          .from("product_templates")
          .select("name")
          .eq("id", jobData.build_template_id)
          .single();
        setBuildOutputs([{ templateId: jobData.build_template_id, name: (tpl as { name: string } | null)?.name || "Item", quantity: Number(jobData.build_quantity || 0) }]);
      } else {
        setBuildOutputs([]);
      }

      const { data: fabRows } = await supabase
        .from("fabricated_inventory")
        .select("created_at, cost_per_unit, quantity, product_template_id, product_templates(name)")
        .eq("source_job_id", id)
        .eq("source", "build")
        .order("created_at");
      const fr = (fabRows || []) as unknown as { created_at: string; cost_per_unit: number; quantity: number; product_template_id: string; product_templates: { name: string } | null }[];
      setReceived(
        fr.length > 0
          ? { at: fr[0].created_at, lines: fr.map((r) => ({ name: r.product_templates?.name || "Item", qty: Number(r.quantity), costPerUnit: Number(r.cost_per_unit) })) }
          : null
      );
    } else {
      setBuildOutputs([]);
      setReceived(null);
    }

    setLoading(false);
  }, [id, supabase]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  // Default tab depends on status
  useEffect(() => {
    if (job?.status === "complete") {
      setTab((prev) => (prev === "overview" || prev === "cuttingnest" || prev === "tasks" ? "picklist" : prev));
    }
  }, [job?.status]);

  // Approve a customer portal order: flip pending -> ordered, then generate
  // its pick list and tasks (same generation the New Job page uses). The
  // status dropdown is hidden while pending so this is the only path forward.
  async function approveJob() {
    if (!job) return;
    setChangingStatus(true);

    const { data: { user } } = await supabase.auth.getUser();
    let companyId: string | null = null;
    if (user) {
      const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
      companyId = profile?.company_id || null;
    }
    if (!companyId) {
      setChangingStatus(false);
      alert("Could not determine your company. Try refreshing the page.");
      return;
    }

    // Guarded: only approves if still pending, so it can't run twice.
    const { data: updated, error: updError } = await supabase
      .from("jobs")
      .update({ status: "ordered" })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id");

    if (updError) {
      setChangingStatus(false);
      alert("Failed to approve: " + updError.message);
      return;
    }

    if (updated && updated.length > 0) {
      try {
        const { data: liData } = await supabase
          .from("job_line_items")
          .select("id, quantity, product_template_id")
          .eq("job_id", job.id)
          .order("sort_order");
        const items = ((liData || []) as unknown as { id: string; quantity: number; product_template_id: string | null }[])
          .filter((li) => li.product_template_id)
          .map((li) => ({ lineItemId: li.id, templateId: li.product_template_id as string, quantity: Number(li.quantity) }));
        if (items.length > 0) {
          await generateJobPickListAndTasks(supabase, companyId, job.id, items);
        }
      } catch (e) {
        console.error("Pick list/task generation failed:", e);
        alert("Order approved, but generating its pick list or tasks failed. Use Regenerate on the tasks tab, or contact support.");
      }
    }

    setChangingStatus(false);
    loadJob();
  }

  async function changeStatus(newStatus: Status) {
    if (!job) return;
    setChangingStatus(true);

    const updates: Record<string, string | null> = { status: newStatus };
    const nowIso = new Date().toISOString();
    if (newStatus === "ready" && !job.released_at) updates.released_at = nowIso;
    if (newStatus === "complete" && !job.completed_at) updates.completed_at = nowIso;

    const { error } = await supabase.from("jobs").update(updates).eq("id", job.id);

    if (error) {
      setChangingStatus(false);
      alert("Failed to change status: " + error.message);
      return;
    }

    try {
      const prevStatus = job.status;
      const { data: { user } } = await supabase.auth.getUser();
      let companyId: string | null = null;
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
        companyId = profile?.company_id || null;
      }
      if (newStatus === "ready" && prevStatus === "ordered" && companyId) {
        await allocateJobInventory(job.id, companyId);
      }
      if (newStatus === "ordered") {
        await releaseJobInventory(job.id);
      }
    } catch (e) {
      console.error("Inventory allocation update failed:", e);
      alert("Status changed, but inventory allocation update ran into an issue. Check the inventory page.");
    }

    setChangingStatus(false);
    loadJob();
  }

  async function deleteJob() {
    if (!job) return;
    const ok = confirm(
      "Delete job " + job.job_number + "? This will delete its line items, pick list, tasks, allocations, and cutting nest history. Drops you saved back to inventory from this job will also be removed. This cannot be undone."
    );
    if (!ok) return;
    setDeleting(true);
    await supabase.from("raw_material_inventory").delete().eq("source_job_id", job.id);
    const { error } = await supabase.from("jobs").delete().eq("id", job.id);
    setDeleting(false);
    if (error) {
      alert("Failed to delete job: " + error.message);
      return;
    }
    router.push("/admin/jobs");
  }

  function openEdit() {
    if (!job) return;
    setNameDraft(job.job_number);
    setQtyDraft(lineItem ? String(lineItem.quantity) : "");
    setDueDateDraft(job.due_date || "");
    setPriceDraft(lineItem?.unit_price != null ? String(lineItem.unit_price) : "");
    setEditing(true);
  }

  // Rescale the pick list targets, task batch quantities / time estimates,
  // and the line item itself from one quantity to another. Used by the Edit
  // dialog and by approving a customer's quantity-change request.
  async function rescaleJobQuantity(lineItemId: string, oldQty: number, newQty: number) {
    if (!job || !(oldQty > 0)) return;
    const ratio = newQty / oldQty;

    const { data: pliData } = await supabase
      .from("job_pick_list_items")
      .select("id, planned_quantity")
      .eq("job_id", job.id);
    const pickItems = (pliData || []) as unknown as { id: string; planned_quantity: number }[];
    for (const row of pickItems) {
      const scaled = Math.round(Number(row.planned_quantity) * ratio * 10000) / 10000;
      await supabase.from("job_pick_list_items").update({ planned_quantity: scaled }).eq("id", row.id);
    }

    const { data: taskData } = await supabase
      .from("job_tasks")
      .select("id, batch_quantity, estimated_minutes_total")
      .eq("job_id", job.id);
    const taskRows = (taskData || []) as unknown as { id: string; batch_quantity: number; estimated_minutes_total: number }[];
    for (const row of taskRows) {
      const newBatch = Math.round(Number(row.batch_quantity) * ratio);
      const newMins = Math.round(Number(row.estimated_minutes_total) * ratio * 100) / 100;
      await supabase.from("job_tasks").update({ batch_quantity: newBatch, estimated_minutes_total: newMins }).eq("id", row.id);
    }

    const { error: liErr } = await supabase.from("job_line_items").update({ quantity: newQty }).eq("id", lineItemId);
    if (liErr) throw new Error("Quantity update failed: " + liErr.message);
  }

  async function saveEdit() {
    if (!job) return;
    const newName = nameDraft.trim();
    if (!newName) {
      alert("Job name can't be empty.");
      return;
    }

    let qtyChanged = false;
    let newQty = lineItem?.quantity ?? 0;
    if (lineItem && !multipleLineItems) {
      newQty = parseInt(qtyDraft, 10);
      if (isNaN(newQty) || newQty < 1) {
        alert("Quantity must be at least 1.");
        return;
      }
      qtyChanged = newQty !== lineItem.quantity;
    }

    // Validate the per-unit price on a custom job (blank = clear it)
    let newUnitPrice: number | null = null;
    const isCustom = !!lineItem?.isCustom;
    if (isCustom && priceDraft.trim()) {
      const up = parseFloat(priceDraft);
      if (isNaN(up) || up < 0) {
        alert("Price per unit must be 0 or more (or leave it blank to clear it).");
        return;
      }
      newUnitPrice = up;
    }

    if (qtyChanged && lineItem) {
      const ok = confirm(
        "Change quantity from " + lineItem.quantity + " to " + newQty + "?\n\n" +
        "Your pick list targets and task time estimates will be updated for the new quantity. " +
        "Already-picked amounts, logged time, scrap, and cutting nest entries are preserved — nothing is deleted.\n\n" +
        "If you increased the quantity you may need to cut or pull more material, and if this job is already \"Ready\" or further, set it back to \"Ordered\" and then \"Ready\" again to re-reserve inventory for the new amount.\n\n" +
        "Continue?"
      );
      if (!ok) return;
    }

    setSavingEdit(true);
    try {
      // 1) Rename + due date on the job (if changed)
      const jobUpdates: Record<string, string | null> = {};
      if (newName !== job.job_number) jobUpdates.job_number = newName;
      const newDueDate = dueDateDraft || null;
      if (newDueDate !== job.due_date) jobUpdates.due_date = newDueDate;
      if (Object.keys(jobUpdates).length > 0) {
        const { error: jobErr } = await supabase.from("jobs").update(jobUpdates).eq("id", job.id);
        if (jobErr) throw new Error("Job update failed: " + jobErr.message);
      }

      // 2) Rescale pick list, tasks, and the line item quantity (if changed)
      if (qtyChanged && lineItem) {
        await rescaleJobQuantity(lineItem.id, lineItem.quantity, newQty);
      }

      // 3) Update the per-unit price on a custom job's line item
      if (isCustom && lineItem) {
        const { error: priceErr } = await supabase
          .from("job_line_items")
          .update({ unit_price: newUnitPrice })
          .eq("id", lineItem.id);
        if (priceErr) throw new Error("Price update failed: " + priceErr.message);
      }

      setEditing(false);
      await loadJob();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to save changes.");
    } finally {
      setSavingEdit(false);
    }
  }

  // ---- Customer change requests: approve / decline ----

  async function approveChangeRequest() {
    if (!job || !changeRequest) return;

    if (changeRequest.request_type === "quantity") {
      const newQty = Number(changeRequest.requested_quantity);
      if (!lineItem || multipleLineItems) {
        alert("This job doesn't have a single product line, so the quantity can't be changed automatically. Adjust it manually, then decline the request with a note.");
        return;
      }
      if (!Number.isInteger(newQty) || newQty < 1) {
        alert("The requested quantity isn't valid.");
        return;
      }
      if (newQty !== lineItem.quantity) {
        const ok = confirm(
          "Approve quantity change from " + lineItem.quantity + " to " + newQty + "?\n\n" +
          "Your pick list targets and task time estimates will be updated for the new quantity. " +
          "Already-picked amounts, logged time, scrap, and cutting nest entries are preserved — nothing is deleted.\n\n" +
          "If the quantity went up you may need to cut or pull more material, and if this job is already \"Ready\" or further, set it back to \"Ordered\" and then \"Ready\" again to re-reserve inventory for the new amount.\n\n" +
          "Continue?"
        );
        if (!ok) return;
      }
    } else {
      const ok = confirm(
        "Approve this cancellation request?\n\n" +
        "This only tells the customer the cancellation is approved — it does NOT cancel or change the job. " +
        "Handle the job itself afterwards (for example with Delete job, or by talking to the customer about work already done)."
      );
      if (!ok) return;
    }

    setResolvingRequest(true);
    try {
      if (changeRequest.request_type === "quantity" && lineItem && Number(changeRequest.requested_quantity) !== lineItem.quantity) {
        await rescaleJobQuantity(lineItem.id, lineItem.quantity, Number(changeRequest.requested_quantity));
      }

      const { data: { user } } = await supabase.auth.getUser();
      const { error: reqErr } = await supabase
        .from("job_change_requests")
        .update({
          status: "approved",
          resolved_at: new Date().toISOString(),
          resolved_by: user?.id || null,
          response_note: responseNote.trim() ? responseNote.trim() : null,
        })
        .eq("id", changeRequest.id)
        .eq("status", "open");
      if (reqErr) throw new Error("The change went through, but marking the request approved failed: " + reqErr.message);

      setResponseNote("");
      await loadJob();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to approve the request.");
    } finally {
      setResolvingRequest(false);
    }
  }

  async function declineChangeRequest() {
    if (!changeRequest) return;
    const ok = confirm("Decline this request? The customer will see it was declined" + (responseNote.trim() ? " along with your note." : ". You can add a note first to tell them why."));
    if (!ok) return;

    setResolvingRequest(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { error: reqErr } = await supabase
        .from("job_change_requests")
        .update({
          status: "declined",
          resolved_at: new Date().toISOString(),
          resolved_by: user?.id || null,
          response_note: responseNote.trim() ? responseNote.trim() : null,
        })
        .eq("id", changeRequest.id)
        .eq("status", "open");
      if (reqErr) throw new Error(reqErr.message);

      setResponseNote("");
      await loadJob();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to decline the request.");
    } finally {
      setResolvingRequest(false);
    }
  }

  async function receiveBuild() {
    if (!job || !job.is_build_order) return;
    if (buildOutputs.length === 0) {
      alert("This build order has no items to receive.");
      return;
    }
    const totalUnits = buildOutputs.reduce((s, o) => s + Number(o.quantity), 0);
    if (!(totalUnits > 0)) {
      alert("This build order has no quantity set, so there's nothing to receive.");
      return;
    }
    const summary = buildOutputs.map((o) => o.quantity + " × " + o.name).join(", ");
    const ok = confirm(
      "Receive into fabricated stock?\n\n" + summary +
      "\n\nThe build's actual material, parts, and labor are split across these items in proportion to their estimated bill-of-materials cost, and each is stocked at its own cost per unit. The raw material and parts this build consumed were already taken out of inventory as you worked the job."
    );
    if (!ok) return;

    setReceiving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      let companyId: string | null = null;
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
        companyId = profile?.company_id || null;
      }
      if (!companyId) {
        alert("Could not determine your company.");
        setReceiving(false);
        return;
      }

      // Guard against receiving the same build twice.
      const { data: existing } = await supabase
        .from("fabricated_inventory")
        .select("id")
        .eq("source_job_id", job.id)
        .eq("source", "build")
        .limit(1);
      if (existing && existing.length > 0) {
        alert("This build has already been received into stock.");
        setReceiving(false);
        loadJob();
        return;
      }

      // Split the job's total actual cost across the outputs by estimated BOM cost.
      const split = await getBuildOutputsCostSplit(job.id);
      if (split.length === 0) {
        alert("Couldn't work out this build's outputs to receive.");
        setReceiving(false);
        return;
      }

      const rows = split.map((s) => ({
        company_id: companyId,
        product_template_id: s.templateId,
        quantity: s.quantity,
        cost_per_unit: s.costPerUnit,
        source: "build",
        source_job_id: job.id,
        notes: "Received from build order " + job.job_number,
      }));
      const { error: insErr } = await supabase.from("fabricated_inventory").insert(rows);
      if (insErr) throw new Error(insErr.message);

      await loadJob();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong.";
      alert("Failed to receive into stock: " + msg);
    } finally {
      setReceiving(false);
    }
  }

  async function markInvoiced() {
    if (!job) return;
    const ok = confirm(
      job.is_build_order
        ? "Archive build order " + job.job_number + "? This saves its cost and task-time history to your permanent records, then removes it from the active board. This cannot be undone. (Its units stay in fabricated stock.)"
        : "Mark " + job.job_number + " as invoiced? This saves the cost summary and task time history to your permanent records, then removes the job from the active system. This cannot be undone."
    );
    if (!ok) return;

    setInvoicing(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      let companyId: string | null = null;
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
        companyId = profile?.company_id || null;
      }
      if (!companyId) {
        alert("Could not determine your company.");
        setInvoicing(false);
        return;
      }

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
          product_template_id: t.job_line_items?.product_template_id || null,
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

      // Delete the job and its inventory-created rows
      await supabase.from("raw_material_inventory").delete().eq("source_job_id", job.id);
      const { error: delErr } = await supabase.from("jobs").delete().eq("id", job.id);
      if (delErr) {
        alert("Archived, but failed to delete the job: " + delErr.message);
        setInvoicing(false);
        return;
      }

      router.push("/admin/invoices");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong.";
      alert("Failed to invoice: " + msg);
      setInvoicing(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <Link href="/admin/jobs" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to jobs</Link>
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700">{error || "Job not found."}</div>
      </div>
    );
  }

  const isComplete = job.status === "complete";

  const activeTabs: { value: Tab; label: string }[] = [
    { value: "overview", label: "Overview" },
    { value: "picklist", label: "Pick List" },
    { value: "cuttingnest", label: "Cutting Nest" },
    { value: "tasks", label: "Tasks" },
    { value: "time", label: "Time" },
    { value: "cost", label: "Cost" },
  ];

  const completeTabs: { value: Tab; label: string }[] = [
    { value: "picklist", label: "Pick List" },
    { value: "time", label: "Time" },
    { value: "cost", label: "Cost" },
  ];

  const tabs = isComplete ? completeTabs : activeTabs;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <Link href={isComplete ? "/admin/invoices" : "/admin/jobs"} className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
        &larr; {isComplete ? "Back to invoices" : "Back to jobs"}
      </Link>

      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-gray-900">{job.job_number}</h1>
            {!isComplete && (
              <button
                onClick={openEdit}
                className="text-sm text-blue-600 hover:text-blue-800 font-medium"
              >
                Edit
              </button>
            )}
          </div>
          <p className="text-gray-700 mt-1">
            {job.customers?.name || "Unknown customer"}
            {job.customer_po && <span className="text-gray-500"> &middot; PO {job.customer_po}</span>}
          </p>
          {lineItem && !(job.is_build_order && buildOutputs.length > 1) && <p className="text-sm text-gray-500 mt-1">Quantity: {lineItem.quantity}</p>}
          {lineItem?.isCustom && lineItem.unit_price != null && (
            <p className="text-sm text-gray-500 mt-1">Price/unit: ${Number(lineItem.unit_price).toFixed(2)}</p>
          )}
          {job.due_date && <p className="text-sm text-gray-500 mt-1">Due {job.due_date}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          {statusBadge(job.status)}
          {job.status === "pending" ? (
            <button
              onClick={approveJob}
              disabled={changingStatus}
              className="bg-green-600 text-white px-4 py-1.5 rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {changingStatus ? "Approving..." : "Approve order"}
            </button>
          ) : job.status === "cancelled" ? null : (
          <select
            value={job.status}
            onChange={(e) => changeStatus(e.target.value as Status)}
            disabled={changingStatus}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>Change to {s.label}</option>
            ))}
          </select>
          )}
          {!isComplete && (
            <button onClick={deleteJob} disabled={deleting} className="text-sm text-red-600 hover:text-red-800 font-medium disabled:opacity-50">
              {deleting ? "Deleting..." : "Delete job"}
            </button>
          )}
        </div>
      </div>

      {!isComplete && changeRequest && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-semibold text-orange-900">
            {changeRequest.request_type === "quantity"
              ? "Customer requests a quantity change" +
                (lineItem ? ": " + lineItem.quantity + " → " + changeRequest.requested_quantity : " to " + changeRequest.requested_quantity)
              : "Customer requests cancellation of this job"}
          </h2>
          <p className="text-sm text-orange-800 mt-0.5">
            Sent {changeRequest.created_at.slice(0, 10)}.{" "}
            {changeRequest.request_type === "quantity"
              ? "Approving applies the new quantity the same way the Edit dialog does (pick list targets and task estimates rescale; picked amounts and logged time are kept)."
              : "Approving only tells the customer it's approved — the job itself stays put until you handle it."}
          </p>
          {changeRequest.customer_note && (
            <p className="text-sm text-orange-900 mt-2 bg-orange-100 rounded-md px-3 py-2">
              &ldquo;{changeRequest.customer_note}&rdquo;
            </p>
          )}
          <div className="mt-3">
            <input
              type="text"
              value={responseNote}
              onChange={(e) => setResponseNote(e.target.value)}
              placeholder="Optional note back to the customer"
              className="w-full max-w-md px-3 py-2 border border-orange-200 rounded-md text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={approveChangeRequest}
              disabled={resolvingRequest}
              className="bg-green-600 text-white px-4 py-1.5 rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {resolvingRequest
                ? "Working..."
                : changeRequest.request_type === "quantity"
                  ? "Approve & apply"
                  : "Approve request"}
            </button>
            <button
              onClick={declineChangeRequest}
              disabled={resolvingRequest}
              className="bg-white border border-orange-300 text-orange-800 px-4 py-1.5 rounded-md text-sm font-medium hover:bg-orange-100 disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {!isComplete && shortfall.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-semibold text-amber-900">Not enough stock to complete this job</h2>
          <p className="text-sm text-amber-800 mt-0.5">
            These items are short on what&apos;s free in inventory. This updates as stock comes in and clears once everything is covered.
          </p>
          <ul className="mt-3 space-y-1.5">
            {shortfall.map((item) => {
              const s = shortfallStrings(item);
              return (
                <li
                  key={item.itemType + ":" + item.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-amber-100 last:border-0 pb-1.5 last:pb-0"
                >
                  <span className="text-sm font-medium text-amber-900">{item.label}</span>
                  <span className="text-sm text-amber-800">
                    short <span className="font-semibold font-mono">{s.short}</span>
                    <span className="text-amber-600"> &middot; need {s.required} &middot; {s.have} available</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {isComplete && job.is_build_order && !received && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6 flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-sm font-medium text-blue-900">This build is complete. Receive it into fabricated stock:</p>
            <ul className="text-sm text-blue-900 mt-1 list-disc list-inside">
              {buildOutputs.map((o) => (
                <li key={o.templateId}>{o.quantity} unit(s) of {o.name}</li>
              ))}
            </ul>
            <p className="text-sm text-blue-700 mt-1">
              {buildOutputs.length > 1
                ? "The build's actual material, parts, and labor are split across these items by their estimated bill-of-materials cost."
                : "Captures the build's actual material, parts, and labor as the stocked cost per unit."}
            </p>
          </div>
          <button onClick={receiveBuild} disabled={receiving} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {receiving ? "Receiving..." : "Receive into stock"}
          </button>
        </div>
      )}

      {isComplete && job.is_build_order && received && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6 flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-sm font-medium text-green-900">Received into fabricated stock on {received.at.slice(0, 10)}:</p>
            <ul className="text-sm text-green-900 mt-1 list-disc list-inside">
              {received.lines.map((l, i) => (
                <li key={i}>{l.qty} unit(s) of {l.name} at {money(l.costPerUnit)}/unit</li>
              ))}
            </ul>
            <p className="text-sm text-green-700 mt-1">You can archive this build order to clear it from the board.</p>
          </div>
          <button onClick={markInvoiced} disabled={invoicing} className="bg-green-600 text-white px-4 py-2 rounded-md font-medium hover:bg-green-700 disabled:opacity-50 transition-colors">
            {invoicing ? "Archiving..." : "Archive build order"}
          </button>
        </div>
      )}

      {isComplete && !job.is_build_order && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6 flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-sm font-medium text-green-900">This job is complete and ready to invoice.</p>
            <p className="text-sm text-green-700 mt-0.5">Review the cost report, invoice the customer, then mark it invoiced to archive it.</p>
          </div>
          <button onClick={markInvoiced} disabled={invoicing} className="bg-green-600 text-white px-4 py-2 rounded-md font-medium hover:bg-green-700 disabled:opacity-50 transition-colors">
            {invoicing ? "Archiving..." : "Mark as invoiced"}
          </button>
        </div>
      )}

      <div className="border-b border-gray-200 mb-6">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t.value ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" && !isComplete && <OverviewTab jobId={job.id} />}
      {tab === "picklist" && <PickListTab jobId={job.id} readOnly={isComplete} />}
      {tab === "cuttingnest" && !isComplete && <CuttingNestTab jobId={job.id} jobStatus={job.status} onChanged={loadJob} />}
      {tab === "tasks" && !isComplete && <TasksTab jobId={job.id} />}
      {tab === "time" && <TimeTab jobId={job.id} />}
      {tab === "cost" && <CostTab jobId={job.id} />}

      {editing && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => !savingEdit && setEditing(false)}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Edit job</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Job name</label>
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
                {multipleLineItems ? (
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    This job has more than one product line, so quantity isn&apos;t editable here yet. You can still rename the job.
                  </p>
                ) : !lineItem ? (
                  <p className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
                    No product line found for this job.
                  </p>
                ) : (
                  <>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={qtyDraft}
                      onChange={(e) => setQtyDraft(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Changing quantity rescales the pick list and task time estimates. Picked amounts, logged time, scrap, and cutting nest entries are kept.
                    </p>
                  </>
                )}
              </div>

              {lineItem?.isCustom && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Price per unit</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={priceDraft}
                    onChange={(e) => setPriceDraft(e.target.value)}
                    placeholder="Leave blank for no price"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Your quoted price for one unit. The Cost tab uses this for margin. Clear it to leave the job without a price.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Due date</label>
                <input
                  type="date"
                  value={dueDateDraft}
                  onChange={(e) => setDueDateDraft(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">Leave blank to clear the due date.</p>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setEditing(false)}
                disabled={savingEdit}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={savingEdit}
                className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {savingEdit ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
