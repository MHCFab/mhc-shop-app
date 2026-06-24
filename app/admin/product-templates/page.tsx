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
  customer_id: string | null;
  created_at: string;
};

type Customer = { id: string; name: string };

type Form = {
  name: string;
  product_number: string;
  description: string;
  is_active: boolean;
  is_sub_assembly: boolean;
  customer_id: string;
};

const emptyForm: Form = {
  name: "",
  product_number: "",
  description: "",
  is_active: true,
  is_sub_assembly: false,
  customer_id: "",
};

export default function ProductTemplatesPage() {
  const supabase = createClient();
  const [templates, setTemplates] = useState<ProductTemplate[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "products" | "sub_assemblies">("all");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    const [tplRes, custRes] = await Promise.all([
      supabase.from("product_templates").select("*").order("name"),
      supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
    ]);
    if (tplRes.error) setError(tplRes.error.message);
    else setTemplates(tplRes.data || []);
    setCustomers((custRes.data || []) as unknown as Customer[]);
    setLoading(false);
  }

  useEffect(() => {
    loadCompanyId();
    loadTemplates();
  }, []);

  const customerName = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of customers) map[c.id] = c.name;
    return map;
  }, [customers]);

  const filtered = useMemo(() => {
    return templates.filter((t) => {
      if (filterType === "products" && t.is_sub_assembly) return false;
      if (filterType === "sub_assemblies" && !t.is_sub_assembly) return false;
      if (search) {
        const s = search.toLowerCase();
        const cust = t.customer_id ? (customerName[t.customer_id] || "") : "";
        const text = (t.name + " " + (t.product_number || "") + " " + (t.description || "") + " " + cust).toLowerCase();
        if (!text.includes(s)) return false;
      }
      return true;
    });
  }, [templates, search, filterType, customerName]);

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
      customer_id: t.customer_id || "",
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
    if (!form.is_sub_assembly && !form.customer_id) {
      setError("Please select a customer for this product. (Sub-assemblies don't need one.)");
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
      customer_id: form.is_sub_assembly ? null : form.customer_id,
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

  // Duplicate a template: copy the template row plus its full recipe
  // (BOM materials, purchased parts, sub-assembly links, and tasks).
  async function handleDuplicate(t: ProductTemplate) {
    if (!companyId) {
      alert("Could not determine your company. Try refreshing the page.");
      return;
    }
    setNotice(null);
    setDuplicatingId(t.id);
    try {
      // 1) Read the full source template row so every field carries over,
      //    including ones not shown on this page (price, SOPs, etc.)
      const { data: srcTpl, error: readErr } = await supabase
        .from("product_templates")
        .select("*")
        .eq("id", t.id)
        .single();
      if (readErr || !srcTpl) throw new Error(readErr?.message || "Couldn't read the template to copy.");

      // 2) Read all child rows (BOM materials, parts, sub-assembly links, tasks)
      const [matsRes, partsRes, subsRes, tasksRes] = await Promise.all([
        supabase
          .from("product_template_materials")
          .select("raw_material_id, feet_per_unit, notes, sort_order")
          .eq("product_template_id", t.id),
        supabase
          .from("product_template_parts")
          .select("purchased_part_id, quantity_per_unit, notes, sort_order")
          .eq("product_template_id", t.id),
        supabase
          .from("product_template_sub_assemblies")
          .select("child_template_id, quantity_per_unit, notes, sort_order")
          .eq("parent_template_id", t.id),
        supabase
          .from("product_template_tasks")
          .select("name, description, estimated_minutes_per_unit, sort_order")
          .eq("product_template_id", t.id),
      ]);

      // 3) Insert the copy: same fields, renamed, with a cleared product number
      const newTemplate = { ...(srcTpl as Record<string, unknown>) };
      delete newTemplate.id;
      delete newTemplate.created_at;
      delete newTemplate.updated_at;
      newTemplate.company_id = companyId;
      newTemplate.name = t.name + " (Copy)";
      newTemplate.product_number = null;

      const { data: inserted, error: insErr } = await supabase
        .from("product_templates")
        .insert(newTemplate)
        .select("id")
        .single();
      if (insErr || !inserted) throw new Error(insErr?.message || "Couldn't create the copy.");
      const newId = (inserted as { id: string }).id;

      // 4) Copy each child table, pointing the new rows at the copy
      type MatSrc = { raw_material_id: string; feet_per_unit: number; notes: string | null; sort_order: number };
      type PartSrc = { purchased_part_id: string; quantity_per_unit: number; notes: string | null; sort_order: number };
      type SubSrc = { child_template_id: string; quantity_per_unit: number; notes: string | null; sort_order: number };
      type TaskSrc = { name: string; description: string | null; estimated_minutes_per_unit: number; sort_order: number };

      const matRows = ((matsRes.data || []) as unknown as MatSrc[]).map((r) => ({
        company_id: companyId,
        product_template_id: newId,
        raw_material_id: r.raw_material_id,
        feet_per_unit: r.feet_per_unit,
        notes: r.notes,
        sort_order: r.sort_order,
      }));
      const partRows = ((partsRes.data || []) as unknown as PartSrc[]).map((r) => ({
        company_id: companyId,
        product_template_id: newId,
        purchased_part_id: r.purchased_part_id,
        quantity_per_unit: r.quantity_per_unit,
        notes: r.notes,
        sort_order: r.sort_order,
      }));
      const subRows = ((subsRes.data || []) as unknown as SubSrc[]).map((r) => ({
        company_id: companyId,
        parent_template_id: newId,
        child_template_id: r.child_template_id,
        quantity_per_unit: r.quantity_per_unit,
        notes: r.notes,
        sort_order: r.sort_order,
      }));
      const taskRows = ((tasksRes.data || []) as unknown as TaskSrc[]).map((r) => ({
        company_id: companyId,
        product_template_id: newId,
        name: r.name,
        description: r.description,
        estimated_minutes_per_unit: r.estimated_minutes_per_unit,
        sort_order: r.sort_order,
      }));

      const childErrors: string[] = [];
      if (matRows.length) {
        const { error } = await supabase.from("product_template_materials").insert(matRows);
        if (error) childErrors.push(error.message);
      }
      if (partRows.length) {
        const { error } = await supabase.from("product_template_parts").insert(partRows);
        if (error) childErrors.push(error.message);
      }
      if (subRows.length) {
        const { error } = await supabase.from("product_template_sub_assemblies").insert(subRows);
        if (error) childErrors.push(error.message);
      }
      if (taskRows.length) {
        const { error } = await supabase.from("product_template_tasks").insert(taskRows);
        if (error) childErrors.push(error.message);
      }

      // 5) If any child copy failed, roll the whole thing back so you're
      //    never left with a half-built copy on the live system.
      if (childErrors.length > 0) {
        await supabase.from("product_template_materials").delete().eq("product_template_id", newId);
        await supabase.from("product_template_parts").delete().eq("product_template_id", newId);
        await supabase.from("product_template_sub_assemblies").delete().eq("parent_template_id", newId);
        await supabase.from("product_template_tasks").delete().eq("product_template_id", newId);
        await supabase.from("product_templates").delete().eq("id", newId);
        throw new Error(
          "Couldn't copy the full recipe (" + childErrors.join("; ") + "). The partial copy was removed, so nothing changed."
        );
      }

      setNotice('Created "' + t.name + ' (Copy)" with its full recipe. Use Edit to rename it, or Open to adjust the copy.');
      await loadTemplates();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to duplicate this template.");
    } finally {
      setDuplicatingId(null);
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Product Templates</h1>
          <p className="text-gray-600 mt-1">
            Recipes for each product, including materials, parts, sub-assemblies, tasks, photos, and build notes.
          </p>
        </div>
        <button onClick={openNew} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors">
          Add product template
        </button>
      </div>

      {notice && (
        <div className="mb-4 text-sm text-green-800 bg-green-50 border border-green-200 rounded-md p-3 flex items-start justify-between gap-3">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900 font-medium shrink-0">Dismiss</button>
        </div>
      )}

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
          placeholder="Search by name, product number, customer, or description..."
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
                  {!t.is_sub_assembly && t.customer_id && (
                    <p className="text-sm text-gray-600 mt-0.5">{customerName[t.customer_id] || "Unknown customer"}</p>
                  )}
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
                  <button
                    onClick={() => handleDuplicate(t)}
                    disabled={duplicatingId === t.id}
                    className="text-gray-600 hover:text-gray-900 font-medium disabled:opacity-50"
                  >
                    {duplicatingId === t.id ? "Copying..." : "Duplicate"}
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

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.is_sub_assembly}
                    onChange={(e) => setForm({ ...form, is_sub_assembly: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Sub-assembly (used as a component, not built standalone)</span>
                </label>

                {!form.is_sub_assembly && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Customer <span className="text-red-600">*</span>
                    </label>
                    <select
                      value={form.customer_id}
                      onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">-- Select customer --</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">This product will only be orderable for this customer.</p>
                  </div>
                )}

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