"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "../../../lib/supabase";
import { allocateJobInventory, releaseJobInventory } from "../../../lib/inventory";
import OverviewTab from "./OverviewTab";
import PickListTab from "./PickListTab";
import TasksTab from "./TasksTab";
import CuttingNestTab from "./CuttingNestTab";

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
  shipped_at: string | null;
  customers: { id: string; name: string } | null;
};

type Tab = "overview" | "picklist" | "cuttingnest" | "tasks";

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

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [changingStatus, setChangingStatus] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

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

    // Handle inventory allocation based on the new status
    try {
      const prevStatus = job.status;

      // Get company id for allocation
      const { data: { user } } = await supabase.auth.getUser();
      let companyId: string | null = null;
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
        companyId = profile?.company_id || null;
      }

      // Moving to Ready (from Ordered) allocates inventory
      if (newStatus === "ready" && prevStatus === "ordered" && companyId) {
        await allocateJobInventory(job.id, companyId);
      }

      // Going back to Ordered releases inventory
      if (newStatus === "ordered") {
        await releaseJobInventory(job.id);
      }
    } catch (e) {
      console.error("Inventory allocation update failed:", e);
      // Status already changed; just warn
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

    // Remove inventory rows created by this job (drops saved, sticks pulled negatives)
    await supabase.from("raw_material_inventory").delete().eq("source_job_id", job.id);

    // Delete the job - cascade deletes line items, pick list items, tasks, allocations,
    // cutting nest entries, and variances
    const { error } = await supabase.from("jobs").delete().eq("id", job.id);

    setDeleting(false);

    if (error) {
      alert("Failed to delete job: " + error.message);
      return;
    }
    router.push("/admin/jobs");
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: "overview", label: "Overview" },
    { value: "picklist", label: "Pick List" },
    { value: "cuttingnest", label: "Cutting Nest" },
    { value: "tasks", label: "Tasks" },
  ];

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
        <Link href="/admin/jobs" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
          &larr; Back to jobs
        </Link>
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700">
          {error || "Job not found."}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <Link href="/admin/jobs" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
        &larr; Back to jobs
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
          <button
            onClick={deleteJob}
            disabled={deleting}
            className="text-sm text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete job"}
          </button>
        </div>
      </div>

      <div className="border-b border-gray-200 mb-6">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t.value
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" && <OverviewTab jobId={job.id} />}
      {tab === "picklist" && <PickListTab jobId={job.id} />}
      {tab === "cuttingnest" && <CuttingNestTab jobId={job.id} jobStatus={job.status} onChanged={loadJob} />}
      {tab === "tasks" && <TasksTab jobId={job.id} />}
    </div>
  );
}