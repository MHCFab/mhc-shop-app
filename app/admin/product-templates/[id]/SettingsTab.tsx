"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "../../../lib/supabase";

type Template = {
  id: string;
  name: string;
  product_number: string | null;
  description: string | null;
  sops: string | null;
  is_active: boolean;
  is_sub_assembly: boolean;
};

export default function SettingsTab({ templateId }: { templateId: string }) {
  const supabase = createClient();
  const router = useRouter();

  const [template, setTemplate] = useState<Template | null>(null);
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
  });

  const loadTemplate = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("product_templates")
      .select("*")
      .eq("id", templateId)
      .single();
    if (error) {
      setError(error.message);
    } else if (data) {
      setTemplate(data);
      setForm({
        name: data.name,
        product_number: data.product_number || "",
        description: data.description || "",
        is_active: data.is_active,
        is_sub_assembly: data.is_sub_assembly,
      });
    }
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

    setSaving(true);
    const { error } = await supabase
      .from("product_templates")
      .update({
        name: form.name.trim(),
        product_number: form.product_number.trim() || null,
        description: form.description.trim() || null,
        is_active: form.is_active,
        is_sub_assembly: form.is_sub_assembly,
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
          <span className="text-sm text-gray-700">Sub-assembly (used as a component inside other products, not built standalone)</span>
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