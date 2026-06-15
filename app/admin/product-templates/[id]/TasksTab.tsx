"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";

type Task = {
  id: string;
  name: string;
  description: string | null;
  estimated_minutes_per_unit: number;
  sort_order: number;
};

type Form = {
  name: string;
  description: string;
  estimated_minutes_per_unit: string;
};

const emptyForm: Form = {
  name: "",
  description: "",
  estimated_minutes_per_unit: "",
};

export default function TasksTab({ templateId }: { templateId: string }) {
  const supabase = createClient();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("product_template_tasks")
      .select("*")
      .eq("product_template_id", templateId)
      .order("sort_order");
    if (error) setError(error.message);
    else setTasks((data || []) as Task[]);
    setLoading(false);
  }, [supabase, templateId]);

  useEffect(() => {
    loadCompanyId();
    loadTasks();
  }, [loadCompanyId, loadTasks]);

  function openAdd() {
    setForm(emptyForm);
    setEditingId(null);
    setError(null);
    setAdding(true);
  }

  function openEdit(t: Task) {
    setForm({
      name: t.name,
      description: t.description || "",
      estimated_minutes_per_unit: String(t.estimated_minutes_per_unit),
    });
    setEditingId(t.id);
    setError(null);
    setAdding(true);
  }

  function closeForm() {
    setAdding(false);
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    if (!form.name.trim()) {
      setError("Task name is required.");
      setSaving(false);
      return;
    }
    const mins = parseFloat(form.estimated_minutes_per_unit);
    if (isNaN(mins) || mins < 0) {
      setError("Estimated minutes must be 0 or more.");
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
      description: form.description.trim() || null,
      estimated_minutes_per_unit: mins,
    };

    const { error } = editingId
      ? await supabase.from("product_template_tasks").update(payload).eq("id", editingId)
      : await supabase.from("product_template_tasks").insert({
          ...payload,
          company_id: companyId,
          product_template_id: templateId,
          sort_order: tasks.length,
        });

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    closeForm();
    loadTasks();
  }

  async function handleDelete(t: Task) {
    if (!confirm("Delete task " + t.name + "?")) return;
    const { error } = await supabase.from("product_template_tasks").delete().eq("id", t.id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    loadTasks();
  }

  async function moveTask(index: number, direction: "up" | "down") {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= tasks.length) return;

    const a = tasks[index];
    const b = tasks[newIndex];

    // Swap sort orders
    await Promise.all([
      supabase.from("product_template_tasks").update({ sort_order: b.sort_order }).eq("id", a.id),
      supabase.from("product_template_tasks").update({ sort_order: a.sort_order }).eq("id", b.id),
    ]);
    loadTasks();
  }

  const totalMinutes = tasks.reduce((sum, t) => sum + Number(t.estimated_minutes_per_unit), 0);
  const totalHours = totalMinutes / 60;

  if (loading) return <p className="text-gray-600">Loading...</p>;

  return (
    <div className="space-y-4">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total estimated time per unit</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalMinutes.toFixed(2)} min</div>
          <div className="text-xs text-gray-500 mt-1">{totalHours.toFixed(2)} hours</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Number of tasks</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{tasks.length}</div>
        </div>
      </div>

      <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">Tasks (in build order)</h3>
          {!adding && (
            <button onClick={openAdd} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ Add task</button>
          )}
        </div>

        {tasks.length === 0 && !adding ? (
          <div className="p-6 text-center">
            <p className="text-sm text-gray-600 mb-3">No tasks added yet.</p>
            <button onClick={openAdd} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ Add the first task</button>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700 w-16">#</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Task</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Description</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Est. min / unit</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Order</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t, i) => (
                <tr key={t.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm text-gray-500 font-mono">{i + 1}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 font-medium">{t.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{t.description || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(t.estimated_minutes_per_unit).toFixed(2)}</td>
                  <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                    <button
                      onClick={() => moveTask(i, "up")}
                      disabled={i === 0}
                      className="text-gray-600 hover:text-gray-900 disabled:opacity-30 disabled:cursor-not-allowed mr-2"
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveTask(i, "down")}
                      disabled={i === tasks.length - 1}
                      className="text-gray-600 hover:text-gray-900 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move down"
                    >
                      ↓
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                    <button onClick={() => openEdit(t)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Edit</button>
                    <button onClick={() => handleDelete(t)} className="text-red-600 hover:text-red-800 font-medium">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {adding && (
          <form onSubmit={handleSave} className="p-4 bg-gray-50 border-t border-gray-200 space-y-3">
            <h4 className="text-sm font-semibold text-gray-900">{editingId ? "Edit task" : "Add task"}</h4>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Task name <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Plasma cut tube"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Estimated minutes per unit <span className="text-red-600">*</span>
              </label>
              <input
                type="number"
                step="0.001"
                min="0"
                required
                placeholder="e.g. 5"
                value={form.estimated_minutes_per_unit}
                onChange={(e) => setForm({ ...form, estimated_minutes_per_unit: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">How long this task typically takes for one unit. This is just an estimate - actual times will be tracked from job time entries.</p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeForm} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-md text-sm font-medium disabled:opacity-50">
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}