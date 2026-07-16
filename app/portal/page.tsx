"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "../lib/supabase";

// What each status means from the customer's point of view.
const STATUS_INFO: Record<string, { label: string; color: string }> = {
  pending: { label: "Awaiting approval", color: "bg-yellow-100 text-yellow-800" },
  ordered: { label: "Ordered", color: "bg-gray-100 text-gray-800" },
  ready: { label: "Released to shop", color: "bg-blue-100 text-blue-800" },
  in_progress: { label: "In production", color: "bg-amber-100 text-amber-800" },
};

type LineItem = {
  id: string;
  quantity: number;
  name: string | null;
  product_templates: { name: string } | null;
};

type Job = {
  id: string;
  job_number: string;
  customer_po: string | null;
  status: string;
  due_date: string | null;
  board_order: number;
  created_at: string;
  job_line_items: LineItem[];
};

function lineItemLabel(li: LineItem) {
  const name = li.name || li.product_templates?.name || "Item";
  return name + " × " + li.quantity;
}

export default function PortalJobsPage() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  async function loadJobs() {
    setLoading(true);
    const { data, error } = await supabase
      .from("jobs")
      .select("id, job_number, customer_po, status, due_date, board_order, created_at, job_line_items(id, quantity, name, product_templates(name))")
      .in("status", ["pending", "ordered", "ready", "in_progress"])
      .order("board_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) setError(error.message);
    else setJobs((data || []) as unknown as Job[]);
    setLoading(false);
  }

  useEffect(() => {
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cancelOrder(jobId: string) {
    setCancelBusy(true);
    setError(null);
    try {
      const res = await fetch("/portal/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", jobId }),
      });
      const result = await res.json();
      if (!res.ok || result.error) {
        setError(result.error || "Could not cancel that order.");
      }
    } catch {
      setError("Could not cancel that order. Please try again.");
    }
    setCancelBusy(false);
    setCancellingId(null);
    loadJobs();
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Your jobs</h1>
          <p className="text-gray-600 mt-1">
            Open jobs in shop priority order &mdash; #1 is up first. New orders show as
            &quot;Awaiting approval&quot; until we approve them.
          </p>
        </div>
        <Link
          href="/portal/order"
          className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors whitespace-nowrap"
        >
          Place order
        </Link>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{error}</div>}

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : jobs.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600 mb-3">No open jobs right now.</p>
          <Link href="/portal/order" className="text-blue-600 hover:text-blue-800 font-medium">Place an order</Link>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700 w-12">#</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Job #</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">PO</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Products</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Status</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Due</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700"></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j, idx) => {
                const status = STATUS_INFO[j.status] || { label: j.status, color: "bg-gray-100 text-gray-700" };
                const canEdit = j.status === "pending";
                const canCancel = j.status === "pending" || j.status === "ordered";
                return (
                  <tr key={j.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-500 font-mono">{idx + 1}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{j.job_number}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{j.customer_po || "-"}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {j.job_line_items.length === 0
                        ? "-"
                        : j.job_line_items.map((li) => (
                            <div key={li.id}>{lineItemLabel(li)}</div>
                          ))}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={"inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium " + status.color}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{j.due_date || "-"}</td>
                    <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                      {cancellingId === j.id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs text-gray-600">Cancel this order?</span>
                          <button
                            onClick={() => cancelOrder(j.id)}
                            disabled={cancelBusy}
                            className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
                          >
                            {cancelBusy ? "Cancelling..." : "Yes, cancel"}
                          </button>
                          <button
                            onClick={() => setCancellingId(null)}
                            disabled={cancelBusy}
                            className="text-gray-500 hover:text-gray-700 font-medium disabled:opacity-50"
                          >
                            No
                          </button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-3">
                          {canEdit && (
                            <Link href={"/portal/order/" + j.id} className="text-blue-600 hover:text-blue-800 font-medium">
                              Edit
                            </Link>
                          )}
                          {canCancel && (
                            <button
                              onClick={() => setCancellingId(j.id)}
                              className="text-red-600 hover:text-red-800 font-medium"
                            >
                              Cancel
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
