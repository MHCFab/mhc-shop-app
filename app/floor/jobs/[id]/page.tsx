"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "../../../lib/supabase";
import { getAvailableLengths, pullSticks, saveDrop } from "../../../lib/inventory";

const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
  flat_bar: "Flat Bar",
};

type Job = {
  id: string;
  job_number: string;
  status: string;
  due_date: string | null;
  notes: string | null;
  customers: { name: string } | null;
};

type LineItem = {
  id: string;
  quantity: number;
  notes: string | null;
  product_templates: { id: string; name: string; product_number: string | null } | null;
};

type Tab = "tasks" | "info" | "picklist";

export default function FloorJobDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const supabase = createClient();

  const [job, setJob] = useState<Job | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");

  const loadData = useCallback(async () => {
    setLoading(true);
    const [jobRes, liRes] = await Promise.all([
      supabase.from("jobs").select("id, job_number, status, due_date, notes, customers(name)").eq("id", id).single(),
      supabase
        .from("job_line_items")
        .select("id, quantity, notes, product_templates(id, name, product_number)")
        .eq("job_id", id)
        .order("sort_order"),
    ]);

    if (jobRes.error) {
      setError(jobRes.error.message);
      setLoading(false);
      return;
    }
    setJob(jobRes.data as unknown as Job);
    setLineItems((liRes.data || []) as unknown as LineItem[]);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) return <p className="text-gray-600">Loading...</p>;

  if (error || !job) {
    return (
      <div>
        <Link href="/floor" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to board</Link>
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700">{error || "Job not found."}</div>
      </div>
    );
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: "tasks", label: "Tasks" },
    { value: "info", label: "Product Info" },
    { value: "picklist", label: "Materials" },
  ];

  return (
    <div>
      <Link href="/floor" className="text-sm text-blue-600 hover:text-blue-800 mb-3 inline-block">&larr; Back to board</Link>

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h1 className="text-2xl font-bold text-gray-900">{job.job_number}</h1>
        <p className="text-gray-700 mt-1">{job.customers?.name || "Unknown customer"}</p>
        {job.due_date && <p className="text-sm text-gray-500 mt-1">Due {job.due_date}</p>}
        {job.notes && (
          <div className="mt-3 bg-amber-50 border border-amber-200 rounded-md p-3">
            <p className="text-sm text-amber-900">{job.notes}</p>
          </div>
        )}
      </div>

      <div className="border-b border-gray-200 mb-4">
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t.value ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "tasks" && <FloorTasks jobId={job.id} onChanged={loadData} />}
      {tab === "info" && <FloorInfo lineItems={lineItems} />}
      {tab === "picklist" && <FloorPickList jobId={job.id} />}
    </div>
  );
}

// ---------------- Tasks ----------------

type JobTask = {
  id: string;
  name: string;
  description: string | null;
  batch_quantity: number;
  status: string;
  sort_order: number;
  job_line_item_id: string;
  completed_at: string | null;
  job_line_items: { product_templates: { name: string } | null } | null;
};

type TimeEntry = {
  id: string;
  job_task_id: string;
  started_at: string;
  ended_at: string | null;
};

type TimeEntryFull = {
  id: string;
  job_task_id: string;
  started_at: string;
  ended_at: string | null;
  employee_id: string;
};

function FloorTasks({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const supabase = createClient();
  const [tasks, setTasks] = useState<JobTask[]>([]);
  const [openEntries, setOpenEntries] = useState<TimeEntry[]>([]);
  const [allEntries, setAllEntries] = useState<TimeEntryFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [jobNumber, setJobNumber] = useState("");

  // Scrap modal
  const [scrapTask, setScrapTask] = useState<JobTask | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id || null);
    const { data: jobRow } = await supabase.from("jobs").select("job_number").eq("id", jobId).single();
    setJobNumber(jobRow?.job_number || "");
    if (user) {
      const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
      setCompanyId(profile?.company_id || null);
    }

    const [taskRes, allEntriesRes] = await Promise.all([
      supabase
        .from("job_tasks")
        .select("id, name, description, batch_quantity, status, sort_order, job_line_item_id, completed_at, job_line_items(product_templates(name))")
        .eq("job_id", jobId)
        .order("job_line_item_id")
        .order("sort_order"),
      supabase
        .from("time_entries")
        .select("id, job_task_id, started_at, ended_at, employee_id")
        .eq("job_id", jobId),
    ]);

    const allEntries = (allEntriesRes.data || []) as unknown as TimeEntryFull[];
    setTasks((taskRes.data || []) as unknown as JobTask[]);
    setAllEntries(allEntries);
    // Open entries belonging to the current user (for the clock in/out button state)
    setOpenEntries(allEntries.filter((e) => e.ended_at === null && e.employee_id === user?.id) as TimeEntry[]);
    setLoading(false);
  }, [supabase, jobId]);

  useEffect(() => {
    load();
  }, [load]);

  // Tick every second to update running timers
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  function openEntryForTask(taskId: string) {
    return openEntries.find((e) => e.job_task_id === taskId);
  }

  async function ensureJobInProgress() {
    // Flip job to in_progress if it's currently ready
    const { data: job } = await supabase.from("jobs").select("status").eq("id", jobId).single();
    if (job?.status === "ready") {
      await supabase.from("jobs").update({ status: "in_progress" }).eq("id", jobId);
    }
  }

  // After a task is completed, check whether EVERY task on the job is now complete.
  // Reads fresh from the DB (not in-memory state) so it fires only on the genuinely
  // final task. A job with zero tasks never triggers. On confirm, the job goes to
  // 'complete' (which surfaces it on the Invoices page); invoicing stays manual.
  async function maybeAutoCompleteJob() {
    const { data: jobRow } = await supabase.from("jobs").select("status").eq("id", jobId).single();
    // Don't re-prompt if it's already complete or archived past active work
    if (!jobRow || jobRow.status === "complete") return;

    const { data: taskRows } = await supabase
      .from("job_tasks")
      .select("status")
      .eq("job_id", jobId);
    const rows = (taskRows || []) as unknown as { status: string }[];

    // Zero tasks never auto-completes
    if (rows.length === 0) return;
    const allComplete = rows.every((t) => t.status === "complete");
    if (!allComplete) return;

    const ok = confirm(
      "All tasks on this job are done. Mark the whole job complete?\n\n" +
      "It'll move to the invoices list for review. You can still reopen a task if you need to keep working."
    );
    if (!ok) return;

    const { error } = await supabase
      .from("jobs")
      .update({ status: "complete", completed_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) {
      alert("Couldn't mark the job complete: " + error.message);
    }
  }

  async function clockIn(task: JobTask) {
    if (!companyId || !userId) return;
    setBusyTask(task.id);
    await supabase.from("time_entries").insert({
      company_id: companyId,
      job_task_id: task.id,
      job_id: jobId,
      employee_id: userId,
      started_at: new Date().toISOString(),
    });
    // Set task to in_progress if not already complete
    if (task.status !== "complete") {
      await supabase.from("job_tasks").update({ status: "in_progress" }).eq("id", task.id);
    }
    await ensureJobInProgress();
    setBusyTask(null);
    await load();
    onChanged();
  }

  async function clockOut(task: JobTask) {
    const entry = openEntryForTask(task.id);
    if (!entry) return;
    setBusyTask(task.id);
    await supabase.from("time_entries").update({ ended_at: new Date().toISOString() }).eq("id", entry.id);
    // If no other open entries for this task by anyone, and it's not complete, set to paused
    if (task.status !== "complete") {
      await supabase.from("job_tasks").update({ status: "paused" }).eq("id", task.id);
    }
    setBusyTask(null);
    await load();
    onChanged();
  }

  async function markComplete(task: JobTask) {
    setBusyTask(task.id);
    // Close any open time entry the user has on this task
    const entry = openEntryForTask(task.id);
    if (entry) {
      await supabase.from("time_entries").update({ ended_at: new Date().toISOString() }).eq("id", entry.id);
    }
    await supabase.from("job_tasks").update({ status: "complete", completed_at: new Date().toISOString() }).eq("id", task.id);
    await ensureJobInProgress();
    // Check whether that was the last task and offer to complete the whole job
    await maybeAutoCompleteJob();
    setBusyTask(null);
    await load();
    onChanged();
  }

  async function reopen(task: JobTask) {
    setBusyTask(task.id);
    await supabase.from("job_tasks").update({ status: "not_started", completed_at: null }).eq("id", task.id);
    setBusyTask(null);
    await load();
    onChanged();
  }

  function elapsed(startIso: string) {
    const secs = Math.floor((now - new Date(startIso).getTime()) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return (h > 0 ? h + ":" : "") + pad(m) + ":" + pad(s);
  }

  // Total seconds logged on a task (all employees, all sessions). Open entries count up to now.
  function taskTotalSeconds(taskId: string) {
    return allEntries
      .filter((e) => e.job_task_id === taskId)
      .reduce((sum, e) => {
        const end = e.ended_at ? new Date(e.ended_at).getTime() : now;
        return sum + Math.max(0, Math.floor((end - new Date(e.started_at).getTime()) / 1000));
      }, 0);
  }

  function jobTotalSeconds() {
    return allEntries.reduce((sum, e) => {
      const end = e.ended_at ? new Date(e.ended_at).getTime() : now;
      return sum + Math.max(0, Math.floor((end - new Date(e.started_at).getTime()) / 1000));
    }, 0);
  }

  function formatHMS(secs: number) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return (h > 0 ? h + ":" : "") + pad(m) + ":" + pad(s);
  }

  if (loading) return <p className="text-gray-600">Loading tasks...</p>;

  if (tasks.length === 0) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-gray-600">No tasks on this job.</div>;
  }

  const groups = tasks.reduce((acc, t) => {
    const key = t.job_line_item_id;
    if (!acc[key]) {
      acc[key] = { product: t.job_line_items?.product_templates?.name || "Product", tasks: [] };
    }
    acc[key].tasks.push(t);
    return acc;
  }, {} as Record<string, { product: string; tasks: JobTask[] }>);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Total time logged on this job</span>
        <span className="text-xl font-bold font-mono text-gray-900">{formatHMS(jobTotalSeconds())}</span>
      </div>

      {Object.entries(groups).map(([key, group]) => (
        <div key={key} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">{group.product}</h3>
          </div>
          <ul className="divide-y divide-gray-100">
            {group.tasks.map((t) => {
              const entry = openEntryForTask(t.id);
              const clockedIn = !!entry;
              const isComplete = t.status === "complete";
              const busy = busyTask === t.id;

              return (
                <li key={t.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                      <div className={"font-medium " + (isComplete ? "text-gray-400 line-through" : "text-gray-900")}>{t.name}</div>
                      {t.description && <div className="text-sm text-gray-600 mt-0.5">{t.description}</div>}
                      <div className="text-sm text-gray-600 font-mono mt-1">Total: {formatHMS(taskTotalSeconds(t.id))}</div>
                      {clockedIn && (
                        <div className="text-sm text-amber-700 font-mono mt-0.5">You: clocked in {elapsed(entry.started_at)}</div>
                      )}
                    </div>
                    <span className={"inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0 " + statusColor(t.status)}>
                      {statusLabel(t.status)}
                    </span>
                  </div>

                  {!isComplete && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {clockedIn ? (
                        <button onClick={() => clockOut(t)} disabled={busy} className="px-3 py-2 bg-amber-100 text-amber-900 rounded-md font-medium text-sm hover:bg-amber-200 disabled:opacity-50">
                          Clock out
                        </button>
                      ) : (
                        <button onClick={() => clockIn(t)} disabled={busy} className="px-3 py-2 bg-blue-600 text-white rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50">
                          Clock in
                        </button>
                      )}
                      <button onClick={() => markComplete(t)} disabled={busy} className="px-3 py-2 bg-green-600 text-white rounded-md font-medium text-sm hover:bg-green-700 disabled:opacity-50">
                        Mark complete
                      </button>
                      <button onClick={() => setScrapTask(t)} disabled={busy} className="px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded-md font-medium text-sm hover:bg-gray-50 disabled:opacity-50">
                        Log scrap
                      </button>
                    </div>
                  )}

                  {isComplete && (
                    <div className="mt-2">
                      <button onClick={() => reopen(t)} disabled={busy} className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50">
                        Reopen task
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

{scrapTask && (
        <ScrapModal
          task={scrapTask}
          jobId={jobId}
          jobNumber={jobNumber}
          companyId={companyId}
          userId={userId}
          onClose={() => setScrapTask(null)}
          onSaved={() => {
            setScrapTask(null);
            load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function statusLabel(s: string) {
  if (s === "not_started") return "Not started";
  if (s === "in_progress") return "In progress";
  if (s === "paused") return "Paused";
  if (s === "complete") return "Complete";
  return s;
}

function statusColor(s: string) {
  if (s === "complete") return "bg-green-100 text-green-800";
  if (s === "in_progress") return "bg-amber-100 text-amber-800";
  if (s === "paused") return "bg-blue-100 text-blue-800";
  return "bg-gray-100 text-gray-700";
}

// ---------------- Product Info ----------------

function FloorInfo({ lineItems }: { lineItems: LineItem[] }) {
  if (lineItems.length === 0) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-gray-600">No products on this job.</div>;
  }
  return (
    <div className="space-y-3">
      {lineItems.map((li) => (
        <div key={li.id} className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold text-gray-900">{li.product_templates?.name || "Product"}</div>
              {li.product_templates?.product_number && (
                <div className="text-sm text-gray-500">{li.product_templates.product_number}</div>
              )}
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-gray-900">{li.quantity}</div>
              <div className="text-xs text-gray-500">to build</div>
            </div>
          </div>
          {li.notes && <p className="text-sm text-gray-700 mt-2">{li.notes}</p>}
          {li.product_templates && (
            <Link
              href={"/floor/products/" + li.product_templates.id}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium mt-3 inline-block"
            >
              View build notes &amp; photos &rarr;
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------- Pick List ----------------

type PickItem = {
    id: string;
    item_type: string;
    raw_material_id: string | null;
    product_template_id: string | null;
    planned_quantity: number;
    unit: string;
    raw_materials: { shape: string; size: string; wall_thickness: string | null; grade: string } | null;
    purchased_parts: { name: string; part_number: string | null } | null;
    product_templates: { name: string; product_number: string | null } | null;
  };
  
  type NestPull = {
    raw_material_id: string;
    entry_type: string;
    length_feet: number;
    quantity: number;
  };
  
  function FloorPickList({ jobId }: { jobId: string }) {
    const supabase = createClient();
    const [items, setItems] = useState<PickItem[]>([]);
    const [pulls, setPulls] = useState<NestPull[]>([]);
    const [loading, setLoading] = useState(true);
  
    const load = useCallback(async () => {
      setLoading(true);
      const [itemsRes, pullsRes] = await Promise.all([
        supabase
          .from("job_pick_list_items")
          .select("id, item_type, raw_material_id, product_template_id, planned_quantity, unit, raw_materials(shape, size, wall_thickness, grade), purchased_parts(name, part_number), product_templates(name, product_number)")
          .eq("job_id", jobId)
          .order("item_type"),
        supabase
          .from("cutting_nest_entries")
          .select("raw_material_id, entry_type, length_feet, quantity")
          .eq("job_id", jobId)
          .in("entry_type", ["pull", "drop"]),
      ]);
      setItems((itemsRes.data || []) as unknown as PickItem[]);
      setPulls((pullsRes.data || []) as unknown as NestPull[]);
      setLoading(false);
    }, [supabase, jobId]);
  
    useEffect(() => {
      load();
    }, [load]);
  
    if (loading) return <p className="text-gray-600">Loading materials...</p>;
  
    if (items.length === 0) {
      return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-gray-600">No materials listed.</div>;
    }
  
    function describe(item: PickItem) {
      if (item.item_type === "raw_material" && item.raw_materials) {
        const m = item.raw_materials;
        const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
        return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
      }
      if (item.item_type === "purchased_part" && item.purchased_parts) {
        const p = item.purchased_parts;
        return p.name + (p.part_number ? " (" + p.part_number + ")" : "");
      }
      if (item.item_type === "fabricated" && item.product_templates) {
        const t = item.product_templates;
        return t.name + (t.product_number ? " (" + t.product_number + ")" : "");
      }
      return "Item";
    }
  
    // Group pull entries by material, then by length
    function sticksFor(rawMaterialId: string | null): { length: number; sticks: number }[] {
      if (!rawMaterialId) return [];
      const mine = pulls.filter((p) => p.raw_material_id === rawMaterialId && p.entry_type === "pull");
      const map = new Map<number, number>();
      for (const p of mine) {
        const len = Number(p.length_feet);
        map.set(len, (map.get(len) || 0) + Number(p.quantity));
      }
      return Array.from(map.entries())
        .map(([length, sticks]) => ({ length, sticks }))
        .sort((a, b) => b.length - a.length);
    }

    // Drops the boss logged back to inventory for this material — the crew keeps these.
    function dropsFor(rawMaterialId: string | null): { length: number; sticks: number }[] {
      if (!rawMaterialId) return [];
      const mine = pulls.filter((p) => p.raw_material_id === rawMaterialId && p.entry_type === "drop");
      const map = new Map<number, number>();
      for (const p of mine) {
        const len = Number(p.length_feet);
        map.set(len, (map.get(len) || 0) + Number(p.quantity));
      }
      return Array.from(map.entries())
        .map(([length, sticks]) => ({ length, sticks }))
        .sort((a, b) => b.length - a.length);
    }
  
    const materials = items.filter((i) => i.item_type === "raw_material");
    const parts = items.filter((i) => i.item_type === "purchased_part");
    const fabricated = items.filter((i) => i.item_type === "fabricated");
  
    return (
      <div className="space-y-4">
        {materials.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 font-semibold text-gray-900">Raw Materials (cutting nest)</div>
            <ul className="divide-y divide-gray-100">
              {materials.map((i) => {
                const sticks = sticksFor(i.raw_material_id);
                const drops = dropsFor(i.raw_material_id);
                return (
                  <li key={i.id} className="px-4 py-3">
                    <div className="font-medium text-gray-900">{describe(i)}</div>
                    {sticks.length === 0 ? (
                      <div className="text-sm text-amber-700 mt-1">No nest created yet</div>
                    ) : (
                      <div className="mt-2 space-y-1">
                        {sticks.map((s) => (
                          <div key={s.length} className="flex items-center justify-between text-sm">
                            <span className="text-gray-700">{(s.length * 12).toFixed(1)} in sticks</span>
                            <span className="font-mono font-semibold text-gray-900">× {s.sticks}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {drops.length > 0 && (
                      <div className="mt-3 rounded-md border border-green-200 bg-green-50 p-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-green-800">Keep these drops — return to inventory</div>
                        <div className="mt-1 space-y-1">
                          {drops.map((d) => (
                            <div key={d.length} className="flex items-center justify-between text-sm">
                              <span className="text-green-900">{(d.length * 12).toFixed(1)} in drop</span>
                              <span className="font-mono font-semibold text-green-900">× {d.sticks}</span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-1 text-xs text-green-700">Any other cut-offs are scrap.</div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {parts.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 font-semibold text-gray-900">Purchased Parts</div>
            <ul className="divide-y divide-gray-100">
              {parts.map((i) => (
                <li key={i.id} className="px-4 py-3 flex items-center justify-between">
                  <span className="text-gray-900">{describe(i)}</span>
                  <span className="font-mono text-gray-700">{Number(i.planned_quantity).toFixed(0)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {fabricated.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 font-semibold text-gray-900">Fabricated Sub-Assemblies (grab from stock)</div>
            <ul className="divide-y divide-gray-100">
              {fabricated.map((i) => (
                <li key={i.id} className="px-4 py-3 flex items-center justify-between">
                  <span className="text-gray-900">{describe(i)}</span>
                  <span className="font-mono text-gray-700">{Number(i.planned_quantity).toFixed(0)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

// ---------------- Scrap Modal ----------------

const SCRAP_REASONS = [
  { value: "miscut", label: "Miscut" },
  { value: "bad_weld", label: "Bad weld" },
  { value: "material_defect", label: "Material defect" },
  { value: "damaged", label: "Damaged" },
  { value: "wrong_part", label: "Wrong part" },
  { value: "other", label: "Other" },
] as const;

type ScrapPickItem = {
  id: string;
  item_type: string;
  raw_material_id: string | null;
  purchased_part_id: string | null;
  label: string;
  unit: string;
  costPerFoot: number;
};

function ScrapModal({
  task,
  jobId,
  jobNumber,
  companyId,
  userId,
  onClose,
  onSaved,
}: {
  task: { id: string };
  jobId: string;
  jobNumber: string;
  companyId: string | null;
  userId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const supabase = createClient();
  const [pickItems, setPickItems] = useState<ScrapPickItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [itemKey, setItemKey] = useState("");
  const [reason, setReason] = useState("miscut");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Raw material: pull a stick + log remainder
  const [lengths, setLengths] = useState<{ length: number; sticks: number }[]>([]);
  const [pullLength, setPullLength] = useState("");
  const [remainderLength, setRemainderLength] = useState("");
  const [remainderUnit, setRemainderUnit] = useState<"ft" | "in">("in");
  const [saveRemainder, setSaveRemainder] = useState(true);

  // Purchased part: simple quantity
  const [partQty, setPartQty] = useState("");

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from("job_pick_list_items")
        .select("id, item_type, raw_material_id, purchased_part_id, unit, raw_materials(shape, size, wall_thickness, grade, current_cost_per_foot), purchased_parts(name, part_number)")
        .eq("job_id", jobId);

      type Row = {
        id: string;
        item_type: string;
        raw_material_id: string | null;
        purchased_part_id: string | null;
        unit: string;
        raw_materials: { shape: string; size: string; wall_thickness: string | null; grade: string; current_cost_per_foot: number } | null;
        purchased_parts: { name: string; part_number: string | null } | null;
      };

      const mapped = ((data || []) as unknown as Row[])
        .filter((r) => r.item_type !== "custom")
        .map((r) => {
        let label = "Item";
        let costPerFoot = 0;
        if (r.item_type === "raw_material" && r.raw_materials) {
          const m = r.raw_materials;
          const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
          label = (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
          costPerFoot = Number(m.current_cost_per_foot);
        } else if (r.item_type === "purchased_part" && r.purchased_parts) {
          label = r.purchased_parts.name + (r.purchased_parts.part_number ? " (" + r.purchased_parts.part_number + ")" : "");
        }
        return { id: r.id, item_type: r.item_type, raw_material_id: r.raw_material_id, purchased_part_id: r.purchased_part_id, label, unit: r.unit, costPerFoot };
      });
      setPickItems(mapped);
      setLoading(false);
    }
    load();
  }, [supabase, jobId]);

  const selectedItem = pickItems.find((p) => p.id === itemKey);

  // When a raw material is selected, load its available lengths
  useEffect(() => {
    async function loadLengths() {
      if (selectedItem && selectedItem.item_type === "raw_material" && selectedItem.raw_material_id) {
        const ls = await getAvailableLengths(selectedItem.raw_material_id);
        setLengths(ls);
      } else {
        setLengths([]);
      }
    }
    loadLengths();
  }, [selectedItem]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) {
      setError("Could not determine your company.");
      return;
    }
    if (!selectedItem) {
      setError("Pick which material or part was scrapped.");
      return;
    }

    setSaving(true);

    try {
      if (selectedItem.item_type === "raw_material" && selectedItem.raw_material_id) {
        const pull = parseFloat(pullLength);
        if (isNaN(pull) || pull <= 0) {
          setError("Pick which stick length you pulled.");
          setSaving(false);
          return;
        }

        // Pull one stick of the selected length from inventory
        await pullSticks({
          companyId,
          jobId,
          rawMaterialId: selectedItem.raw_material_id,
          length: pull,
          quantity: 1,
          costPerFoot: selectedItem.costPerFoot,
        });

        // Log the remainder back to inventory if saving it
        let remainderFeet = 0;
        if (remainderLength.trim()) {
          remainderFeet = parseFloat(remainderLength);
          if (remainderUnit === "in") remainderFeet = remainderFeet / 12;
          if (!isNaN(remainderFeet) && remainderFeet > 0 && saveRemainder) {
            await saveDrop({
              companyId,
              jobId,
              rawMaterialId: selectedItem.raw_material_id,
              length: remainderFeet,
              quantity: 1,
              costPerFoot: selectedItem.costPerFoot,
              jobNumber,
            });
          }
        }

        // Net extra consumed = pulled stick minus saved remainder
        const netExtra = pull - (saveRemainder ? remainderFeet : 0);

        // Record the variance for the scrap report
        await supabase.from("job_material_variances").insert({
          company_id: companyId,
          job_id: jobId,
          job_task_id: task.id,
          reported_by: userId,
          item_type: "raw_material",
          raw_material_id: selectedItem.raw_material_id,
          purchased_part_id: null,
          extra_quantity: netExtra > 0 ? netExtra : 0,
          unit: "ft",
          reason,
          notes: notes.trim() || null,
        });
      } else {
        // Purchased part: simple quantity
        const amount = parseFloat(partQty);
        if (isNaN(amount) || amount <= 0) {
          setError("Enter how many extra parts were used.");
          setSaving(false);
          return;
        }

        // Allocate the extra parts (increase the part's allocation so available drops)
        const { data: existing } = await supabase
          .from("inventory_allocations")
          .select("id, allocated_quantity")
          .eq("job_id", jobId)
          .eq("item_type", "purchased_part")
          .eq("purchased_part_id", selectedItem.purchased_part_id)
          .maybeSingle();

        if (existing) {
          await supabase
            .from("inventory_allocations")
            .update({ allocated_quantity: Number(existing.allocated_quantity) + amount, basis: "actual" })
            .eq("id", existing.id);
        } else {
          await supabase.from("inventory_allocations").insert({
            company_id: companyId,
            job_id: jobId,
            item_type: "purchased_part",
            purchased_part_id: selectedItem.purchased_part_id,
            raw_material_id: null,
            allocated_quantity: amount,
            unit: "ea",
            basis: "actual",
          });
        }

        await supabase.from("job_material_variances").insert({
          company_id: companyId,
          job_id: jobId,
          job_task_id: task.id,
          reported_by: userId,
          item_type: "purchased_part",
          raw_material_id: null,
          purchased_part_id: selectedItem.purchased_part_id,
          extra_quantity: amount,
          unit: "ea",
          reason,
          notes: notes.trim() || null,
        });
      }

      setSaving(false);
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      setError(msg);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <form onSubmit={save} className="p-5 space-y-3">
          <h2 className="text-xl font-bold text-gray-900">Log scrap</h2>
          <p className="text-sm text-gray-600">Record extra material or parts used because something was scrapped. For raw material, pull a stick and log the remainder so inventory stays accurate.</p>

          {loading ? (
            <p className="text-gray-600">Loading...</p>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Material / part</label>
                <select value={itemKey} onChange={(e) => setItemKey(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">-- Select --</option>
                  {pickItems.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>

              {selectedItem && selectedItem.item_type === "raw_material" && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Stick pulled</label>
                    <select value={pullLength} onChange={(e) => setPullLength(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="">-- Select length --</option>
                      {lengths.map((l) => (
                        <option key={l.length} value={l.length}>{(l.length * 12).toFixed(1)} in ({l.sticks} available)</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Remainder left over</label>
                    <div className="flex gap-2">
                      <input type="number" step="0.01" min="0" value={remainderLength} onChange={(e) => setRemainderLength(e.target.value)} placeholder="0 if none" className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <select value={remainderUnit} onChange={(e) => setRemainderUnit(e.target.value as "ft" | "in")} className="px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="ft">ft</option>
                        <option value="in">in</option>
                      </select>
                    </div>
                    <label className="flex items-center gap-2 mt-2">
                      <input type="checkbox" checked={saveRemainder} onChange={(e) => setSaveRemainder(e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      <span className="text-sm text-gray-700">Save the remainder back to inventory</span>
                    </label>
                  </div>
                </>
              )}

              {selectedItem && selectedItem.item_type === "purchased_part" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Extra parts used</label>
                  <input type="number" step="1" min="0" value={partQty} onChange={(e) => setPartQty(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason <span className="text-red-600">*</span></label>
                <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {SCRAP_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </>
          )}

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Cancel</button>
            <button type="submit" disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{saving ? "Saving..." : "Log scrap"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}