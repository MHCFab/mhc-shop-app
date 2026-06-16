"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabase";

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
  created_at: string;
  customers: { id: string; name: string } | null;
  job_line_items: { id: string; quantity: number }[];
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
  const [filterStatus, setFilterStatus] = useState<Status | "all" | "open">("open");

  async function loadJobs() {
    setLoading(true);
    const { data, error } = await supabase
      .from("jobs")
      .select("*, customers(id, name), job_line_items(id, quantity)")
      .order("created_at", { ascending: false });
    if (error) setError(error.message);
    else setJobs((data || []) as Job[]);
    setLoading(false);
  }

  useEffect(() => {
    loadJobs();
  }, []);

  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (filterStatus === "open") {
        if (j.status === "complete") return false;
      } else if (filterStatus !== "all") {
        if (j.status !== filterStatus) return false;
      }
      if (search) {
        const s = search.toLowerCase();
        const text = (j.job_number + " " + (j.customer_po || "") + " " + (j.customers?.name || "")).toLowerCase();
        if (!text.includes(s)) return false;
      }
      return true;
    });
  }, [jobs, filterStatus, search]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Jobs</h1>
          <p className="text-gray-600 mt-1">Customer work orders. Each job builds one or more product templates.</p>
        </div>
        <Link
          href="/admin/jobs/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors"
        >
          New job
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as Status | "all" | "open")}
          className="px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="open">Open jobs (not shipped or cancelled)</option>
          <option value="all">All jobs</option>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search by job #, PO, or customer..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{error}</div>}

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">
            {jobs.length === 0 ? "No jobs yet. Click New job to create your first one." : "No jobs match your filters."}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Job #</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Customer</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">PO</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Line items</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Total units</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Status</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Due</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((j) => {
                const totalUnits = j.job_line_items.reduce((sum, li) => sum + Number(li.quantity), 0);
                return (
                  <tr key={j.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium">
                      <Link href={"/admin/jobs/" + j.id} className="text-blue-600 hover:text-blue-800">
                        {j.job_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">{j.customers?.name || "-"}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{j.customer_po || "-"}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{j.job_line_items.length}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{totalUnits}</td>
                    <td className="px-4 py-3 text-sm">{statusBadge(j.status)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{j.due_date || "-"}</td>
                    <td className="px-4 py-3 text-sm text-right">
                      <Link href={"/admin/jobs/" + j.id} className="text-blue-600 hover:text-blue-800 font-medium">Open</Link>
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