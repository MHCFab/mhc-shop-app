"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "../../../lib/supabase";

type LineItem = {
  id: string;
  quantity: number;
  notes: string | null;
  sort_order: number;
  product_templates: {
    id: string;
    name: string;
    product_number: string | null;
  } | null;
};

export default function OverviewTab({ jobId }: { jobId: string }) {
  const supabase = createClient();
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesMessage, setNotesMessage] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [liRes, jobRes] = await Promise.all([
      supabase
        .from("job_line_items")
        .select("*, product_templates(id, name, product_number)")
        .eq("job_id", jobId)
        .order("sort_order"),
      supabase.from("jobs").select("notes").eq("id", jobId).single(),
    ]);
    setLineItems((liRes.data || []) as unknown as LineItem[]);
    setNotes(jobRes.data?.notes || "");
    setLoading(false);
  }, [supabase, jobId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function saveNotes() {
    setSavingNotes(true);
    setNotesMessage(null);
    const { error } = await supabase
      .from("jobs")
      .update({ notes: notes.trim() || null })
      .eq("id", jobId);
    setSavingNotes(false);
    if (error) {
      setNotesMessage("Failed to save: " + error.message);
      return;
    }
    setNotesMessage("Saved.");
    setTimeout(() => setNotesMessage(null), 2000);
  }

  const totalUnits = lineItems.reduce((sum, li) => sum + Number(li.quantity), 0);

  if (loading) return <p className="text-gray-600">Loading...</p>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Line items</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{lineItems.length}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total units to build</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalUnits}</div>
        </div>
      </div>

      <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">Line items</h3>
        </div>
        {lineItems.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-600">No line items on this job.</p>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700 w-16">#</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Product</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Quantity</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li, i) => (
                <tr key={li.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm text-gray-500 font-mono">{i + 1}</td>
                  <td className="px-4 py-3 text-sm">
                    {li.product_templates ? (
                      <Link
                        href={"/admin/product-templates/" + li.product_templates.id}
                        className="text-blue-600 hover:text-blue-800 font-medium"
                      >
                        {li.product_templates.name}
                        {li.product_templates.product_number && (
                          <span className="text-gray-500 font-normal"> ({li.product_templates.product_number})</span>
                        )}
                      </Link>
                    ) : (
                      <span className="text-gray-500">Template unavailable</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{li.quantity}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{li.notes || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h3 className="text-base font-semibold text-gray-900 mb-3">Job notes</h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Add any notes about this job..."
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex items-center justify-end gap-3 mt-3">
          {notesMessage && (
            <span className={notesMessage.startsWith("Failed") ? "text-sm text-red-600" : "text-sm text-green-700"}>
              {notesMessage}
            </span>
          )}
          <button
            onClick={saveNotes}
            disabled={savingNotes}
            className="px-4 py-2 bg-blue-600 text-white rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {savingNotes ? "Saving..." : "Save notes"}
          </button>
        </div>
      </section>
    </div>
  );
}