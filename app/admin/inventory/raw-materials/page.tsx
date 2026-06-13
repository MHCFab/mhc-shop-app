"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "../../../lib/supabase";

const SHAPES = [
  { value: "round_tube", label: "Round Tube" },
  { value: "square_tube", label: "Square Tube" },
  { value: "rectangle_tube", label: "Rectangle Tube" },
  { value: "channel", label: "Channel" },
  { value: "i_beam", label: "I-Beam" },
  { value: "angle", label: "Angle" },
] as const;

type Shape = (typeof SHAPES)[number]["value"];

type RawMaterial = {
  id: string;
  shape: Shape;
  size: string;
  wall_thickness: string | null;
  grade: string;
  is_active: boolean;
};

type Supplier = {
  id: string;
  name: string;
};

type InventoryBatch = {
  id: string;
  raw_material_id: string;
  supplier_id: string | null;
  stick_length_feet: number;
  quantity_sticks: number;
  cost_per_foot: number;
  purchase_date: string | null;
  notes: string | null;
  raw_materials: RawMaterial | null;
  suppliers: Supplier | null;
};

type Form = {
  raw_material_id: string;
  supplier_id: string;
  stick_length_feet: string;
  quantity_sticks: string;
  cost_per_foot: string;
  purchase_date: string;
  notes: string;
};

const emptyForm: Form = {
  raw_material_id: "",
  supplier_id: "",
  stick_length_feet: "",
  quantity_sticks: "",
  cost_per_foot: "",
  purchase_date: "",
  notes: "",
};

function shapeLabel(shape: Shape) {
  return SHAPES.find((s) => s.value === shape)?.label || shape;
}

function describeMaterial(m: RawMaterial | null) {
  if (!m) return "Unknown material";
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return shapeLabel(m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

export default function RawMaterialInventoryPage() {
  const supabase = createClient();
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  async function loadAll() {
    setLoading(true);
    const [batchesRes, matsRes, supsRes] = await Promise.all([
      supabase
        .from("raw_material_inventory")
        .select("*, raw_materials(id, shape, size, wall_thickness, grade, is_active), suppliers(id, name)")
        .order("purchase_date", { ascending: false }),
      supabase.from("raw_materials").select("id, shape, size, wall_thickness, grade, is_active").eq("is_active", true).order("shape").order("size"),
      supabase.from("suppliers").select("id, name").order("name"),
    ]);

    if (batchesRes.error) setError(batchesRes.error.message);
    else setBatches((batchesRes.data || []) as InventoryBatch[]);

    if (matsRes.data) setMaterials(matsRes.data as RawMaterial[]);
    if (supsRes.data) setSuppliers(supsRes.data as Supplier[]);

    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  const filtered = useMemo(() => {
    if (!search) return batches;
    const s = search.toLowerCase();
    return batches.filter((b) => {
      const text = (describeMaterial(b.raw_materials) + " " + (b.suppliers?.name || "")).toLowerCase();
      return text.includes(s);
    });
  }, [batches, search]);

  function openNew() {
    setForm({ ...emptyForm, purchase_date: new Date().toISOString().slice(0, 10) });
    setEditingId(null);
    setError(null);
    setShowForm(true);
  }

  function openEdit(b: InventoryBatch) {
    setForm({
      raw_material_id: b.raw_material_id,
      supplier_id: b.supplier_id || "",
      stick_length_feet: String(b.stick_length_feet),
      quantity_sticks: String(b.quantity_sticks),
      cost_per_foot: String(b.cost_per_foot),
      purchase_date: b.purchase_date || "",
      notes: b.notes || "",
    });
    setEditingId(b.id);
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    if (!form.raw_material_id) {
      setError("Please select a material.");
      setSaving(false);
      return;
    }
    const stickLength = parseFloat(form.stick_length_feet);
    const qty = parseFloat(form.quantity_sticks);
    const cost = parseFloat(form.cost_per_foot);

    if (isNaN(stickLength) || stickLength <= 0) {
      setError("Stick length must be greater than 0.");
      setSaving(false);
      return;
    }
    if (isNaN(qty) || qty < 0) {
      setError("Quantity must be 0 or more.");
      setSaving(false);
      return;
    }
    if (isNaN(cost) || cost < 0) {
      setError("Cost per foot must be a valid number.");
      setSaving(false);
      return;
    }

    const payload = {
      raw_material_id: form.raw_material_id,
      supplier_id: form.supplier_id || null,
      stick_length_feet: stickLength,
      quantity_sticks: qty,
      cost_per_foot: cost,
      purchase_date: form.purchase_date || null,
      notes: form.notes.trim() || null,
    };

    const { error } = editingId
      ? await supabase.from("raw_material_inventory").update(payload).eq("id", editingId)
      : await supabase.from("raw_material_inventory").insert(payload);

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    closeForm();
    loadAll();
  }

  async function handleDelete(b: InventoryBatch) {
    const ok = confirm("Delete this inventory batch? This cannot be undone.");
    if (!ok) return;
    const { error } = await supabase.from("raw_material_inventory").delete().eq("id", b.id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    loadAll();
  }

  const totalSticks = filtered.reduce((sum, b) => sum + Number(b.quantity_sticks), 0);
  const totalFeet = filtered.reduce((sum, b) => sum + Number(b.quantity_sticks) * Number(b.stick_length_feet), 0);
  const totalValue = filtered.reduce((sum, b) => sum + Number(b.quantity_sticks) * Number(b.stick_length_feet) * Number(b.cost_per_foot), 0);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Raw Material Inventory</h1>
          <p className="text-gray-600 mt-1">Track stick lengths, quantities on hand, purchase price, and supplier per batch.</p>
        </div>
        <button
          onClick={openNew}
          disabled={materials.length === 0}
          className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={materials.length === 0 ? "Add a raw material first" : ""}
        >
          Add inventory batch
        </button>
      </div>

      {materials.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-4">
          <p className="text-sm text-amber-800">You need to add at least one raw material before you can record inventory. Go to the Raw Materials page to add some.</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total sticks</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalSticks.toFixed(0)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total feet</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalFeet.toFixed(1)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Inventory value</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${totalValue.toFixed(2)}</div>
        </div>
      </div>

      <input
        type="text"
        placeholder="Search by material or supplier..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
      />

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">
            {batches.length === 0 ? "No inventory batches yet. Click Add inventory batch to record your first purchase." : "No batches match your search."}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Material</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Supplier</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Stick length</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Qty sticks</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$/ft paid</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Total feet</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Batch value</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Purchased</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((b) => {
                const feet = Number(b.quantity_sticks) * Number(b.stick_length_feet);
                const value = feet * Number(b.cost_per_foot);
                return (
                  <tr key={b.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-900 font-medium">{describeMaterial(b.raw_materials)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{b.suppliers?.name || "-"}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{Number(b.stick_length_feet).toFixed(2)} ft</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(b.quantity_sticks).toFixed(0)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${Number(b.cost_per_foot).toFixed(4)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{feet.toFixed(1)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${value.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{b.purchase_date || "-"}</td>
                    <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                      <button onClick={() => openEdit(b)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">
                        Edit
                      </button>
                      <button onClick={() => handleDelete(b)} className="text-red-600 hover:text-red-800 font-medium">
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSave} className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">{editingId ? "Edit inventory batch" : "Add inventory batch"}</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Material <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={form.raw_material_id}
                    onChange={(e) => setForm({ ...form, raw_material_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  >
                    <option value="">-- Select a material --</option>
                    {materials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {describeMaterial(m)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
                  <select
                    value={form.supplier_id}
                    onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- None / Unknown --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Stick length (ft) <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      placeholder="e.g. 20"
                      value={form.stick_length_feet}
                      onChange={(e) => setForm({ ...form, stick_length_feet: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Quantity (sticks) <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      required
                      placeholder="e.g. 10"
                      value={form.quantity_sticks}
                      onChange={(e) => setForm({ ...form, quantity_sticks: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Cost per foot (paid) <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      required
                      placeholder="0.00"
                      value={form.cost_per_foot}
                      onChange={(e) => setForm({ ...form, cost_per_foot: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Purchase date</label>
                    <input
                      type="date"
                      value={form.purchase_date}
                      onChange={(e) => setForm({ ...form, purchase_date: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}
              </div>

              <div className="flex justify-end gap-2 mt-6">
                <button type="button" onClick={closeForm} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}