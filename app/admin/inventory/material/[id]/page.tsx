"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "../../../../lib/supabase";
import { highestCostOnHand, type CostLayer } from "../../../../lib/inventory";

const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
  flat_bar: "Flat Bar",
};

const SHAPES = [
  { value: "round_tube", label: "Round Tube" },
  { value: "square_tube", label: "Square Tube" },
  { value: "rectangle_tube", label: "Rectangle Tube" },
  { value: "channel", label: "Channel" },
  { value: "i_beam", label: "I-Beam" },
  { value: "angle", label: "Angle" },
  { value: "flat_bar", label: "Flat Bar" },
] as const;

type RawMaterial = {
  id: string;
  shape: string;
  size: string;
  wall_thickness: string | null;
  grade: string;
  current_cost_per_foot: number;
  is_active: boolean;
};

type Batch = {
  id: string;
  stick_length_feet: number;
  quantity_sticks: number;
  cost_per_foot: number;
  purchase_date: string;
  source_note: string | null;
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

type NestEntry = {
  job_id: string | null;
  entry_type: string | null;
  length_feet: number;
  quantity: number;
};

type LengthGroup = {
  length: number;
  sticks: number;
};

function describeMaterial(m: RawMaterial) {
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

function entryTypeLabel(t: string | null): string {
  switch (t) {
    case "purchase": return "Purchase";
    case "opening": return "Opening stock";
    case "drop": return "Drop returned";
    case "pull": return "Pulled for job";
    case "adjustment": return "Adjustment";
    case "reversal": return "Reversal";
    default: return "—";
  }
}

export default function MaterialDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const supabase = createClient();
  const router = useRouter();

  const [material, setMaterial] = useState<RawMaterial | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [nestEntries, setNestEntries] = useState<NestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [tab, setTab] = useState<"stock" | "history">("stock");

  // Manual adjustment modal
  const [showAdjust, setShowAdjust] = useState(false);
  const [adjustForm, setAdjustForm] = useState({
    stick_length_feet: "",
    quantity_sticks: "",
    cost_per_foot: "",
    note: "",
  });
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [savingAdjust, setSavingAdjust] = useState(false);

  // Edit material modal
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    shape: "round_tube",
    size: "",
    wall_thickness: "",
    grade: "",
    current_cost_per_foot: "",
    notes: "",
  });
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);

  // Edit / delete a single history entry (purchases, opening stock, adjustments)
  const [editEntry, setEditEntry] = useState<Batch | null>(null);
  const [entryForm, setEntryForm] = useState({ purchase_date: "", stick_length_feet: "", quantity_sticks: "", cost_per_foot: "", notes: "" });
  const [entryError, setEntryError] = useState<string | null>(null);
  const [savingEntry, setSavingEntry] = useState(false);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [matRes, batchRes, allocRes, nestRes] = await Promise.all([
      supabase.from("raw_materials").select("id, shape, size, wall_thickness, grade, current_cost_per_foot, is_active").eq("id", id).single(),
      supabase
        .from("raw_material_inventory")
        .select("id, stick_length_feet, quantity_sticks, cost_per_foot, purchase_date, source_note, notes, entry_type, suppliers(name)")
        .eq("raw_material_id", id)
        .order("purchase_date", { ascending: false }),
      supabase
        .from("inventory_allocations")
        .select("id, allocated_quantity, basis, jobs(id, job_number, status)")
        .eq("raw_material_id", id),
      // Cutting-nest pulls/drops for this material so each job's reservation can be netted
      // against what it has already physically pulled (finalized/cut jobs stop reserving).
      supabase
        .from("cutting_nest_entries")
        .select("job_id, entry_type, length_feet, quantity")
        .eq("raw_material_id", id),
    ]);

    if (matRes.error) {
      setError(matRes.error.message);
      setLoading(false);
      return;
    }
    setMaterial(matRes.data as RawMaterial);
    setBatches((batchRes.data || []) as unknown as Batch[]);
    setAllocations((allocRes.data || []) as unknown as Allocation[]);
    setNestEntries((nestRes.data || []) as unknown as NestEntry[]);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    loadCompanyId();
    loadData();
  }, [loadCompanyId, loadData]);

  // Group batches by length, summing sticks. Only include lengths with sticks actually on hand.
  const lengthGroups: LengthGroup[] = (() => {
    const map = new Map<number, number>();
    for (const b of batches) {
      const len = Number(b.stick_length_feet);
      map.set(len, (map.get(len) || 0) + Number(b.quantity_sticks));
    }
    return Array.from(map.entries())
      .map(([length, sticks]) => ({ length, sticks }))
      .filter((g) => g.sticks > 0)
      .sort((a, b) => b.length - a.length);
  })();

  const totalInStock = batches.reduce((sum, b) => sum + Number(b.stick_length_feet) * Number(b.quantity_sticks), 0);

  // Net feet each job has pulled for this material (pulls minus drops returned).
  const netPulledByJob = new Map<string, number>();
  for (const e of nestEntries) {
    if (!e.job_id) continue;
    const feet = Number(e.length_feet) * Number(e.quantity);
    if (e.entry_type === "pull") netPulledByJob.set(e.job_id, (netPulledByJob.get(e.job_id) || 0) + feet);
    else if (e.entry_type === "drop") netPulledByJob.set(e.job_id, (netPulledByJob.get(e.job_id) || 0) - feet);
  }

  // A reservation only holds the stock a job hasn't pulled yet: effective = max(0, reserved
  // − already pulled). Once a job has pulled its material (e.g. after finalizing its cutting
  // nest), it stops competing for this material. Fully-satisfied jobs drop off the list.
  const effectiveAllocations = allocations
    .map((a) => {
      const pulled = a.jobs ? netPulledByJob.get(a.jobs.id) || 0 : 0;
      return { ...a, effective: Math.max(0, Number(a.allocated_quantity) - pulled) };
    })
    .filter((a) => a.effective > 0.001);
  const totalAllocated = effectiveAllocations.reduce((sum, a) => sum + a.effective, 0);
  const available = totalInStock - totalAllocated;

  // Cost on hand: highest cost among purchase/opening layers still in stock.
  const costOnHand = (() => {
    if (!material) return 0;
    const layers: CostLayer[] = batches
      .filter((b) => (b.entry_type === "purchase" || b.entry_type === "opening") && Number(b.stick_length_feet) * Number(b.quantity_sticks) > 0)
      .map((b) => ({ date: b.purchase_date, qty: Number(b.stick_length_feet) * Number(b.quantity_sticks), cost: Number(b.cost_per_foot) }));
    const totalOut = batches.reduce((s, b) => {
      const f = Number(b.stick_length_feet) * Number(b.quantity_sticks);
      return f < 0 ? s + -f : s;
    }, 0);
    return highestCostOnHand(layers, totalOut, Number(material.current_cost_per_foot));
  })();

  async function saveAdjustment(e: React.FormEvent) {
    e.preventDefault();
    setAdjustError(null);
    if (!companyId) {
      setAdjustError("Could not determine your company. Try refreshing.");
      return;
    }
    const len = parseFloat(adjustForm.stick_length_feet);
    const qty = parseInt(adjustForm.quantity_sticks);
    const cost = parseFloat(adjustForm.cost_per_foot);
    if (isNaN(len) || len <= 0 || isNaN(qty) || isNaN(cost) || cost < 0) {
      setAdjustError("Enter a valid length, quantity, and cost per foot. Quantity can be negative to remove stock.");
      return;
    }
    setSavingAdjust(true);
    const { error } = await supabase.from("raw_material_inventory").insert({
      company_id: companyId,
      raw_material_id: id,
      supplier_id: null,
      stick_length_feet: len,
      quantity_sticks: qty,
      cost_per_foot: cost,
      purchase_date: new Date().toISOString().slice(0, 10),
      source_note: adjustForm.note.trim() || "Manual adjustment",
      notes: adjustForm.note.trim() || null,
      entry_type: "adjustment",
    });
    setSavingAdjust(false);
    if (error) {
      setAdjustError(error.message);
      return;
    }
    setShowAdjust(false);
    setAdjustForm({ stick_length_feet: "", quantity_sticks: "", cost_per_foot: "", note: "" });
    loadData();
  }

  function openEdit() {
    if (!material) return;
    setEditError(null);
    setEditForm({
      shape: material.shape,
      size: material.size,
      wall_thickness: material.wall_thickness || "",
      grade: material.grade,
      current_cost_per_foot: String(material.current_cost_per_foot),
      notes: "",
    });
    setShowEdit(true);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    setEditError(null);
    if (!editForm.size.trim() || !editForm.grade.trim()) {
      setEditError("Size and grade are required.");
      return;
    }
    const cost = parseFloat(editForm.current_cost_per_foot);
    if (isNaN(cost) || cost < 0) {
      setEditError("Please enter a valid cost per foot.");
      return;
    }
    setSavingEdit(true);
    const { error } = await supabase
      .from("raw_materials")
      .update({
        shape: editForm.shape,
        size: editForm.size.trim(),
        wall_thickness: editForm.wall_thickness.trim() || null,
        grade: editForm.grade.trim(),
        current_cost_per_foot: cost,
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
    if (!material) return;
    const next = !material.is_active;
    setTogglingActive(true);
    const { error } = await supabase
      .from("raw_materials")
      .update({ is_active: next })
      .eq("id", id);
    setTogglingActive(false);
    if (error) {
      alert("Could not update this material.\n\nDetails: " + error.message);
      return;
    }
    loadData();
  }

  async function handleDelete() {
    const ok = confirm(
      "Delete this material from your catalog? This also removes its inventory batches. If it's used by any product template or job, the delete will be blocked."
    );
    if (!ok) return;
    setDeleting(true);
    const { error } = await supabase.from("raw_materials").delete().eq("id", id);
    setDeleting(false);
    if (error) {
      alert(
        "Can't delete this material because it's used in a product template or job. Mark it inactive instead to hide it from new work.\n\nDetails: " + error.message
      );
      return;
    }
    router.push("/admin/inventory");
  }

  // Only manually-entered stock rows can be edited/deleted here. Job pulls, drops, and
  // reversals are owned by the cutting nest and must be changed from the job.
  const EDITABLE_ENTRY_TYPES = ["purchase", "opening", "adjustment"];
  function isEditableEntry(t: string | null): boolean {
    return t != null && EDITABLE_ENTRY_TYPES.includes(t);
  }

  function openEntryEdit(b: Batch) {
    setEntryError(null);
    setEntryForm({
      purchase_date: b.purchase_date,
      stick_length_feet: String(b.stick_length_feet),
      quantity_sticks: String(b.quantity_sticks),
      cost_per_foot: String(b.cost_per_foot),
      notes: b.notes || "",
    });
    setEditEntry(b);
  }

  async function saveEntryEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editEntry) return;
    setEntryError(null);
    const len = parseFloat(entryForm.stick_length_feet);
    const qty = parseInt(entryForm.quantity_sticks, 10);
    const cost = parseFloat(entryForm.cost_per_foot);
    if (isNaN(len) || len <= 0) { setEntryError("Enter a valid stick length."); return; }
    if (isNaN(qty)) { setEntryError("Enter a quantity (negative removes stock)."); return; }
    if (isNaN(cost) || cost < 0) { setEntryError("Enter a valid cost per foot."); return; }
    if (!entryForm.purchase_date) { setEntryError("Enter a date."); return; }
    setSavingEntry(true);
    const { error } = await supabase
      .from("raw_material_inventory")
      .update({
        purchase_date: entryForm.purchase_date,
        stick_length_feet: len,
        quantity_sticks: qty,
        cost_per_foot: cost,
        notes: entryForm.notes.trim() || null,
      })
      .eq("id", editEntry.id);
    setSavingEntry(false);
    if (error) { setEntryError(error.message); return; }
    setEditEntry(null);
    loadData();
  }

  async function deleteEntry(b: Batch) {
    const ok = confirm(
      "Delete this " + entryTypeLabel(b.entry_type).toLowerCase() + " entry from " + b.purchase_date +
      "?\n\nThis removes it from stock and from the cost history. This cannot be undone."
    );
    if (!ok) return;
    setDeletingEntryId(b.id);
    const { error } = await supabase.from("raw_material_inventory").delete().eq("id", b.id);
    setDeletingEntryId(null);
    if (error) { alert("Could not delete this entry.\n\nDetails: " + error.message); return; }
    loadData();
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  if (error || !material) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link href="/admin/inventory" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to inventory</Link>
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700">{error || "Material not found."}</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link href="/admin/inventory" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to inventory</Link>

      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold text-gray-900">{describeMaterial(material)}</h1>
            {!material.is_active && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">Inactive</span>
            )}
          </div>
          <p className="text-gray-500 mt-1">
            Cost on hand: ${costOnHand.toFixed(4)} / ft <span className="text-gray-400">(highest-cost stock you still hold)</span>
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setShowAdjust(true)} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 transition-colors">
            Adjust inventory
          </button>
          <button onClick={openEdit} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 transition-colors">
            Edit
          </button>
          <button onClick={toggleActive} disabled={togglingActive} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors">
            {togglingActive ? "Saving..." : material.is_active ? "Mark inactive" : "Reactivate"}
          </button>
          <button onClick={handleDelete} disabled={deleting} className="bg-white border border-red-300 text-red-600 px-4 py-2 rounded-md font-medium hover:bg-red-50 disabled:opacity-50 transition-colors">
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-blue-700 font-medium">Available</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{available.toFixed(2)} ft</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total in stock</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalInStock.toFixed(2)} ft</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Allocated to jobs</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalAllocated.toFixed(2)} ft</div>
        </div>
      </div>

      <div className="border-b border-gray-200 mb-6">
        <div className="flex gap-1">
          <button
            onClick={() => setTab("stock")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "stock" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            Stock
          </button>
          <button
            onClick={() => setTab("history")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "history" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            Purchase &amp; price history
          </button>
        </div>
      </div>

      {tab === "stock" && (
        <>
          <section className="bg-white border border-gray-200 rounded-lg overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h3 className="text-base font-semibold text-gray-900">Available lengths</h3>
              <p className="text-sm text-gray-600">How many sticks of each length you have on hand.</p>
            </div>
            {lengthGroups.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-600">No inventory in stock.</p>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Length</th>
                    <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Sticks</th>
                    <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Total feet</th>
                  </tr>
                </thead>
                <tbody>
                  {lengthGroups.map((g) => (
                    <tr key={g.length} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-3 text-sm text-gray-900 font-medium">{g.length.toFixed(2)} ft</td>
                      <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{g.sticks}</td>
                      <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{(g.length * g.sticks).toFixed(2)} ft</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {effectiveAllocations.length > 0 && (
            <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h3 className="text-base font-semibold text-gray-900">Allocated to jobs</h3>
              </div>
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Job</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Basis</th>
                    <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Allocated (ft)</th>
                  </tr>
                </thead>
                <tbody>
                  {effectiveAllocations.map((a) => (
                    <tr key={a.id} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-3 text-sm">
                        {a.jobs ? (
                          <Link href={"/admin/jobs/" + a.jobs.id} className="text-blue-600 hover:text-blue-800 font-medium">{a.jobs.job_number}</Link>
                        ) : "Unknown job"}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 capitalize">{a.basis}</td>
                      <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{a.effective.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {tab === "history" && (
        <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h3 className="text-base font-semibold text-gray-900">Purchase &amp; price history</h3>
            <p className="text-sm text-gray-600">Every stock movement, newest first. Only purchases and opening stock set the cost. You can edit or delete purchases, opening stock, and manual adjustments; job pulls and drops are managed from the job&apos;s cutting nest.</p>
          </div>
          {batches.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-600">No history yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Date</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Type</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Supplier</th>
                    <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Length</th>
                    <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Qty sticks</th>
                    <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Cost / ft</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
                    <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const qty = Number(b.quantity_sticks);
                    return (
                      <tr key={b.id} className="border-b border-gray-100 last:border-0">
                        <td className="px-4 py-3 text-sm text-gray-900">{b.purchase_date}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{entryTypeLabel(b.entry_type)}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{b.suppliers?.name || "-"}</td>
                        <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{Number(b.stick_length_feet).toFixed(2)} ft</td>
                        <td className={"px-4 py-3 text-sm text-right font-mono " + (qty < 0 ? "text-red-600" : "text-gray-900")}>{qty > 0 ? "+" : ""}{qty}</td>
                        <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${Number(b.cost_per_foot).toFixed(4)}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{b.notes || b.source_note || "-"}</td>
                        <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                          {isEditableEntry(b.entry_type) ? (
                            <span className="inline-flex gap-3 justify-end">
                              <button onClick={() => openEntryEdit(b)} className="text-blue-600 hover:text-blue-800 font-medium">Edit</button>
                              <button onClick={() => deleteEntry(b)} disabled={deletingEntryId === b.id} className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50">{deletingEntryId === b.id ? "Deleting..." : "Delete"}</button>
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {showAdjust && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <form onSubmit={saveAdjustment} className="p-6 space-y-3">
              <h2 className="text-xl font-bold text-gray-900">Adjust inventory</h2>
              <p className="text-sm text-gray-600">Add or remove stock manually. Use a negative quantity to remove sticks (for example after scrapping a damaged piece). Adjustments change quantity only and never change the cost.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Stick length (ft)</label>
                  <input type="number" step="0.01" min="0" value={adjustForm.stick_length_feet} onChange={(e) => setAdjustForm({ ...adjustForm, stick_length_feet: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Qty sticks (+/-)</label>
                  <input type="number" step="1" value={adjustForm.quantity_sticks} onChange={(e) => setAdjustForm({ ...adjustForm, quantity_sticks: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cost per foot</label>
                <input type="number" step="0.0001" min="0" value={adjustForm.cost_per_foot} onChange={(e) => setAdjustForm({ ...adjustForm, cost_per_foot: e.target.value })} placeholder={Number(material.current_cost_per_foot).toFixed(4)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason / note</label>
                <input type="text" value={adjustForm.note} onChange={(e) => setAdjustForm({ ...adjustForm, note: e.target.value })} placeholder="e.g. Damaged stick removed" className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
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
              <h2 className="text-xl font-bold text-gray-900">Edit material</h2>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Shape</label>
                <select
                  value={editForm.shape}
                  onChange={(e) => setEditForm({ ...editForm, shape: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SHAPES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Size</label>
                  <input type="text" value={editForm.size} onChange={(e) => setEditForm({ ...editForm, size: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Wall thickness</label>
                  <input type="text" value={editForm.wall_thickness} onChange={(e) => setEditForm({ ...editForm, wall_thickness: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Grade</label>
                  <input type="text" value={editForm.grade} onChange={(e) => setEditForm({ ...editForm, grade: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Current cost / ft <span className="text-gray-400 font-normal">(seed)</span></label>
                  <input type="number" step="0.0001" min="0" value={editForm.current_cost_per_foot} onChange={(e) => setEditForm({ ...editForm, current_cost_per_foot: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <p className="text-xs text-gray-500">Cost on hand is figured automatically from your purchases. This seed is only used before any stock has been purchased.</p>
              {editError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{editError}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowEdit(false)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Cancel</button>
                <button type="submit" disabled={savingEdit} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{savingEdit ? "Saving..." : "Save"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editEntry && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <form onSubmit={saveEntryEdit} className="p-6 space-y-3">
              <h2 className="text-xl font-bold text-gray-900">Edit {entryTypeLabel(editEntry.entry_type).toLowerCase()} entry</h2>
              <p className="text-sm text-gray-600">Fixing an entry recalculates your cost on hand automatically. Use a negative quantity to represent stock that was removed.</p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                <input type="date" value={entryForm.purchase_date} onChange={(e) => setEntryForm({ ...entryForm, purchase_date: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Stick length (ft)</label>
                  <input type="number" step="0.01" min="0" value={entryForm.stick_length_feet} onChange={(e) => setEntryForm({ ...entryForm, stick_length_feet: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Qty sticks (+/-)</label>
                  <input type="number" step="1" value={entryForm.quantity_sticks} onChange={(e) => setEntryForm({ ...entryForm, quantity_sticks: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cost per foot</label>
                <input type="number" step="0.0001" min="0" value={entryForm.cost_per_foot} onChange={(e) => setEntryForm({ ...entryForm, cost_per_foot: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input type="text" value={entryForm.notes} onChange={(e) => setEntryForm({ ...entryForm, notes: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              {entryError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{entryError}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditEntry(null)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Cancel</button>
                <button type="submit" disabled={savingEntry} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{savingEntry ? "Saving..." : "Save changes"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
