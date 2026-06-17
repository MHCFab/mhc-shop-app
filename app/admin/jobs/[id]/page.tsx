"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "../../../lib/supabase";
import { allocateJobInventory, releaseJobInventory, getJobCostReport } from "../../../lib/inventory";
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

type Status = (typeof STATUSES)[number]["value"];

type Job = {
  id: string;
  job_number: string;
  customer_po: string | null;
  status: Status;
  due_date: string | null;
  notes: string | null;
  released_at: string | null;
  completed_at: string | null;
  customers: { id: string; name: string } | null;
};

type Tab = "overview" | "picklist" | "cuttingnest" | "tasks" | "time" | "cost";

function statusBadge(status: Status) {
  const s = STATUSES.find((x) => x.value === status);
  return s
    ? <span className={"inline-flex items-center px-3 py-1 rounded-full text-sm font-medium " + s.color}>{s.label}</span>
    : <span className="text-sm text-gray-500">{status}</span>;
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

  const loadJob = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("jobs")
      .select("*, customers(id, name)")
      .eq("id", id)
      .single();
    if (error) setError(error.message);
    else setJob(data as Job);
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

  async function markInvoiced() {
    if (!job) return;
    const ok = confirm(
      "Mark " + job.job_number + " as invoiced? This saves the cost summary and task time history to your permanent records, then removes the job from the active system. This cannot be undone."
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

      // Archive the cost summary
      await supabase.from("completed_jobs_archive").insert({
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
      });

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
      const tasksArr = (jobTasks || []) as JT[];
      const times = (timeRows || []) as { job_task_id: string; started_at: string; ended_at: string | null }[];

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
          <h1 className="text-3xl font-bold text-gray-900">{job.job_number}</h1>
          <p className="text-gray-700 mt-1">
            {job.customers?.name || "Unknown customer"}
            {job.customer_po && <span className="text-gray-500"> &middot; PO {job.customer_po}</span>}
          </p>
          {job.due_date && <p className="text-sm text-gray-500 mt-1">Due {job.due_date}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          {statusBadge(job.status)}
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
          {!isComplete && (
            <button onClick={deleteJob} disabled={deleting} className="text-sm text-red-600 hover:text-red-800 font-medium disabled:opacity-50">
              {deleting ? "Deleting..." : "Delete job"}
            </button>
          )}
        </div>
      </div>

      {isComplete && (
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
    </div>
  );
}