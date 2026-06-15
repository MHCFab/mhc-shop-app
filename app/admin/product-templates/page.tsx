"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabase";

type ProductTemplate = {
  id: string;
  name: string;
  product_number: string | null;
  description: string | null;
  is_active: boolean;
  is_sub_assembly: boolean;
  created_at: string;
};

type Form = {
  name: string;
  product_number: string;
  description: string;
  is_active: boolean;
  is_sub_assembly: boolean;
};

const emptyForm: Form = {
  name: "",
  product_number: "",
  description: "",
  is_active: true,
  is_sub_assembly: false,
};

export default function ProductTemplatesPage() {
  const supabase = createClient();
  const [templates, setTemplates] = useState<ProductTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "products" | "sub_assemblies">("all");
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

  async function loadTemplates() {
    setLoading(true);
    const { data, error } = await supabase
      .from("product_templates")
      .select("*")
      .order("name");
    if (error) setError(error.message);
    else setTemplates(data || []);
    setLoading(false);
  }

  useEffect(() => {
    loadCompanyId();
    loadTemplates();
  }, []);

  const filtered = useMemo(() => {
    return templates.filter((t) => {
      if (filterType === "products" && t.is_sub_assembly) return false;
      if (filterType === "sub_assemblies" && !t.is_sub_assembly) return false;
      if (search) {
        const s = search.toLowerCase();
        const text = (t.name + " " + (t.product_number || "") + " " + (t.description || "")).toLowerCase();
        if (!text.includes(s)) return false;
      }
      return true;
    });
  }, [templates, search, filterType]);

  function openNew() {
    setForm(emptyForm);
    setEditingId(null);
    setError(null);
    setShowForm(true);
  }

  function openEdit(t: ProductTemplate) {
    setForm({
      name: t.name,
      product_number: t.product_number || "",
      description: t.description || "",
      is_active: t.is_active,
      is_sub_assembly: t.is_sub_assembly,
    });
    setEditingId(t.id);
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
    if (!companyId) {
      setError("Could not determine your company. Try refreshing the page.");
      setSaving(false);
      return;
    }

    const payload = {
      name: form.name.trim(),
      product_number: form.product_number.trim() || null,
      description: form.description.trim() || null,
      is_active: form.is_active,
      is_sub_assembly: form.is_sub_assembly,
    };

    const { error } = editingId
      ? await supabase.from("product_templates").update(payload).eq("id", editingId)
      : await supabase.from("product_templates").insert({ ...payload, company_id: companyId });

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    closeForm();
    loadTemplates();
  }

  async function handleDelete(t: ProductTemplate) {
    const ok = confirm(
      "Delete " + t.name + "? This will also delete all materials, parts, tasks, photos, and notes attached to it. This cannot be undone."
    );
    if (!ok) return;
    const { error } = await supabase.from("product_templates").delete().eq("id", t.id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    loadTemplates();
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Product Templates</h1>
          <p className="text-gray-600 mt-1">
            Recipes for each product, including materials, parts, sub-assemblies, tasks, photos, SOPs, and build notes.
          </p>
        </div>
        <button onClick={openNew} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors">
          Add product template
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as "all" | "products" | "sub_assemblies")}
          className="px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All templates</option>
          <option value="products">Products only</option>
          <option value="sub_assemblies">Sub-assemblies only</option>
        </select>
        <input
          type="text"
          placeholder="Search by name, product number, or description..."
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
            {templates.length === 0
              ? "No product templates yet. Click Add product template to add your first one."
              : "No templates match your search."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((t) => (
            <div key={t.id} className="bg-white border border-gray-200 rounded-lg p-5 hover:border-blue-400 hover:shadow-md transition-all">
              <div className="flex items-start justify-between mb-2">
                <div className="min-w-0 flex-1">
                  <Link href={"/admin/product-templates/" + t.id} className="block">
                    <h2 className="text-lg font-semibold text-gray-900 truncate hover:text-blue-700">{t.name}</h2>
                    {t.product_number && <p className="text-sm text-gray-500">{t.product_number}</p>}
                  </Link>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {t.is_active ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Active</span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Inactive</span>
                  )}
                  {t.is_sub_assembly && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">Sub-assembly</span>
                  )}
                </div>
              </div>
              {t.description && <p className="text-sm text-gray-700 mb-4 line-clamp-3">{t.description}</p>}
              <div className="flex items-center justify-between text-sm">
                <Link href={"/admin/product-templates/" + t.id} className="text-blue-600 hover:text-blue-800 font-medium">
                  Open
                </Link>
                <div className="flex gap-3">
                  <button onClick={() => openEdit(t)} className="text-gray-600 hover:text-gray-900 font-medium">
                    Edit
                  </button>
                  <button onClick={() => handleDelete(t)} className="text-red-600 hover:text-red-800 font-medium">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSave} className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">{editingId ? "Edit product template" : "Add product template"}</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Heavy Duty Cart"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Product number</label>
                  <input
                    type="text"
                    placeholder="e.g. HDC-001"
                    value={form.product_number}
                    onChange={(e) => setForm({ ...form, product_number: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={3}
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

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.is_sub_assembly}
                    onChange={(e) => setForm({ ...form, is_sub_assembly: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Sub-assembly (used as a component, not built standalone)</span>
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