"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "../../../../lib/supabase";

const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
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
};

type Batch = {
  id: string;
  stick_length_feet: number;
  quantity_sticks: number;
  cost_per_foot: number;
  purchase_date: string;
  source_note: string | null;
  notes: string | null;
  suppliers: { name: string } | null;
};

type Allocation = {
  id: string;
  allocated_quantity: number;
  basis: string;
  jobs: { id: string; job_number: string; status: string } | null;
};

type LengthGroup = {
  length: number;
  sticks: number;
};

function describeMaterial(m: RawMaterial) {
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

export default function MaterialDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const supabase = createClient();
  const router = useRouter();

  const [material, setMaterial] = useState<RawMaterial | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);

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

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [matRes, batchRes, allocRes] = await Promise.all([
      supabase.from("raw_materials").select("id, shape, size, wall_thickness, grade, current_cost_per_foot").eq("id", id).single(),
      supabase
        .from("raw_material_inventory")
        .select("id, stick_length_feet, quantity_sticks, cost_per_foot, purchase_date, source_note, notes, suppliers(name)")
        .eq("raw_material_id", id)
        .order("purchase_date", { ascending: false }),
      supabase
        .from("inventory_allocations")
        .select("id, allocated_quantity, basis, jobs(id, job_number, status)")
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
  const totalAllocated = allocations.reduce((sum, a) => sum + Number(a.allocated_quantity), 0);
  const available = totalInStock - totalAllocated;

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
          <h1 className="text-3xl font-bold text-gray-900">{describeMaterial(material)}</h1>
          <p className="text-gray-500 mt-1">Current catalog cost: ${Number(material.current_cost_per_foot).toFixed(4)} / ft</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setShowAdjust(true)} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 transition-colors">
            Adjust inventory
          </button>
          <button onClick={openEdit} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 transition-colors">
            Edit
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
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Allocated (ft)</th>
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
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(a.allocated_quantity).toFixed(2)}</td>
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
              <p className="text-sm text-gray-600">Add or remove stock manually. Use a negative quantity to remove sticks (for example after scrapping a damaged piece).</p>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Current cost / ft</label>
                  <input type="number" step="0.0001" min="0" value={editForm.current_cost_per_foot} onChange={(e) => setEditForm({ ...editForm, current_cost_per_foot: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
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