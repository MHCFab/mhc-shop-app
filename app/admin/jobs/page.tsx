"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabase";
import { generateJobPickListAndTasks } from "../../lib/job-generation";

const STATUSES = [
  { value: "pending", label: "Pending approval", color: "bg-yellow-100 text-yellow-800" },
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
  board_order: number;
  created_at: string;
  customer_id: string;
  customers: { id: string; name: string } | null;
  job_line_items: { id: string; quantity: number; product_template_id: string | null }[];
};

type CustomerGroup = {
  customerId: string;
  customerName: string;
  jobs: Job[];
};

function statusBadge(status: Status) {
  const s = STATUSES.find((x) => x.value === status);
  return s
    ? <span className={"inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium " + s.color}>{s.label}</span>
    : <span className="text-xs text-gray-500">{status}</span>;
}

export default function JobsPage() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [savingOrder, setSavingOrder] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);

  useEffect(() => {
    async function loadCompanyId() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
      if (data) setCompanyId(data.company_id);
    }
    loadCompanyId();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Approve a customer order: flip pending -> ordered, then generate its
  // pick list and tasks (same generation the New Job page uses).
  async function approveJob(job: Job) {
    if (!companyId) {
      setError("Could not determine your company. Try refreshing the page.");
      return;
    }
    setApprovingId(job.id);
    setError(null);

    // Guarded update: only approves if the job is still pending, so a
    // double-click (or a customer cancelling at the same moment) can't
    // generate the pick list twice.
    const { data: updated, error: updError } = await supabase
      .from("jobs")
      .update({ status: "ordered" })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id");

    if (updError) {
      setError("Failed to approve: " + updError.message);
      setApprovingId(null);
      return;
    }
    if (!updated || updated.length === 0) {
      // Someone else changed it in the meantime; just refresh.
      setApprovingId(null);
      loadJobs();
      return;
    }

    try {
      const items = job.job_line_items
        .filter((li) => li.product_template_id)
        .map((li) => ({ lineItemId: li.id, templateId: li.product_template_id as string, quantity: Number(li.quantity) }));
      if (items.length > 0) {
        await generateJobPickListAndTasks(supabase, companyId, job.id, items);
      }
    } catch (e) {
      console.error("Pick list/task generation failed:", e);
      setError("Order approved, but generating its pick list or tasks failed. Open the job and regenerate them from the job page.");
    }

    setApprovingId(null);
    loadJobs();
  }

  // Drag state scoped to a customer
  const [dragCustomer, setDragCustomer] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  async function loadJobs() {
    setLoading(true);
    const { data, error } = await supabase
      .from("jobs")
      .select("*, customers(id, name), job_line_items(id, quantity, product_template_id)")
      .in("status", ["pending", "ordered", "ready", "in_progress"])
      .order("board_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) setError(error.message);
    else setJobs((data || []) as unknown as Job[]);
    setLoading(false);
  }

  useEffect(() => {
    loadJobs();
  }, []);

  const canReorder = !search;

  // Build customer groups (only customers with open jobs), alphabetical
  const searchLower = search.toLowerCase();
  const visibleJobs = jobs.filter((j) => {
    if (!search) return true;
    const text = (j.job_number + " " + (j.customer_po || "") + " " + (j.customers?.name || "")).toLowerCase();
    return text.includes(searchLower);
  });

  const groupMap = new Map<string, CustomerGroup>();
  for (const j of visibleJobs) {
    const cid = j.customer_id;
    const cname = j.customers?.name || "Unknown customer";
    if (!groupMap.has(cid)) groupMap.set(cid, { customerId: cid, customerName: cname, jobs: [] });
    groupMap.get(cid)!.jobs.push(j);
  }
  const groups = Array.from(groupMap.values()).sort((a, b) => a.customerName.localeCompare(b.customerName));

  function onDragStart(customerId: string, index: number) {
    if (!canReorder) return;
    setDragCustomer(customerId);
    setDragIndex(index);
  }

  function onDragOver(e: React.DragEvent, customerId: string, index: number) {
    if (!canReorder || dragCustomer !== customerId) return;
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;

    setJobs((prev) => {
      // Work within this customer's jobs only
      const customerJobs = prev.filter((j) => j.customer_id === customerId);
      const others = prev.filter((j) => j.customer_id !== customerId);
      const reordered = [...customerJobs];
      const [moved] = reordered.splice(dragIndex, 1);
      reordered.splice(index, 0, moved);
      return [...others, ...reordered];
    });
    setDragIndex(index);
  }

  async function onDrop(customerId: string) {
    if (!canReorder) return;
    setDragCustomer(null);
    setDragIndex(null);
    setSavingOrder(true);

    // Renumber this customer's jobs sequentially
    const customerJobs = jobs.filter((j) => j.customer_id === customerId);
    const updates = customerJobs.map((job, i) =>
      supabase.from("jobs").update({ board_order: i }).eq("id", job.id)
    );
    await Promise.all(updates);
    setSavingOrder(false);
    loadJobs();
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Jobs</h1>
          <p className="text-gray-600 mt-1">Open work orders by customer. Completed jobs move to the invoice list.</p>
        </div>
        <Link
          href="/admin/jobs/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors"
        >
          New job
        </Link>
      </div>

      <div className="mb-4">
        <input
          type="text"
          placeholder="Search by job #, PO, or customer..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {canReorder ? (
        <p className="text-xs text-gray-500 mb-3">{savingOrder ? "Saving order..." : "Drag the handle to set priority within each customer. This order shows on the floor board."}</p>
      ) : (
        <p className="text-xs text-gray-500 mb-3">Clear search to reorder priority.</p>
      )}

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{error}</div>}

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : groups.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">
            {jobs.length === 0 ? "No open jobs. Click New job to create one." : "No jobs match your search."}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.customerId}>
              <h2 className="text-lg font-bold text-gray-900 mb-2">{group.customerName}</h2>
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {canReorder && <th className="w-10 px-2 py-3"></th>}
                      <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Job #</th>
                      <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">PO</th>
                      <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Line items</th>
                      <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Total units</th>
                      <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Status</th>
                      <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Due</th>
                      <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.jobs.map((j, idx) => {
                      const totalUnits = j.job_line_items.reduce((sum, li) => sum + Number(li.quantity), 0);
                      return (
                        <tr
                          key={j.id}
                          draggable={canReorder}
                          onDragStart={() => onDragStart(group.customerId, idx)}
                          onDragOver={(e) => onDragOver(e, group.customerId, idx)}
                          onDrop={() => onDrop(group.customerId)}
                          onDragEnd={() => { setDragCustomer(null); setDragIndex(null); }}
                          className={"border-b border-gray-100 last:border-0 hover:bg-gray-50 " + (dragCustomer === group.customerId && dragIndex === idx ? "bg-blue-50" : j.status === "pending" ? "bg-yellow-50" : "")}
                        >
                          {canReorder && (
                            <td className="px-2 py-3 text-center text-gray-400 cursor-grab active:cursor-grabbing select-none" title="Drag to reorder">⠿</td>
                          )}
                          <td className="px-4 py-3 text-sm font-medium">
                            <Link href={"/admin/jobs/" + j.id} className="text-blue-600 hover:text-blue-800">
                              {j.job_number}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700">{j.customer_po || "-"}</td>
                          <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{j.job_line_items.length}</td>
                          <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{totalUnits}</td>
                          <td className="px-4 py-3 text-sm">{statusBadge(j.status)}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{j.due_date || "-"}</td>
                          <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                            {j.status === "pending" && (
                              <button
                                onClick={() => approveJob(j)}
                                disabled={approvingId === j.id}
                                className="bg-green-600 text-white px-3 py-1 rounded-md text-xs font-medium hover:bg-green-700 disabled:opacity-50 mr-3"
                              >
                                {approvingId === j.id ? "Approving..." : "Approve"}
                              </button>
                            )}
                            <Link href={"/admin/jobs/" + j.id} className="text-blue-600 hover:text-blue-800 font-medium">Open</Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}