"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";
import { computeJobPlan } from "../../../lib/job-generation";

const STATUSES = [
  { value: "not_started", label: "Not started", color: "bg-gray-100 text-gray-800" },
  { value: "in_progress", label: "In progress", color: "bg-amber-100 text-amber-800" },
  { value: "paused", label: "Paused", color: "bg-blue-100 text-blue-800" },
  { value: "complete", label: "Complete", color: "bg-green-100 text-green-800" },
] as const;

type TaskStatus = (typeof STATUSES)[number]["value"];

type JobTask = {
  id: string;
  name: string;
  description: string | null;
  batch_quantity: number;
  estimated_minutes_total: number;
  status: TaskStatus;
  sort_order: number;
  completed_at: string | null;
  job_line_item_id: string | null;
  job_line_items: {
    id: string;
    product_templates: { name: string; product_number: string | null } | null;
  } | null;
};

type CustomLineItem = { id: string; quantity: number; name: string | null };

function statusBadge(status: TaskStatus) {
  const s = STATUSES.find((x) => x.value === status);
  return s
    ? <span className={"inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium " + s.color}>{s.label}</span>
    : <span className="text-xs text-gray-500">{status}</span>;
}

export default function TasksTab({ jobId }: { jobId: string }) {
  const supabase = createClient();
  const [tasks, setTasks] = useState<JobTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  // Custom job support
  const [isCustomJob, setIsCustomJob] = useState(false);
  const [customLineItem, setCustomLineItem] = useState<CustomLineItem | null>(null);

  // Manual task form (custom jobs only)
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "", minutes_per_unit: "" });
  const [savingTask, setSavingTask] = useState(false);

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("job_tasks")
      .select("*, job_line_items(id, product_templates(name, product_number))")
      .eq("job_id", jobId)
      .order("job_line_item_id")
      .order("sort_order");
    if (error) setError(error.message);
    else setTasks((data || []) as unknown as JobTask[]);
    setLoading(false);
  }, [supabase, jobId]);

  // Detect a custom job and grab its single line item (for attaching manual tasks + qty)
  const loadLineItems = useCallback(async () => {
    const { data } = await supabase
      .from("job_line_items")
      .select("id, quantity, name, product_template_id")
      .eq("job_id", jobId)
      .order("sort_order");
    const rows = (data || []) as unknown as (CustomLineItem & { product_template_id: string | null })[];
    const custom = rows.length > 0 && rows.some((r) => r.product_template_id === null);
    setIsCustomJob(custom);
    // For a custom job, tasks attach to the first templateless line item
    const target = rows.find((r) => r.product_template_id === null) || null;
    setCustomLineItem(target ? { id: target.id, quantity: Number(target.quantity), name: target.name } : null);
  }, [supabase, jobId]);

  useEffect(() => {
    loadCompanyId();
    loadTasks();
    loadLineItems();
  }, [loadCompanyId, loadTasks, loadLineItems]);

  function openAdd() {
    setForm({ name: "", description: "", minutes_per_unit: "" });
    setEditingId(null);
    setShowForm(true);
  }

  function openEdit(t: JobTask) {
    const qty = customLineItem?.quantity || 1;
    const perUnit = qty > 0 ? Number(t.estimated_minutes_total) / qty : Number(t.estimated_minutes_total);
    setForm({
      name: t.name,
      description: t.description || "",
      minutes_per_unit: String(Math.round(perUnit * 1000) / 1000),
    });
    setEditingId(t.id);
    setShowForm(true);
  }

  async function saveTask(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId) {
      alert("Could not determine your company. Try refreshing the page.");
      return;
    }
    if (!customLineItem) {
      alert("This job has no custom line item to attach the task to.");
      return;
    }
    if (!form.name.trim()) {
      alert("Task name is required.");
      return;
    }
    const perUnit = parseFloat(form.minutes_per_unit);
    if (isNaN(perUnit) || perUnit < 0) {
      alert("Estimated minutes per unit must be 0 or more.");
      return;
    }

    const qty = customLineItem.quantity || 1;
    const batchTotal = perUnit * qty;

    setSavingTask(true);
    if (editingId) {
      const { error } = await supabase
        .from("job_tasks")
        .update({
          name: form.name.trim(),
          description: form.description.trim() || null,
          estimated_minutes_total: batchTotal,
        })
        .eq("id", editingId);
      setSavingTask(false);
      if (error) {
        alert("Failed to save task: " + error.message);
        return;
      }
    } else {
      const nextSort = tasks.length;
      const { error } = await supabase.from("job_tasks").insert({
        company_id: companyId,
        job_id: jobId,
        job_line_item_id: customLineItem.id,
        source_task_id: null,
        name: form.name.trim(),
        description: form.description.trim() || null,
        batch_quantity: qty,
        estimated_minutes_total: batchTotal,
        status: "not_started",
        sort_order: nextSort,
      });
      setSavingTask(false);
      if (error) {
        alert("Failed to add task: " + error.message);
        return;
      }
    }
    setShowForm(false);
    loadTasks();
  }

  async function deleteTask(t: JobTask) {
    if (!confirm("Delete task " + t.name + "? Any time logged against it will also be removed.")) return;
    const { error } = await supabase.from("job_tasks").delete().eq("id", t.id);
    if (error) {
      alert("Failed to delete task: " + error.message);
      return;
    }
    loadTasks();
  }

  // ---- Admin task completion -------------------------------------------------
  // Lets an admin close out or reopen a task straight from this tab, mirroring
  // the floor's Mark complete / Reopen buttons. Marking a task complete does NOT
  // touch anyone's open time entry: a worker still clocked in keeps running until
  // they clock out themselves, exactly like the floor button.
  async function ensureJobInProgress() {
    const { data: job } = await supabase.from("jobs").select("status").eq("id", jobId).single();
    if ((job as { status: string } | null)?.status === "ready") {
      await supabase.from("jobs").update({ status: "in_progress" }).eq("id", jobId);
    }
  }

  // If every task on the job is now complete, offer to mark the whole job
  // complete (the same prompt the floor shows). Returns true when the job was
  // marked complete, so the caller can refresh into the completed-job view.
  async function maybeAutoCompleteJob(): Promise<boolean> {
    const { data: jobRow } = await supabase.from("jobs").select("status").eq("id", jobId).single();
    const jobStatus = (jobRow as { status: string } | null)?.status;
    if (!jobStatus || jobStatus === "complete") return false;

    const { data: taskRows } = await supabase.from("job_tasks").select("status").eq("job_id", jobId);
    const rows = (taskRows || []) as unknown as { status: string }[];
    if (rows.length === 0) return false;
    if (!rows.every((r) => r.status === "complete")) return false;

    const ok = confirm(
      "All tasks on this job are done. Mark the whole job complete?\n\n" +
      "It'll move to the invoices list for review. You can still reopen a task if you need to keep working."
    );
    if (!ok) return false;

    const { error } = await supabase
      .from("jobs")
      .update({ status: "complete", completed_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) {
      alert("Couldn't mark the job complete: " + error.message);
      return false;
    }
    return true;
  }

  async function markComplete(t: JobTask) {
    setBusyTaskId(t.id);
    const { error } = await supabase
      .from("job_tasks")
      .update({ status: "complete", completed_at: new Date().toISOString() })
      .eq("id", t.id);
    if (error) {
      setBusyTaskId(null);
      alert("Failed to mark task complete: " + error.message);
      return;
    }
    await ensureJobInProgress();
    const jobCompleted = await maybeAutoCompleteJob();
    if (jobCompleted) {
      // Job is now complete: refresh so the page shows its completed-job view.
      window.location.reload();
      return;
    }
    setBusyTaskId(null);
    await loadTasks();
  }

  async function reopen(t: JobTask) {
    setBusyTaskId(t.id);
    const { error } = await supabase
      .from("job_tasks")
      .update({ status: "not_started", completed_at: null })
      .eq("id", t.id);
    setBusyTaskId(null);
    if (error) {
      alert("Failed to reopen task: " + error.message);
      return;
    }
    await loadTasks();
  }

  async function regenerateTasks() {
    if (!companyId) {
      alert("Could not determine your company. Try refreshing the page.");
      return;
    }
    const anyInProgress = tasks.some((t) => t.status === "in_progress" || t.status === "paused" || t.status === "complete");
    const confirmText = anyInProgress
      ? "Regenerate the task list? Tasks that are in progress, paused, or complete will be lost along with any time entries. This cannot be undone."
      : "Regenerate the task list from the current product templates? This will delete the existing tasks and rebuild them from scratch (including sub-assembly tasks).";
    if (!confirm(confirmText)) return;

    setRegenerating(true);

    // Get all line items for this job
    const { data: lineItems, error: liError } = await supabase
      .from("job_line_items")
      .select("id, product_template_id, quantity")
      .eq("job_id", jobId);

    if (liError || !lineItems) {
      alert("Failed to load line items: " + (liError?.message || "Unknown error"));
      setRegenerating(false);
      return;
    }

    const templateLines = (lineItems as unknown as { id: string; product_template_id: string | null; quantity: number }[])
      .filter((li) => li.product_template_id)
      .map((li) => ({ lineItemId: li.id, templateId: li.product_template_id as string, quantity: Number(li.quantity) }));

    // Delete existing tasks
    const { error: delError } = await supabase.from("job_tasks").delete().eq("job_id", jobId);
    if (delError) {
      alert("Failed to clear existing tasks: " + delError.message);
      setRegenerating(false);
      return;
    }

    // Same planner the New Job screen uses: sub-assemblies expand, stockable ones
    // are pulled finished from stock, and a job carrying several products merges
    // tasks that share a name into one job-wide task.
    const { data: jobRow } = await supabase.from("jobs").select("is_build_order").eq("id", jobId).single();
    const isBuildOrder = !!(jobRow as { is_build_order: boolean | null } | null)?.is_build_order;
    const plan = await computeJobPlan(supabase, templateLines, {
      mergeTasks: !isBuildOrder && templateLines.length > 1,
    });
    const taskRows = plan.tasks.map((t) => ({
      company_id: companyId,
      job_id: jobId,
      job_line_item_id: t.lineItemId,
      source_task_id: t.sourceTaskId,
      name: t.name,
      description: t.description,
      batch_quantity: t.batchQuantity,
      estimated_minutes_total: t.minutes,
      sort_order: t.sortOrder,
    }));

    if (taskRows.length > 0) {
      const { error: insError } = await supabase.from("job_tasks").insert(taskRows);
      if (insError) {
        alert("Failed to insert new tasks: " + insError.message);
        setRegenerating(false);
        return;
      }
    }

    setRegenerating(false);
    loadTasks();
  }

  // Group tasks by line item. Tasks with no line item are job-wide: on a job
  // carrying several product variations they get built together, so they show as
  // one shared list instead of being repeated under every product.
  const groupedTasks = tasks.reduce((groups, task) => {
    const lineItemId = task.job_line_items?.id || task.job_line_item_id || "job-wide";
    if (!groups[lineItemId]) {
      groups[lineItemId] = {
        productName:
          task.job_line_items?.product_templates?.name ||
          (isCustomJob
            ? (customLineItem?.name || "Custom job")
            : lineItemId === "job-wide"
              ? "All products on this job"
              : "Unknown product"),
        productNumber: task.job_line_items?.product_templates?.product_number || null,
        tasks: [],
      };
    }
    groups[lineItemId].tasks.push(task);
    return groups;
  }, {} as Record<string, { productName: string; productNumber: string | null; tasks: JobTask[] }>);

  const totalEstMinutes = tasks.reduce((sum, t) => sum + Number(t.estimated_minutes_total), 0);
  const completedTasks = tasks.filter((t) => t.status === "complete").length;

  if (loading) return <p className="text-gray-600">Loading...</p>;

  return (
    <div className="space-y-6">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 flex-1">
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total tasks</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">{tasks.length}</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Completed</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">{completedTasks} / {tasks.length}</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Estimated total time</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">{totalEstMinutes.toFixed(2)} min</div>
            <div className="text-xs text-gray-500 mt-1">{(totalEstMinutes / 60).toFixed(2)} hours</div>
          </div>
        </div>
        {isCustomJob ? (
          <button
            onClick={openAdd}
            className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            + Add task
          </button>
        ) : (
          <button
            onClick={regenerateTasks}
            disabled={regenerating}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
            title="Rebuild the task list from the current product templates (includes sub-assembly tasks)"
          >
            {regenerating ? "Regenerating..." : "Regenerate tasks"}
          </button>
        )}
      </div>

      {showForm && isCustomJob && (
        <form onSubmit={saveTask} className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <h4 className="text-sm font-semibold text-gray-900">{editingId ? "Edit task" : "Add task"}</h4>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Task name <span className="text-red-600">*</span></label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Cut and fit handrail"
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Estimated minutes per unit <span className="text-red-600">*</span></label>
            <input
              type="number"
              step="0.001"
              min="0"
              value={form.minutes_per_unit}
              onChange={(e) => setForm({ ...form, minutes_per_unit: e.target.value })}
              placeholder="e.g. 30"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Multiplied by the job quantity ({customLineItem?.quantity || 1}) for the batch total. Actual time is tracked when your crew clocks in on the floor.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
            <button type="submit" disabled={savingTask} className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-md text-sm font-medium disabled:opacity-50">
              {savingTask ? "Saving..." : "Save task"}
            </button>
          </div>
        </form>
      )}

      {tasks.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">
            {isCustomJob
              ? "No tasks yet. Click \u201c+ Add task\u201d to build this custom job\u2019s task list so your crew can clock in and track labor."
              : "No tasks on this job yet. Tasks are auto-generated from each line item\u2019s product template."}
          </p>
        </div>
      ) : (
        Object.entries(groupedTasks).map(([lineItemId, group]) => (
          <section key={lineItemId} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h3 className="text-base font-semibold text-gray-900">
                {group.productName}
                {group.productNumber && <span className="text-gray-500 font-normal"> ({group.productNumber})</span>}
              </h3>
            </div>
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700 w-16">#</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Task</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Batch qty</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Est. min total</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Status</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {group.tasks.map((t, i) => (
                  <tr key={t.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-500 font-mono">{i + 1}</td>
                    <td className="px-4 py-3 text-sm">
                      <div className="text-gray-900 font-medium">{t.name}</div>
                      {t.description && <div className="text-xs text-gray-600 mt-0.5">{t.description}</div>}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{t.batch_quantity}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(t.estimated_minutes_total).toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm">{statusBadge(t.status)}</td>
                    <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                      {t.status === "complete" ? (
                        <button
                          onClick={() => reopen(t)}
                          disabled={busyTaskId === t.id}
                          className="text-amber-700 hover:text-amber-900 font-medium disabled:opacity-50"
                        >
                          {busyTaskId === t.id ? "Working..." : "Reopen"}
                        </button>
                      ) : (
                        <button
                          onClick={() => markComplete(t)}
                          disabled={busyTaskId === t.id}
                          className="text-green-700 hover:text-green-900 font-medium disabled:opacity-50"
                        >
                          {busyTaskId === t.id ? "Working..." : "Mark complete"}
                        </button>
                      )}
                      {isCustomJob && (
                        <>
                          <button onClick={() => openEdit(t)} className="text-blue-600 hover:text-blue-800 font-medium ml-4">Edit</button>
                          <button onClick={() => deleteTask(t)} className="text-red-600 hover:text-red-800 font-medium ml-4">Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}
