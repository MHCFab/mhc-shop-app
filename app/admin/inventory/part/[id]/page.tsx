"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "../../../../lib/supabase";
import { highestCostOnHand, type CostLayer } from "../../../../lib/inventory";

const CATEGORIES = [
  { value: "laser_part", label: "Laser Part" },
  { value: "fastener", label: "Fastener" },
  { value: "caster", label: "Caster" },
  { value: "machined_part", label: "Machined Part" },
  { value: "electrical", label: "Electrical" },
  { value: "hardware", label: "Hardware" },
  { value: "other", label: "Other" },
] as const;

function categoryLabel(c: string) {
  return CATEGORIES.find((x) => x.value === c)?.label || c;
}

type PurchasedPart = {
  id: string;
  name: string;
  part_number: string | null;
  category: string;
  description: string | null;
  current_cost_each: number;
  is_active: boolean;
  customer_id: string | null;
};

type Batch = {
  id: string;
  quantity: number;
  cost_each: number;
  purchase_date: string;
  notes: string | null;
  entry_type: string | null;
  suppliers: { name: string } | null;
};

type Allocation = {
  id: string;
  allocated_quantity: number;
  basis: string;
  jobs: { id: string; job_number: string; status: string } | null;
};

export default function PartDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const supabase = createClient();
  const router = useRouter();

  const [part, setPart] = useState<PurchasedPart | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);

  // Manual adjustment modal
  const [showAdjust, setShowAdjust] = useState(false);
  const [adjustForm, setAdjustForm] = useState({
    quantity: "",
    cost_each: "",
    note: "",
  });
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [savingAdjust, setSavingAdjust] = useState(false);

  // Edit part modal
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    part_number: "",
    category: "other",
    description: "",
    current_cost_each: "",
    customer_id: "",
  });
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [partRes, batchRes, allocRes, custRes] = await Promise.all([
      supabase.from("purchased_parts").select("id, name, part_number, category, description, current_cost_each, is_active, customer_id").eq("id", id).single(),
      supabase
        .from("purchased_parts_inventory")
        .select("id, quantity, cost_each, purchase_date, notes, entry_type, suppliers(name)")
        .eq("purchased_part_id", id)
        .order("purchase_date", { ascending: false }),
      supabase
        .from("inventory_allocations")
        .select("id, allocated_quantity, basis, jobs(id, job_number, status)")
        .eq("purchased_part_id", id),
      supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
    ]);

    if (partRes.error) {
      setError(partRes.error.message);
      setLoading(false);
      return;
    }
    setPart(partRes.data as PurchasedPart);
    setBatches((batchRes.data || []) as unknown as Batch[]);
    setAllocations((allocRes.data || []) as unknown as Allocation[]);
    setCustomers((custRes.data || []) as unknown as { id: string; name: string }[]);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    loadCompanyId();
    loadData();
  }, [loadCompanyId, loadData]);

  const totalInStock = batches.reduce((sum, b) => sum + Number(b.quantity), 0);
  const totalAllocated = allocations.reduce((sum, a) => sum + Number(a.allocated_quantity), 0);
  const available = totalInStock - totalAllocated;

  // Cost on hand: highest cost among purchase/opening layers still in stock.
  const costEach = (() => {
    if (!part) return 0;
    const layers: CostLayer[] = batches
      .filter((b) => (b.entry_type === "purchase" || b.entry_type === "opening") && Number(b.quantity) > 0)
      .map((b) => ({ date: b.purchase_date, qty: Number(b.quantity), cost: Number(b.cost_each) }));
    const totalOut = batches.reduce((s, b) => {
      const q = Number(b.quantity);
      return q < 0 ? s + -q : s;
    }, 0);
    return highestCostOnHand(layers, totalOut, Number(part.current_cost_each));
  })();

  async function saveAdjustment(e: React.FormEvent) {
    e.preventDefault();
    setAdjustError(null);
    if (!companyId) {
      setAdjustError("Could not determine your company. Try refreshing.");
      return;
    }
    const qty = parseInt(adjustForm.quantity);
    const cost = parseFloat(adjustForm.cost_each);
    if (isNaN(qty) || isNaN(cost) || cost < 0) {
      setAdjustError("Enter a valid quantity and cost each. Quantity can be negative to remove stock.");
      return;
    }
    setSavingAdjust(true);
    const { error } = await supabase.from("purchased_parts_inventory").insert({
      company_id: companyId,
      purchased_part_id: id,
      supplier_id: null,
      quantity: qty,
      cost_each: cost,
      purchase_date: new Date().toISOString().slice(0, 10),
      notes: adjustForm.note.trim() || "Manual adjustment",
      entry_type: "adjustment",
    });
    setSavingAdjust(false);
    if (error) {
      setAdjustError(error.message);
      return;
    }
    setShowAdjust(false);
    setAdjustForm({ quantity: "", cost_each: "", note: "" });
    loadData();
  }

  function openEdit() {
    if (!part) return;
    setEditError(null);
    setEditForm({
      name: part.name,
      part_number: part.part_number || "",
      category: part.category,
      description: part.description || "",
      current_cost_each: String(part.current_cost_each),
      customer_id: part.customer_id || "",
    });
    setShowEdit(true);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    setEditError(null);
    if (!editForm.name.trim()) {
      setEditError("Name is required.");
      return;
    }
    const cost = parseFloat(editForm.current_cost_each);
    if (isNaN(cost) || cost < 0) {
      setEditError("Please enter a valid cost each.");
      return;
    }
    setSavingEdit(true);
    const { error } = await supabase
      .from("purchased_parts")
      .update({
        name: editForm.name.trim(),
        part_number: editForm.part_number.trim() || null,
        category: editForm.category,
        description: editForm.description.trim() || null,
        current_cost_each: cost,
        customer_id: editForm.customer_id || null,
      })
      .eq("id", id);
    setSavingEdit(false);
    if (error) {
      setEditError(error.message);
      return;
    }
    setShowEdit(false);
    loadData();
  }

  async function toggleActive() {
    if (!part) return;
    const next = !part.is_active;
    setTogglingActive(true);
    const { error } = await supabase
      .from("purchased_parts")
      .update({ is_active: next })
      .eq("id", id);
    setTogglingActive(false);
    if (error) {
      alert("Could not update this part.\n\nDetails: " + error.message);
      return;
    }
    loadData();
  }

  async function handleDelete() {
    if (!part) return;
    setDeleting(true);

    // 1) Check whether the part is genuinely in use anywhere that must NOT be
    //    silently rewritten: a product template's BOM, a job's pick list, or a
    //    job's scrap log. (Invoiced/archived jobs keep a text fallback and have no
    //    foreign key here, so they don't block.)
    const [tplRes, pickRes, varRes] = await Promise.all([
      supabase.from("product_template_parts").select("purchased_part_id", { count: "exact", head: true }).eq("purchased_part_id", id),
      supabase.from("job_pick_list_items").select("purchased_part_id", { count: "exact", head: true }).eq("purchased_part_id", id),
      supabase.from("job_material_variances").select("purchased_part_id", { count: "exact", head: true }).eq("purchased_part_id", id),
    ]);

    const checkErr = tplRes.error || pickRes.error || varRes.error;
    if (checkErr) {
      setDeleting(false);
      alert("Couldn't check whether this part is in use, so it wasn't deleted.\n\nDetails: " + checkErr.message);
      return;
    }

    const usedTemplates = tplRes.count || 0;
    const usedJobs = pickRes.count || 0;
    const usedScrap = varRes.count || 0;

    if (usedTemplates + usedJobs + usedScrap > 0) {
      const reasons: string[] = [];
      if (usedTemplates > 0) reasons.push(usedTemplates + " product template" + (usedTemplates === 1 ? "" : "s"));
      if (usedJobs > 0) reasons.push(usedJobs + " job pick list" + (usedJobs === 1 ? "" : "s"));
      if (usedScrap > 0) reasons.push("scrap logged on " + usedScrap + " job " + (usedScrap === 1 ? "entry" : "entries"));
      setDeleting(false);
      alert(
        'Can\'t delete "' + part.name + '" because it\'s still in use: ' + reasons.join(", ") + ".\n\n" +
        "Deleting it would change past job costs and records, so it's blocked. Use \"Mark inactive\" to hide it from new work while keeping its history intact."
      );
      return;
    }

    // 2) Safe to remove. Confirm, then clear the part's own purchase/adjustment
    //    history (its only remaining references). Allocations cascade automatically.
    const ok = confirm(
      'Delete "' + part.name + '" from your catalog? This also removes its purchase and adjustment history. This cannot be undone.'
    );
    if (!ok) {
      setDeleting(false);
      return;
    }

    const { error: invErr } = await supabase.from("purchased_parts_inventory").delete().eq("purchased_part_id", id);
    if (invErr) {
      setDeleting(false);
      alert("Couldn't remove this part's inventory history, so it wasn't deleted.\n\nDetails: " + invErr.message);
      return;
    }

    const { error: delErr } = await supabase.from("purchased_parts").delete().eq("id", id);
    setDeleting(false);
    if (delErr) {
      alert("Couldn't delete this part.\n\nDetails: " + delErr.message);
      return;
    }
    router.push("/admin/inventory");
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  if (error || !part) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link href="/admin/inventory" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to inventory</Link>
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700">{error || "Part not found."}</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link href="/admin/inventory" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to inventory</Link>

      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold text-gray-900">{part.name}</h1>
            {!part.is_active && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">Inactive</span>
            )}
          </div>
          <p className="text-gray-500 mt-1">
            {part.part_number && <span>{part.part_number} &middot; </span>}
            {categoryLabel(part.category)} &middot; ${costEach.toFixed(4)} each <span className="text-gray-400">(cost on hand)</span>
            {part.customer_id && <span> &middot; {customers.find((c) => c.id === part.customer_id)?.name || "Unknown customer"}</span>}
          </p>
          {part.description && <p className="text-gray-700 mt-2 max-w-2xl">{part.description}</p>}
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setShowAdjust(true)} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 transition-colors">
            Adjust inventory
          </button>
          <button onClick={openEdit} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 transition-colors">
            Edit
          </button>
          <button onClick={toggleActive} disabled={togglingActive} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors">
            {togglingActive ? "Saving..." : part.is_active ? "Mark inactive" : "Reactivate"}
          </button>
          <button onClick={handleDelete} disabled={deleting} className="bg-white border border-red-300 text-red-600 px-4 py-2 rounded-md font-medium hover:bg-red-50 disabled:opacity-50 transition-colors">
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-blue-700 font-medium">Available</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{available.toFixed(0)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total in stock</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalInStock.toFixed(0)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Allocated to jobs</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalAllocated.toFixed(0)}</div>
        </div>
      </div>

      <section className="bg-white border border-gray-200 rounded-lg overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">Purchase history</h3>
        </div>
        {batches.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-600">No purchases recorded.</p>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Date</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Supplier</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Quantity</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Cost each</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm text-gray-900">{b.purchase_date}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{b.suppliers?.name || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(b.quantity).toFixed(0)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${Number(b.cost_each).toFixed(4)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{b.notes || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {allocations.length > 0 && (
        <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h3 className="text-base font-semibold text-gray-900">Allocated to jobs</h3>
          </div>
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Job</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Basis</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Allocated</th>
              </tr>
            </thead>
            <tbody>
              {allocations.map((a) => (
                <tr key={a.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm">
                    {a.jobs ? (
                      <Link href={"/admin/jobs/" + a.jobs.id} className="text-blue-600 hover:text-blue-800 font-medium">{a.jobs.job_number}</Link>
                    ) : "Unknown job"}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 capitalize">{a.basis}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(a.allocated_quantity).toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {showAdjust && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <form onSubmit={saveAdjustment} className="p-6 space-y-3">
              <h2 className="text-xl font-bold text-gray-900">Adjust inventory</h2>
              <p className="text-sm text-gray-600">Add or remove stock manually. Use a negative quantity to remove parts (for example after a miscount or using some outside a job).</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Qty (+/-)</label>
                  <input type="number" step="1" value={adjustForm.quantity} onChange={(e) => setAdjustForm({ ...adjustForm, quantity: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Cost each</label>
                  <input type="number" step="0.0001" min="0" value={adjustForm.cost_each} onChange={(e) => setAdjustForm({ ...adjustForm, cost_each: e.target.value })} placeholder={Number(part.current_cost_each).toFixed(4)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason / note</label>
                <input type="text" value={adjustForm.note} onChange={(e) => setAdjustForm({ ...adjustForm, note: e.target.value })} placeholder="e.g. Found extra box in storage" className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              {adjustError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{adjustError}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAdjust(false)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Cancel</button>
                <button type="submit" disabled={savingAdjust} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{savingAdjust ? "Saving..." : "Save"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEdit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <form onSubmit={saveEdit} className="p-6 space-y-3">
              <h2 className="text-xl font-bold text-gray-900">Edit part</h2>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Part number</label>
                  <input type="text" value={editForm.part_number} onChange={(e) => setEditForm({ ...editForm, part_number: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select
                    value={editForm.category}
                    onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Current cost each</label>
                <input type="number" step="0.0001" min="0" value={editForm.current_cost_each} onChange={(e) => setEditForm({ ...editForm, current_cost_each: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input type="text" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Customer <span className="text-gray-400 font-normal">(optional)</span></label>
                <select value={editForm.customer_id} onChange={(e) => setEditForm({ ...editForm, customer_id: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">&mdash; None &mdash;</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Set this for any part that belongs to a specific customer.</p>
              </div>
              {editError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{editError}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowEdit(false)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Cancel</button>
                <button type="submit" disabled={savingEdit} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{savingEdit ? "Saving..." : "Save"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}