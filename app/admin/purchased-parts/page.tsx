"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "../../lib/supabase";

const CATEGORIES = [
  { value: "laser_part", label: "Laser Part" },
  { value: "fastener", label: "Fastener" },
  { value: "caster", label: "Caster" },
  { value: "machined_part", label: "Machined Part" },
  { value: "electrical", label: "Electrical" },
  { value: "hardware", label: "Hardware" },
  { value: "other", label: "Other" },
] as const;

type Category = (typeof CATEGORIES)[number]["value"];

type PurchasedPart = {
  id: string;
  name: string;
  part_number: string | null;
  category: Category;
  description: string | null;
  current_cost_each: number;
  notes: string | null;
  is_active: boolean;
};

type Form = {
  name: string;
  part_number: string;
  category: Category;
  description: string;
  current_cost_each: string;
  notes: string;
  is_active: boolean;
};

const emptyForm: Form = {
  name: "",
  part_number: "",
  category: "laser_part",
  description: "",
  current_cost_each: "",
  notes: "",
  is_active: true,
};

function categoryLabel(category: Category) {
  return CATEGORIES.find((c) => c.value === category)?.label || category;
}

export default function PurchasedPartsPage() {
  const supabase = createClient();
  const [parts, setParts] = useState<PurchasedPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterCategory, setFilterCategory] = useState<Category | "all">("all");
  const [search, setSearch] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);

  async function loadCompanyId() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("profiles")
      .select("company_id")
      .eq("id", user.id)
      .single();
    if (data) setCompanyId(data.company_id);
  }

  async function loadParts() {
    setLoading(true);
    const { data, error } = await supabase
      .from("purchased_parts")
      .select("*")
      .order("category")
      .order("name");
    if (error) {
      setError(error.message);
    } else {
      setParts(data || []);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadCompanyId();
    loadParts();
  }, []);

  const filtered = useMemo(() => {
    return parts.filter((p) => {
      if (filterCategory !== "all" && p.category !== filterCategory) return false;
      if (search) {
        const s = search.toLowerCase();
        const text = (p.name + " " + (p.part_number || "") + " " + (p.description || "")).toLowerCase();
        if (!text.includes(s)) return false;
      }
      return true;
    });
  }, [parts, filterCategory, search]);

  function openNew() {
    setForm(emptyForm);
    setEditingId(null);
    setError(null);
    setShowForm(true);
  }

  function openEdit(p: PurchasedPart) {
    setForm({
      name: p.name,
      part_number: p.part_number || "",
      category: p.category,
      description: p.description || "",
      current_cost_each: String(p.current_cost_each),
      notes: p.notes || "",
      is_active: p.is_active,
    });
    setEditingId(p.id);
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

    if (!form.name.trim()) {
      setError("Name is required.");
      setSaving(false);
      return;
    }
    const cost = parseFloat(form.current_cost_each);
    if (isNaN(cost) || cost < 0) {
      setError("Cost each must be a valid number.");
      setSaving(false);
      return;
    }

    if (!companyId) {
      setError("Could not determine your company. Try refreshing the page.");
      setSaving(false);
      return;
    }

    const payload = {
      name: form.name.trim(),
      part_number: form.part_number.trim() || null,
      category: form.category,
      description: form.description.trim() || null,
      current_cost_each: cost,
      notes: form.notes.trim() || null,
      is_active: form.is_active,
    };

    const { error } = editingId
      ? await supabase.from("purchased_parts").update(payload).eq("id", editingId)
      : await supabase.from("purchased_parts").insert({ ...payload, company_id: companyId });

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    closeForm();
    loadParts();
  }

  async function handleDelete(p: PurchasedPart) {
    const ok = confirm("Delete " + p.name + "? This cannot be undone.");
    if (!ok) return;
    const { error } = await supabase.from("purchased_parts").delete().eq("id", p.id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    loadParts();
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Purchased Parts</h1>
          <p className="text-gray-600 mt-1">Catalog of laser parts, fasteners, casters, machined parts, and more.</p>
        </div>
        <button onClick={openNew} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors">
          Add part
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value as Category | "all")}
          className="px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search by name, part number, or description..."
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
            {parts.length === 0 ? "No parts yet. Click Add part to add your first one." : "No parts match your filters."}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Name</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Part #</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Category</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Description</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$/each</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Status</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm text-gray-900 font-medium">{p.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{p.part_number || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{categoryLabel(p.category)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700 max-w-xs truncate">{p.description || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${Number(p.current_cost_each).toFixed(4)}</td>
                  <td className="px-4 py-3 text-sm">
                    {p.is_active ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Active</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-right">
                    <button onClick={() => openEdit(p)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">
                      Edit
                    </button>
                    <button onClick={() => handleDelete(p)} className="text-red-600 hover:text-red-800 font-medium">
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
              <h2 className="text-xl font-bold text-gray-900 mb-4">{editingId ? "Edit part" : "Add part"}</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 1/4-20 x 1in hex bolt"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Part number</label>
                    <input
                      type="text"
                      placeholder="e.g. McMaster 91290A537"
                      value={form.part_number}
                      onChange={(e) => setForm({ ...form, part_number: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Category <span className="text-red-600">*</span>
                    </label>
                    <select
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value as Category })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Cost each <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    required
                    placeholder="0.00"
                    value={form.current_cost_each}
                    onChange={(e) => setForm({ ...form, current_cost_each: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
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