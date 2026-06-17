"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";

type TimeEntry = {
  id: string;
  job_task_id: string;
  employee_id: string;
  started_at: string;
  ended_at: string | null;
};

type Task = {
  id: string;
  name: string;
  job_line_item_id: string;
  sort_order: number;
};

type Profile = { id: string; full_name: string | null; email: string };

function fmt(secs: number) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (h > 0 ? h + ":" : "") + pad(m) + ":" + pad(s);
}

// Convert an ISO timestamp to the value format a datetime-local input expects (local time).
function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

export default function TimeTab({ jobId }: { jobId: string }) {
  const supabase = createClient();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [taskRes, entryRes, profRes] = await Promise.all([
      supabase
        .from("job_tasks")
        .select("id, name, job_line_item_id, sort_order")
        .eq("job_id", jobId)
        .order("job_line_item_id")
        .order("sort_order"),
      supabase.from("time_entries").select("id, job_task_id, employee_id, started_at, ended_at").eq("job_id", jobId).order("started_at"),
      supabase.from("profiles").select("id, full_name, email"),
    ]);

    setTasks((taskRes.data || []) as Task[]);
    setEntries((entryRes.data || []) as TimeEntry[]);
    const profMap: Record<string, Profile> = {};
    for (const p of (profRes.data || []) as Profile[]) profMap[p.id] = p;
    setProfiles(profMap);
    setLoading(false);
  }, [supabase, jobId]);

  useEffect(() => {
    load();
  }, [load]);

  function entrySeconds(e: TimeEntry) {
    const end = e.ended_at ? new Date(e.ended_at).getTime() : Date.now();
    return Math.max(0, Math.floor((end - new Date(e.started_at).getTime()) / 1000));
  }

  function employeeName(id: string) {
    const p = profiles[id];
    if (!p) return "Unknown";
    return p.full_name || p.email;
  }

  function openEdit(e: TimeEntry) {
    setEditingId(e.id);
    setEditStart(toLocalInput(e.started_at));
    setEditEnd(e.ended_at ? toLocalInput(e.ended_at) : "");
  }

  async function saveEdit(id: string) {
    if (!editStart) {
      alert("Start time is required.");
      return;
    }
    const startIso = new Date(editStart).toISOString();
    const endIso = editEnd ? new Date(editEnd).toISOString() : null;
    if (endIso && new Date(endIso).getTime() < new Date(startIso).getTime()) {
      alert("End time can't be before start time.");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("time_entries").update({ started_at: startIso, ended_at: endIso }).eq("id", id);
    setSaving(false);
    if (error) {
      alert("Failed to save: " + error.message);
      return;
    }
    setEditingId(null);
    load();
  }

  async function deleteEntry(id: string) {
    if (!confirm("Delete this time entry? This cannot be undone.")) return;
    const { error } = await supabase.from("time_entries").delete().eq("id", id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    load();
  }

  if (loading) return <p className="text-gray-600">Loading...</p>;

  const jobTotal = entries.reduce((s, e) => s + entrySeconds(e), 0);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Total labor time on this job</span>
        <span className="text-xl font-bold font-mono text-gray-900">{fmt(jobTotal)}</span>
      </div>

      {tasks.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-gray-600">No tasks on this job.</div>
      ) : (
        tasks.map((t) => {
          const taskEntries = entries.filter((e) => e.job_task_id === t.id);
          const taskTotal = taskEntries.reduce((s, e) => s + entrySeconds(e), 0);

          return (
            <div key={t.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                <h3 className="font-semibold text-gray-900">{t.name}</h3>
                <span className="font-mono text-sm font-semibold text-gray-900">{fmt(taskTotal)}</span>
              </div>
              {taskEntries.length === 0 ? (
                <p className="px-4 py-3 text-sm text-gray-400">No time logged</p>
              ) : (
                <table className="w-full">
                  <tbody>
                    {taskEntries.map((e) => {
                      const isEditing = editingId === e.id;
                      return (
                        <tr key={e.id} className="border-b border-gray-100 last:border-0">
                          {isEditing ? (
                            <td className="px-4 py-3" colSpan={3}>
                              <div className="space-y-2">
                                <div className="text-sm font-medium text-gray-900">{employeeName(e.employee_id)}</div>
                                <div className="flex flex-wrap items-end gap-2">
                                  <div>
                                    <label className="block text-xs text-gray-600 mb-1">Start</label>
                                    <input type="datetime-local" value={editStart} onChange={(ev) => setEditStart(ev.target.value)} className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900" />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-gray-600 mb-1">End</label>
                                    <input type="datetime-local" value={editEnd} onChange={(ev) => setEditEnd(ev.target.value)} className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900" />
                                  </div>
                                  <button onClick={() => saveEdit(e.id)} disabled={saving} className="px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50">Save</button>
                                  <button onClick={() => setEditingId(null)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
                                </div>
                                {!editEnd && <p className="text-xs text-amber-700">No end time - this entry is still open (counting up).</p>}
                              </div>
                            </td>
                          ) : (
                            <>
                              <td className="px-4 py-3 text-sm text-gray-900">{employeeName(e.employee_id)}</td>
                              <td className="px-4 py-3 text-sm text-gray-600">
                                {new Date(e.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                {" - "}
                                {e.ended_at ? new Date(e.ended_at).toLocaleString([], { hour: "2-digit", minute: "2-digit" }) : <span className="text-amber-700">open</span>}
                              </td>
                              <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                                <span className="font-mono text-gray-900 mr-3">{fmt(entrySeconds(e))}</span>
                                <button onClick={() => openEdit(e)} className="text-blue-600 hover:text-blue-800 font-medium mr-2">Edit</button>
                                <button onClick={() => deleteEntry(e.id)} className="text-red-600 hover:text-red-800 font-medium">Delete</button>
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}