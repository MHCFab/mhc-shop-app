"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../lib/supabase";

type ArchiveRow = {
  id: string;
  job_number: string;
  customer_name: string | null;
  customer_po: string | null;
  completed_on: string | null;
  invoiced_on: string;
  labor_cost: number;
  material_cost: number;
  parts_cost: number;
  scrap_cost: number;
  total_actual: number;
  total_estimate: number;
  variance_amount: number;
  variance_percent: number;
  labor_minutes: number;
  burden_rate: number;
};

function money(n: number) {
  return "$" + Number(n).toFixed(2);
}

export default function ArchivePage() {
  const supabase = createClient();
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("completed_jobs_archive")
      .select("*")
      .order("invoiced_on", { ascending: false });
    setRows((data || []) as ArchiveRow[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = rows.filter((r) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (r.job_number + " " + (r.customer_name || "")).toLowerCase().includes(s);
  });

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Archive</h1>
        <p className="text-gray-600 mt-1">Invoiced jobs and their final cost summaries. Read-only history.</p>
      </div>

      <input
        type="text"
        placeholder="Search by job # or customer..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
      />

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">{rows.length === 0 ? "No invoiced jobs yet." : "No jobs match your search."}</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Job #</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Customer</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Invoiced</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Cost</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Estimate</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Variance</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <>
                  <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{r.job_number}</td>
                    <td className="px-4 py-3 text-sm text-gray-900">{r.customer_name || "-"}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{new Date(r.invoiced_on).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{money(r.total_actual)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{money(r.total_estimate)}</td>
                    <td className={"px-4 py-3 text-sm text-right font-mono " + (r.variance_amount > 0 ? "text-red-600" : "text-green-700")}>
                      {money(r.variance_amount)} ({r.variance_percent.toFixed(0)}%)
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      <button onClick={() => setExpanded(expanded === r.id ? null : r.id)} className="text-blue-600 hover:text-blue-800 font-medium">
                        {expanded === r.id ? "Hide" : "Details"}
                      </button>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <td colSpan={7} className="px-4 py-4">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                          <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Labor</div>
                            <div className="font-mono text-gray-900 mt-1">{money(r.labor_cost)}</div>
                            <div className="text-xs text-gray-500">{(r.labor_minutes / 60).toFixed(2)} hrs @ {money(r.burden_rate)}/hr</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Material</div>
                            <div className="font-mono text-gray-900 mt-1">{money(r.material_cost)}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Parts</div>
                            <div className="font-mono text-gray-900 mt-1">{money(r.parts_cost)}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Scrap (incl. above)</div>
                            <div className="font-mono text-gray-900 mt-1">{money(r.scrap_cost)}</div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}