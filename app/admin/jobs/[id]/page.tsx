"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "../../../lib/supabase";
import OverviewTab from "./OverviewTab";
import PickListTab from "./PickListTab";
import TasksTab from "./TasksTab";

const STATUSES = [
  { value: "quoted", label: "Quoted", color: "bg-gray-100 text-gray-800" },
  { value: "released", label: "Released", color: "bg-blue-100 text-blue-800" },
  { value: "in_progress", label: "In Progress", color: "bg-amber-100 text-amber-800" },
  { value: "complete", label: "Complete", color: "bg-green-100 text-green-800" },
  { value: "shipped", label: "Shipped", color: "bg-emerald-100 text-emerald-800" },
  { value: "cancelled", label: "Cancelled", color: "bg-red-100 text-red-800" },
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

type Tab = "overview" | "picklist" | "tasks";

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
    if (newStatus === "released" && !job.released_at) updates.released_at = nowIso;
    if (newStatus === "complete" && !job.completed_at) updates.completed_at = nowIso;
    if (newStatus === "shipped" && !job.shipped_at) updates.shipped_at = nowIso;

    const { error } = await supabase.from("jobs").update(updates).eq("id", job.id);
    setChangingStatus(false);

    if (error) {
      alert("Failed to change status: " + error.message);
      return;
    }
    loadJob();
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: "overview", label: "Overview" },
    { value: "picklist", label: "Pick List" },
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
      {tab === "tasks" && <TasksTab jobId={job.id} />}
    </div>
  );
}