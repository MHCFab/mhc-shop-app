"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "../../lib/supabase";

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
  current_cost_per_foot: number;
  notes: string | null;
  is_active: boolean;
};

type Form = {
  shape: Shape;
  size: string;
  wall_thickness: string;
  grade: string;
  current_cost_per_foot: string;
  notes: string;
  is_active: boolean;
};

const emptyForm: Form = {
  shape: "square_tube",
  size: "",
  wall_thickness: "",
  grade: "Standard",
  current_cost_per_foot: "",
  notes: "",
  is_active: true,
};

function shapeLabel(shape: Shape) {
  return SHAPES.find((s) => s.value === shape)?.label || shape;
}

export default function RawMaterialsPage() {
  const supabase = createClient();
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterShape, setFilterShape] = useState<Shape | "all">("all");
  const [search, setSearch] = useState("");

  async function loadMaterials() {
    setLoading(true);
    const { data, error } = await supabase
      .from("raw_materials")
      .select("*")
      .order("shape")
      .order("size");
    if (error) {
      setError(error.message);
    } else {
      setMaterials(data || []);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadMaterials();
  }, []);

  const filtered = useMemo(() => {
    return materials.filter((m) => {
      if (filterShape !== "all" && m.shape !== filterShape) return false;
      if (search) {
        const s = search.toLowerCase();
        const text = (m.size + " " + (m.wall_thickness || "") + " " + m.grade).toLowerCase();
        if (!text.includes(s)) return false;
      }
      return true;
    });
  }, [materials, filterShape, search]);

  function openNew() {
    setForm(emptyForm);
    setEditingId(null);
    setError(null);
    setShowForm(true);
  }

  function openEdit(m: RawMaterial) {
    setForm({
      shape: m.shape,
      size: m.size,
      wall_thickness: m.wall_thickness || "",
      grade: m.grade,
      current_cost_per_foot: String(m.current_cost_per_foot),
      notes: m.notes || "",
      is_active: m.is_active,
    });
    setEditingId(m.id);
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

    const cost = parseFloat(form.current_cost_per_foot);
    if (!form.size.trim()) {
      setError("Size is required.");
      setSaving(false);
      return;
    }
    if (isNaN(cost) || cost < 0) {
      setError("Cost per foot must be a valid number.");
      setSaving(false);
      return;
    }

    const payload = {
      shape: form.shape,
      size: form.size.trim(),
      wall_thickness: form.wall_thickness.trim() || null,
      grade: form.grade.trim() || "Standard",
      current_cost_per_foot: cost,
      notes: form.notes.trim() || null,
      is_active: form.is_active,
    };

    const { error } = editingId
      ? await supabase.from("raw_materials").update(payload).eq("id", editingId)
      : await supabase.from("raw_materials").insert(payload);

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    closeForm();
    loadMaterials();
  }

  async function handleDelete(m: RawMaterial) {
    const ok = confirm("Delete " + shapeLabel(m.shape) + " " + m.size + "? This cannot be undone.");
    if (!ok) return;
    const { error } = await supabase.from("raw_materials").delete().eq("id", m.id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    loadMaterials();
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Raw Materials</h1>
          <p className="text-gray-600 mt-1">Catalog of every material type with current cost per foot.</p>
        </div>
        <button onClick={openNew} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors">
          Add material
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <select
          value={filterShape}
          onChange={(e) => setFilterShape(e.target.value as Shape | "all")}
          className="px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All shapes</option>
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search by size, wall, or grade..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">
            {materials.length === 0 ? "No materials yet. Click Add material to add your first one." : "No materials match your filters."}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Shape</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Size</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Wall</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Grade</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$/ft</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Status</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm text-gray-900">{shapeLabel(m.shape)}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 font-medium">{m.size}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{m.wall_thickness || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{m.grade}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${Number(m.current_cost_per_foot).toFixed(4)}</td>
                  <td className="px-4 py-3 text-sm">
                    {m.is_active ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Active</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-right">
                    <button onClick={() => openEdit(m)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">
                      Edit
                    </button>
                    <button onClick={() => handleDelete(m)} className="text-red-600 hover:text-red-800 font-medium">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSave} className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">{editingId ? "Edit material" : "Add material"}</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Shape <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={form.shape}
                    onChange={(e) => setForm({ ...form, shape: e.target.value as Shape })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {SHAPES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Size <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. 1.5 x 1.5"
                      value={form.size}
                      onChange={(e) => setForm({ ...form, size: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Wall thickness</label>
                    <input
                      type="text"
                      placeholder="e.g. .095"
                      value={form.wall_thickness}
                      onChange={(e) => setForm({ ...form, wall_thickness: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Grade</label>
                    <input
                      type="text"
                      placeholder="e.g. ERW, A500"
                      value={form.grade}
                      onChange={(e) => setForm({ ...form, grade: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Cost per foot <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      required
                      placeholder="0.00"
                      value={form.current_cost_per_foot}
                      onChange={(e) => setForm({ ...form, current_cost_per_foot: e.target.value })}
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

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Active (uncheck to hide from new jobs)</span>
                </label>

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