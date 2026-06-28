"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "../../../lib/supabase";

type Template = {
  id: string;
  name: string;
  product_number: string | null;
  description: string | null;
  is_active: boolean;
  is_sub_assembly: boolean;
  is_stockable: boolean;
  reorder_point: number | null;
  reorder_target: number | null;
  customer_id: string | null;
  retail_price_per_unit: number;
};

type Customer = { id: string; name: string };

export default function SettingsTab({ templateId }: { templateId: string }) {
  const supabase = createClient();
  const router = useRouter();

  const [template, setTemplate] = useState<Template | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    product_number: "",
    description: "",
    is_active: true,
    is_sub_assembly: false,
    is_stockable: false,
    reorder_point: "",
    reorder_target: "",
    customer_id: "",
    retail_price_per_unit: "",
  });

  const loadTemplate = useCallback(async () => {
    setLoading(true);
    const [tplRes, custRes] = await Promise.all([
      supabase.from("product_templates").select("*").eq("id", templateId).single(),
      supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
    ]);
    if (tplRes.error) {
      setError(tplRes.error.message);
    } else if (tplRes.data) {
      const data = tplRes.data as Template;
      setTemplate(data);
      setForm({
        name: data.name,
        product_number: data.product_number || "",
        description: data.description || "",
        is_active: data.is_active,
        is_sub_assembly: data.is_sub_assembly,
        is_stockable: data.is_stockable ?? false,
        reorder_point: data.reorder_point != null ? String(data.reorder_point) : "",
        reorder_target: data.reorder_target != null ? String(data.reorder_target) : "",
        customer_id: data.customer_id || "",
        retail_price_per_unit: String(data.retail_price_per_unit ?? ""),
      });
    }
    setCustomers((custRes.data || []) as unknown as Customer[]);
    setLoading(false);
  }, [supabase, templateId]);

  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);

    if (!form.name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!form.is_sub_assembly && !form.customer_id) {
      setError("Please select a customer for this product. (Sub-assemblies don't need one.)");
      return;
    }

    // Only a sub-assembly can be a stockable fabricated item, and only a
    // stockable item carries reorder values.
    const stockable = form.is_sub_assembly ? form.is_stockable : false;

    function parseReorder(value: string, label: string): number | null | "error" {
      if (!stockable || value.trim() === "") return null;
      const n = parseFloat(value);
      if (isNaN(n) || n < 0) {
        setError(label + " must be 0 or more.");
        return "error";
      }
      return n;
    }
    const reorderPoint = parseReorder(form.reorder_point, "Reorder point");
    if (reorderPoint === "error") return;
    const reorderTarget = parseReorder(form.reorder_target, "Reorder target");
    if (reorderTarget === "error") return;
    if (reorderPoint != null && reorderTarget != null && reorderTarget < reorderPoint) {
      setError("Reorder target should be at least the reorder point.");
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from("product_templates")
      .update({
        name: form.name.trim(),
        product_number: form.product_number.trim() || null,
        description: form.description.trim() || null,
        is_active: form.is_active,
        is_sub_assembly: form.is_sub_assembly,
        is_stockable: stockable,
        reorder_point: reorderPoint,
        reorder_target: reorderTarget,
        customer_id: form.is_sub_assembly ? null : form.customer_id,
        retail_price_per_unit: parseFloat(form.retail_price_per_unit) || 0,
      })
      .eq("id", templateId);

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    setMessage("Saved.");
    setTimeout(() => setMessage(null), 2000);
    loadTemplate();
  }

  async function handleDeleteTemplate() {
    if (!template) return;
    const ok = confirm(
      "Delete " + template.name + "? This will delete all materials, parts, tasks, photos, and notes for this template. This cannot be undone."
    );
    if (!ok) return;

    const { error } = await supabase.from("product_templates").delete().eq("id", templateId);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    router.push("/admin/product-templates");
  }

  if (loading) return <p className="text-gray-600">Loading...</p>;
  if (!template) return <p className="text-gray-600">Template not found.</p>;

  return (
    <div className="space-y-6 max-w-3xl">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-3">{message}</div>}

      <form onSubmit={handleSave} className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <h3 className="text-base font-semibold text-gray-900">General</h3>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Name <span className="text-red-600">*</span>
          </label>
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.is_sub_assembly}
            onChange={(e) =>
              setForm({
                ...form,
                is_sub_assembly: e.target.checked,
                // Clearing sub-assembly also clears stockable.
                is_stockable: e.target.checked ? form.is_stockable : false,
              })
            }
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">Sub-assembly (used as a component inside other products, not built standalone)</span>
        </label>

        {form.is_sub_assembly && (
          <label className="flex items-start gap-2 ml-6">
            <input
              type="checkbox"
              checked={form.is_stockable}
              onChange={(e) => setForm({ ...form, is_stockable: e.target.checked })}
              className="w-4 h-4 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">
              Stockable fabricated item (build to stock with a build order, then pull from on-hand stock)
            </span>
          </label>
        )}

        {form.is_sub_assembly && form.is_stockable && (
          <div className="ml-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reorder point</label>
              <input
                type="number"
                step="1"
                min="0"
                value={form.reorder_point}
                onChange={(e) => setForm({ ...form, reorder_point: e.target.value })}
                placeholder="e.g. 4"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Flag this item to reorder when on-hand drops to this or below. Leave blank to not track it.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Build-to target</label>
              <input
                type="number"
                step="1"
                min="0"
                value={form.reorder_target}
                onChange={(e) => setForm({ ...form, reorder_target: e.target.value })}
                placeholder="e.g. 12"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">When below the reorder point, suggest building back up to this level. Leave blank to build to the reorder point.</p>
            </div>
          </div>
        )}

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

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Retail price per unit ($)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={form.retail_price_per_unit}
            onChange={(e) => setForm({ ...form, retail_price_per_unit: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">What you currently charge customers per unit. Used to calculate margin and net profit on the job cost report.</p>
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

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </form>

      <div className="bg-white border border-red-200 rounded-lg p-5">
        <h3 className="text-base font-semibold text-red-700 mb-1">Danger zone</h3>
        <p className="text-sm text-gray-600 mb-3">
          Deleting this template removes the recipe along with all materials, parts, tasks, photos, and notes attached to it. Jobs that reference this template will not be deleted, but they will lose their connection. This cannot be undone.
        </p>
        <button
          onClick={handleDeleteTemplate}
          className="px-4 py-2 bg-red-600 text-white rounded-md font-medium text-sm hover:bg-red-700 transition-colors"
        >
          Delete this product template
        </button>
      </div>
    </div>
  );
}
