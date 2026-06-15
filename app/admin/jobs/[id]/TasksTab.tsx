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

  const loadTasks = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("job_tasks")
      .select("*, job_line_items(id, product_templates(name, product_number))")
      .eq("job_id", jobId)
      .order("job_line_item_id")
      .order("sort_order");
    if (error) setError(error.message);
    else setTasks((data || []) as JobTask[]);
    setLoading(false);
  }, [supabase, jobId]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

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

  if (tasks.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
        <p className="text-gray-600">No tasks on this job yet. Tasks are auto-generated from each line item&apos;s product template.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalEstMinutes.toFixed(0)} min</div>
          <div className="text-xs text-gray-500 mt-1">{(totalEstMinutes / 60).toFixed(2)} hours</div>
        </div>
      </div>

      {Object.entries(groupedTasks).map(([lineItemId, group]) => (
        <section key={lineItemId} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h3 className="text-base font-semibold text-gray-900">
              {group.productName}
              {group.productNumber && <span className="text-gray-500 font-normal"> ({group.productNumber})</span>}
            </h3>
            <p className="text-sm text-gray-600">Batch quantity: {group.tasks[0]?.batch_quantity || 0}</p>
          </div>
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700 w-16">#</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Task</th>
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
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(t.estimated_minutes_total).toFixed(2)}</td>
                  <td className="px-4 py-3 text-sm">{statusBadge(t.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}