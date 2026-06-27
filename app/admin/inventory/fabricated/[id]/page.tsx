"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "../../../../lib/supabase";
import { highestCostOnHand, type CostLayer } from "../../../../lib/inventory";

type Template = {
  id: string;
  name: string;
  product_number: string | null;
  is_active: boolean;
  is_stockable: boolean;
};

type LedgerRow = {
  id: string;
  quantity: number;
  cost_per_unit: number;
  source: string;
  notes: string | null;
  created_at: string;
};

function sourceLabel(s: string): string {
  switch (s) {
    case "build": return "Build received";
    case "opening": return "Opening stock";
    case "adjustment": return "Adjustment";
    case "consumption": return "Used on job";
    default: return s;
  }
}

export default function FabricatedDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const supabase = createClient();

  const [template, setTemplate] = useState<Template | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "history">("overview");

  const loadData = useCallback(async () => {
    setLoading(true);
    const [tplRes, ledgerRes] = await Promise.all([
      supabase.from("product_templates").select("id, name, product_number, is_active, is_stockable").eq("id", id).single(),
      supabase
        .from("fabricated_inventory")
        .select("id, quantity, cost_per_unit, source, notes, created_at")
        .eq("product_template_id", id)
        .order("created_at", { ascending: false }),
    ]);
    if (tplRes.error) {
      setError(tplRes.error.message);
      setLoading(false);
      return;
    }
    setTemplate(tplRes.data as Template);
    setLedger((ledgerRes.data || []) as unknown as LedgerRow[]);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onHand = ledger.reduce((s, r) => s + Number(r.quantity), 0);
  const costPerUnit = (() => {
    const layers: CostLayer[] = ledger
      .filter((r) => (r.source === "build" || r.source === "opening") && Number(r.quantity) > 0)
      .map((r) => ({ date: r.created_at, qty: Number(r.quantity), cost: Number(r.cost_per_unit) }));
    if (layers.length === 0) return null;
    const totalOut = ledger.reduce((s, r) => {
      const q = Number(r.quantity);
      return q < 0 ? s + -q : s;
    }, 0);
    return highestCostOnHand(layers, totalOut, 0);
  })();

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link href="/admin/inventory" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to inventory</Link>
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700">{error || "Item not found."}</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link href="/admin/inventory" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to inventory</Link>

      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold text-gray-900">{template.name}</h1>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">Fabricated</span>
            {!template.is_active && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">Inactive</span>
            )}
          </div>
          <p className="text-gray-500 mt-1">
            {template.product_number && <span>{template.product_number} &middot; </span>}
            {costPerUnit != null
              ? <>Cost on hand: ${costPerUnit.toFixed(2)} / unit <span className="text-gray-400">(highest-cost stock you still hold)</span></>
              : <span className="text-gray-400">No stock received yet</span>}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href={"/admin/product-templates/" + template.id} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 transition-colors">
            Open recipe
          </Link>
          <Link href="/admin/jobs/new" className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors">
            New build order
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-blue-700 font-medium">On hand</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{onHand.toFixed(0)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Cost / unit</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{costPerUnit != null ? "$" + costPerUnit.toFixed(2) : "—"}</div>
        </div>
      </div>

      <div className="border-b border-gray-200 mb-6">
        <div className="flex gap-1">
          <button
            onClick={() => setTab("overview")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "overview" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setTab("history")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "history" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            Build &amp; price history
          </button>
        </div>
      </div>

      {tab === "overview" && (
        <section className="bg-white border border-gray-200 rounded-lg p-5">
          <h3 className="text-base font-semibold text-gray-900 mb-2">About this fabricated item</h3>
          <p className="text-sm text-gray-700">
            This is a stockable sub-assembly. You build it to stock with a build order; receiving a completed
            build adds units here at the build&apos;s actual cost. Cost on hand follows the highest-cost-stock
            rule, the same as raw materials and parts.
          </p>
          <p className="text-sm text-gray-600 mt-3">
            Open the recipe to see its materials, parts, and tasks, or start a new build order to make more.
          </p>
        </section>
      )}

      {tab === "history" && (
        <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h3 className="text-base font-semibold text-gray-900">Build &amp; price history</h3>
            <p className="text-sm text-gray-600">Every stock movement, newest first. Builds and opening stock set the cost.</p>
          </div>
          {ledger.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-600">No history yet. Run a build order and receive it into stock.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Date</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Type</th>
                    <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Qty</th>
                    <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Cost / unit</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((r) => {
                    const qty = Number(r.quantity);
                    return (
                      <tr key={r.id} className="border-b border-gray-100 last:border-0">
                        <td className="px-4 py-3 text-sm text-gray-900">{r.created_at.slice(0, 10)}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{sourceLabel(r.source)}</td>
                        <td className={"px-4 py-3 text-sm text-right font-mono " + (qty < 0 ? "text-red-600" : "text-gray-900")}>{qty > 0 ? "+" : ""}{qty}</td>
                        <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${Number(r.cost_per_unit).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{r.notes || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
