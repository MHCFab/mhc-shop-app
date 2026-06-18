"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabase";
import { getJobCostReport } from "../../lib/inventory";

type Job = {
  id: string;
  job_number: string;
  customer_po: string | null;
  completed_at: string | null;
  customers: { name: string } | null;
};

type Row = Job & {
  cost: number;
  retail: number;
  profit: number;
};

export default function InvoicesPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("jobs")
      .select("id, job_number, customer_po, completed_at, customers(name)")
      .eq("status", "complete")
      .order("completed_at", { ascending: true });

      const jobs = (data || []) as unknown as Job[];

    // Compute a quick cost/retail/profit per job for the list
    const withCost: Row[] = await Promise.all(
      jobs.map(async (j) => {
        try {
          const r = await getJobCostReport(j.id);
          return { ...j, cost: r.totalActualCost, retail: r.retailTotal, profit: r.netProfitTotal };
        } catch {
          return { ...j, cost: 0, retail: 0, profit: 0 };
        }
      })
    );

    setRows(withCost);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Invoices</h1>
        <p className="text-gray-600 mt-1">Completed jobs ready to invoice. Open one to review its cost report, then mark it invoiced.</p>
      </div>

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No completed jobs waiting to be invoiced.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Job #</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Customer</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Completed</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Cost</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Retail</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Profit</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium">
                    <Link href={"/admin/jobs/" + j.id} className="text-blue-600 hover:text-blue-800">{j.job_number}</Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">{j.customers?.name || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{j.completed_at ? new Date(j.completed_at).toLocaleDateString() : "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${j.cost.toFixed(2)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${j.retail.toFixed(2)}</td>
                  <td className={"px-4 py-3 text-sm text-right font-mono font-semibold " + (j.profit >= 0 ? "text-green-700" : "text-red-600")}>${j.profit.toFixed(2)}</td>
                  <td className="px-4 py-3 text-sm text-right">
                    <Link href={"/admin/jobs/" + j.id} className="text-blue-600 hover:text-blue-800 font-medium">Review</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}