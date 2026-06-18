"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";

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
  job_line_items: {
    id: string;
    product_templates: { name: string; product_number: string | null } | null;
  } | null;
};

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

  useEffect(() => {
    loadCompanyId();
    loadTasks();
  }, [loadCompanyId, loadTasks]);

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

    // Delete existing tasks
    const { error: delError } = await supabase.from("job_tasks").delete().eq("job_id", jobId);
    if (delError) {
      alert("Failed to clear existing tasks: " + delError.message);
      setRegenerating(false);
      return;
    }

    // Recursively expand template ids (top-level + sub-assemblies)
    const allTemplateIds = new Set<string>();
    const queue = [...new Set(lineItems.map((li) => li.product_template_id))];
    while (queue.length > 0) {
      const tid = queue.shift()!;
      if (allTemplateIds.has(tid)) continue;
      allTemplateIds.add(tid);
      const { data: subData } = await supabase
        .from("product_template_sub_assemblies")
        .select("child_template_id")
        .eq("parent_template_id", tid);
      if (subData) {
        for (const row of subData) {
          if (!allTemplateIds.has(row.child_template_id)) {
            queue.push(row.child_template_id);
          }
        }
      }
    }

    const templateIdArr = Array.from(allTemplateIds);

    // Fetch tasks, sub-links, and template names
    const [tasksRes, subLinksRes, templatesRes] = await Promise.all([
      supabase
        .from("product_template_tasks")
        .select("*")
        .in("product_template_id", templateIdArr)
        .order("sort_order"),
      supabase
        .from("product_template_sub_assemblies")
        .select("parent_template_id, child_template_id, quantity_per_unit")
        .in("parent_template_id", templateIdArr),
      supabase
        .from("product_templates")
        .select("id, name")
        .in("id", templateIdArr),
    ]);

    type TplTaskRow = {
      id: string;
      product_template_id: string;
      name: string;
      description: string | null;
      estimated_minutes_per_unit: number;
      sort_order: number;
    };
    type SubLinkRow = {
      parent_template_id: string;
      child_template_id: string;
      quantity_per_unit: number;
    };

    const tplTasks = (tasksRes.data || []) as unknown as TplTaskRow[];
    const tplSubs = (subLinksRes.data || []) as unknown as SubLinkRow[];
    const templateNames = new Map<string, string>(
      (templatesRes.data || []).map((t: { id: string; name: string }) => [t.id, t.name])
    );

    function expandForLine(templateId: string, multiplier: number, accumulator: Map<string, number>) {
      accumulator.set(templateId, (accumulator.get(templateId) || 0) + multiplier);
      const childLinks = tplSubs.filter((s) => s.parent_template_id === templateId);
      for (const link of childLinks) {
        expandForLine(link.child_template_id, multiplier * Number(link.quantity_per_unit), accumulator);
      }
    }

    const taskRows: Array<{
      company_id: string;
      job_id: string;
      job_line_item_id: string;
      source_task_id: string;
      name: string;
      description: string | null;
      batch_quantity: number;
      estimated_minutes_total: number;
      sort_order: number;
    }> = [];

    for (const li of lineItems) {
      const perLineMap = new Map<string, number>();
      expandForLine(li.product_template_id, Number(li.quantity), perLineMap);

      const orderedEntries = Array.from(perLineMap.entries()).sort((a, b) => {
        if (a[0] === li.product_template_id) return -1;
        if (b[0] === li.product_template_id) return 1;
        return 0;
      });

      let runningSortOrder = 0;
      for (const [tid, totalQty] of orderedEntries) {
        const tasksForTpl = tplTasks
          .filter((t) => t.product_template_id === tid)
          .sort((a, b) => a.sort_order - b.sort_order);

        const isSubAssembly = tid !== li.product_template_id;
        const tplName = templateNames.get(tid) || "Sub-assembly";

        for (const t of tasksForTpl) {
          const labeledName = isSubAssembly ? t.name + " (" + tplName + ")" : t.name;
          taskRows.push({
            company_id: companyId,
            job_id: jobId,
            job_line_item_id: li.id,
            source_task_id: t.id,
            name: labeledName,
            description: t.description,
            batch_quantity: totalQty,
            estimated_minutes_total: Number(t.estimated_minutes_per_unit) * totalQty,
            sort_order: runningSortOrder++,
          });
        }
      }
    }

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

  // Group tasks by line item
  const groupedTasks = tasks.reduce((groups, task) => {
    const lineItemId = task.job_line_items?.id || "unknown";
    if (!groups[lineItemId]) {
      groups[lineItemId] = {
        productName: task.job_line_items?.product_templates?.name || "Unknown product",
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
        <button
          onClick={regenerateTasks}
          disabled={regenerating}
          className="px-3 py-2 text-sm border border-gray-300 rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
          title="Rebuild the task list from the current product templates (includes sub-assembly tasks)"
        >
          {regenerating ? "Regenerating..." : "Regenerate tasks"}
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No tasks on this job yet. Tasks are auto-generated from each line item&apos;s product template.</p>
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