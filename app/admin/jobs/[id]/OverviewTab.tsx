"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "../../../lib/supabase";
import { recomputeJobPlan } from "../../../lib/job-generation";
import { syncEstimatedJobAllocations } from "../../../lib/inventory";

type LineItem = {
  id: string;
  quantity: number;
  notes: string | null;
  sort_order: number;
  name: string | null;
  unit_price: number | null;
  product_templates: {
    id: string;
    name: string;
    product_number: string | null;
  } | null;
};

type TemplateOption = { id: string; name: string; product_number: string | null };

type JobInfo = { status: string; customer_id: string; is_build_order: boolean | null };

export default function OverviewTab({
  jobId,
  jobStatus,
  isBuildOrder,
  onChanged,
}: {
  jobId: string;
  jobStatus?: string;
  isBuildOrder?: boolean | null;
  onChanged?: () => void;
}) {
  const supabase = createClient();
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesMessage, setNotesMessage] = useState<string | null>(null);

  // Adding another product to a job that already exists
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [jobInfo, setJobInfo] = useState<JobInfo | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [showAddList, setShowAddList] = useState(false);
  const [addPick, setAddPick] = useState<TemplateOption | null>(null);
  const [addQty, setAddQty] = useState("1");
  const [addPrice, setAddPrice] = useState("");
  const [savingAdd, setSavingAdd] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [liRes, jobRes, userRes] = await Promise.all([
      supabase
        .from("job_line_items")
        .select("*, product_templates(id, name, product_number)")
        .eq("job_id", jobId)
        .order("sort_order"),
      supabase.from("jobs").select("notes, status, customer_id, is_build_order").eq("id", jobId).single(),
      supabase.auth.getUser(),
    ]);
    setLineItems((liRes.data || []) as unknown as LineItem[]);
    const job = jobRes.data as unknown as (JobInfo & { notes: string | null }) | null;
    setNotes(job?.notes || "");
    setJobInfo(job ? { status: job.status, customer_id: job.customer_id, is_build_order: job.is_build_order } : null);

    const userId = userRes.data.user?.id;
    if (userId) {
      const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", userId).single();
      setCompanyId((profile as { company_id: string } | null)?.company_id || null);
    }

    // This customer's products, for the "add a product" picker
    if (job?.customer_id) {
      const { data: tplData } = await supabase
        .from("product_templates")
        .select("id, name, product_number")
        .eq("is_active", true)
        .eq("is_sub_assembly", false)
        .eq("customer_id", job.customer_id)
        .order("name");
      setTemplates((tplData || []) as unknown as TemplateOption[]);
    } else {
      setTemplates([]);
    }
    setLoading(false);
  }, [supabase, jobId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // A custom one-off has no template to plan from, and a build order manages its
  // own outputs, so neither takes extra products here.
  const isCustomJob = lineItems.length > 0 && lineItems.some((li) => li.product_templates === null);
  // Prefer the parent's live values -- it reloads on every status change, while
  // this tab only loads once.
  const effectiveStatus = jobStatus ?? jobInfo?.status;
  const effectiveIsBuild = isBuildOrder ?? jobInfo?.is_build_order;
  const canAddProduct =
    !!jobInfo &&
    !effectiveIsBuild &&
    !isCustomJob &&
    !!effectiveStatus &&
    ["ordered", "ready", "in_progress"].includes(effectiveStatus);

  const filteredTemplates = templates.filter((t) => {
    if (!addSearch) return true;
    const s = addSearch.toLowerCase();
    return (t.name + " " + (t.product_number || "")).toLowerCase().includes(s);
  });

  function openAdd() {
    setAddPick(null);
    setAddSearch("");
    setAddQty("1");
    setAddPrice("");
    setShowAddList(false);
    setAdding(true);
  }

  async function saveAddProduct() {
    if (!companyId) {
      alert("Could not determine your company. Try refreshing the page.");
      return;
    }
    if (!addPick) {
      alert("Pick a product to add.");
      return;
    }
    const qty = parseInt(addQty, 10);
    if (isNaN(qty) || qty < 1) {
      alert("Quantity must be at least 1.");
      return;
    }
    let price: number | null = null;
    if (addPrice.trim()) {
      const up = parseFloat(addPrice);
      if (isNaN(up) || up < 0) {
        alert("Price per unit must be 0 or more, or leave it blank to use the catalog price.");
        return;
      }
      price = up;
    }

    const alreadyOn = lineItems.some((li) => li.product_templates?.id === addPick.id);
    const ok = confirm(
      "Add " + qty + " x " + addPick.name + " to this job?\n\n" +
      (alreadyOn ? "This product is already on the job, so it will be added as a second line.\n\n" : "") +
      "Material and parts for it are added to the pick list, and tasks with the same name are combined into one shared task for the whole job. " +
      "Anything already picked, cut, logged or scrapped is left exactly as it is, and a task you had already ticked off reopens if there is now more to make.\n\n" +
      "Material already cut for this job keeps the amount it has reserved; the extra is reserved on top. You may need to cut or pull more.\n\n" +
      "There is no way to take a product back off a job yet, so check the product and quantity before you continue."
    );
    if (!ok) return;

    setSavingAdd(true);
    try {
      const nextSort = lineItems.reduce((max, li) => Math.max(max, Number(li.sort_order ?? 0)), -1) + 1;
      const { error: insErr } = await supabase.from("job_line_items").insert({
        company_id: companyId,
        job_id: jobId,
        product_template_id: addPick.id,
        quantity: qty,
        notes: null,
        sort_order: nextSort,
        name: null,
        unit_price: price,
      });
      if (insErr) throw new Error("Failed to add the product: " + insErr.message);

      // Re-plan material and tasks for every product now on the job, then bring
      // the inventory reservations back in line.
      await recomputeJobPlan(supabase, companyId, jobId);
      await syncEstimatedJobAllocations(jobId);

      setAdding(false);
      await loadData();
      if (onChanged) onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to add the product.");
    } finally {
      setSavingAdd(false);
    }
  }

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
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-gray-900">Line items</h3>
          {canAddProduct && !adding && (
            <button
              onClick={openAdd}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              + Add product
            </button>
          )}
        </div>

        {adding && (
          <div className="px-4 py-4 border-b border-gray-200 bg-blue-50/40 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Product</label>
              {templates.length === 0 ? (
                <p className="text-sm text-amber-700 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
                  This customer has no products in the catalog yet.
                </p>
              ) : (
                <div className="relative">
                  <input
                    type="text"
                    value={addSearch}
                    onChange={(e) => { setAddSearch(e.target.value); setShowAddList(true); setAddPick(null); }}
                    onFocus={() => setShowAddList(true)}
                    placeholder="Start typing to find a product..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {showAddList && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
                      {filteredTemplates.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-gray-500">No matching products.</p>
                      ) : (
                        filteredTemplates.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => { setAddPick(t); setAddSearch(t.name); setShowAddList(false); }}
                            className="block w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-blue-50"
                          >
                            {t.name}{t.product_number ? " (" + t.product_number + ")" : ""}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  {addPick && <p className="text-xs text-green-700 mt-1">Selected: {addPick.name}</p>}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={addQty}
                  onChange={(e) => setAddQty(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Price per unit</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={addPrice}
                  onChange={(e) => setAddPrice(e.target.value)}
                  placeholder="Blank = catalog price"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <p className="text-xs text-gray-500">
              The pick list and task estimates are worked out again for every product on the job. Picked amounts, cut material, logged time and scrap are kept.
            </p>

            <div className="flex gap-2">
              <button
                onClick={saveAddProduct}
                disabled={savingAdd || !addPick}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {savingAdd ? "Adding..." : "Add to job"}
              </button>
              <button
                onClick={() => setAdding(false)}
                disabled={savingAdd}
                className="px-3 py-2 text-sm border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {lineItems.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-600">No line items on this job.</p>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700 w-16">#</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Product</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Quantity</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Price / unit</th>
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
                    ) : li.name ? (
                      <span className="text-gray-900 font-medium">
                        {li.name}
                        <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">Custom</span>
                      </span>
                    ) : (
                      <span className="text-gray-500">Custom item</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{li.quantity}</td>
                  <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">
                    {li.unit_price != null ? "$" + Number(li.unit_price).toFixed(2) : "-"}
                  </td>
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