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
  const [companyId, setCompanyId] = useState<string | null>(null);

  // Manual "add time" form (one open at a time, per task)
  const [addingTaskId, setAddingTaskId] = useState<string | null>(null);
  const [addEmployee, setAddEmployee] = useState("");
  const [addMode, setAddMode] = useState<"duration" | "range">("duration");
  const [addDate, setAddDate] = useState("");
  const [addHours, setAddHours] = useState("");
  const [addMinutes, setAddMinutes] = useState("");
  const [addStart, setAddStart] = useState("");
  const [addEnd, setAddEnd] = useState("");
  const [addSaving, setAddSaving] = useState(false);

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

    setTasks((taskRes.data || []) as unknown as Task[]);
    setEntries((entryRes.data || []) as unknown as TimeEntry[]);
    const profMap: Record<string, Profile> = {};
    for (const p of (profRes.data || []) as unknown as Profile[]) profMap[p.id] = p;
    setProfiles(profMap);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: prof } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
      if (prof) setCompanyId((prof as { company_id: string }).company_id);
    }
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

  function openAdd(taskId: string) {
    setAddingTaskId(taskId);
    setAddEmployee("");
    setAddMode("duration");
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    setAddDate(now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()));
    setAddHours("");
    setAddMinutes("");
    setAddStart("");
    setAddEnd("");
  }

  async function saveAdd(taskId: string) {
    if (!companyId) { alert("Couldn't determine your company. Refresh and try again."); return; }
    if (!addEmployee) { alert("Pick an employee."); return; }

    let startIso: string;
    let endIso: string;

    if (addMode === "duration") {
      if (!addDate) { alert("Pick a date."); return; }
      const h = parseInt(addHours || "0", 10);
      const m = parseInt(addMinutes || "0", 10);
      const totalMin = (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
      if (totalMin <= 0) { alert("Enter how long they worked (hours and/or minutes)."); return; }
      const start = new Date(addDate + "T08:00");
      if (isNaN(start.getTime())) { alert("That date isn't valid."); return; }
      startIso = start.toISOString();
      endIso = new Date(start.getTime() + totalMin * 60000).toISOString();
    } else {
      if (!addStart) { alert("Enter a start time."); return; }
      if (!addEnd) { alert("Enter an end time."); return; }
      const s = new Date(addStart);
      const e = new Date(addEnd);
      if (e.getTime() <= s.getTime()) { alert("End time must be after start time."); return; }
      startIso = s.toISOString();
      endIso = e.toISOString();
    }

    setAddSaving(true);
    const { error } = await supabase.from("time_entries").insert({
      company_id: companyId,
      job_id: jobId,
      job_task_id: taskId,
      employee_id: addEmployee,
      started_at: startIso,
      ended_at: endIso,
    });
    setAddSaving(false);
    if (error) { alert("Failed to add time: " + error.message); return; }
    setAddingTaskId(null);
    load();
  }
  if (loading) return <p className="text-gray-600">Loading...</p>;

  const jobTotal = entries.reduce((s, e) => s + entrySeconds(e), 0);
  const employeeList = Object.values(profiles).sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));

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
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-semibold text-gray-900">{fmt(taskTotal)}</span>
                  <button onClick={() => (addingTaskId === t.id ? setAddingTaskId(null) : openAdd(t.id))} className="text-sm text-blue-600 hover:text-blue-800 font-medium">{addingTaskId === t.id ? "Cancel" : "+ Add time"}</button>
                </div>
              </div>
              {addingTaskId === t.id && (
                <div className="px-4 py-3 border-b border-gray-200 bg-blue-50 space-y-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Employee</label>
                      <select value={addEmployee} onChange={(e) => setAddEmployee(e.target.value)} className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 bg-white">
                        <option value="">-- Select --</option>
                        {employeeList.map((p) => (
                          <option key={p.id} value={p.id}>{p.full_name || p.email}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Entry type</label>
                      <select value={addMode} onChange={(e) => setAddMode(e.target.value as "duration" | "range")} className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 bg-white">
                        <option value="duration">Date + duration</option>
                        <option value="range">Start &amp; end time</option>
                      </select>
                    </div>
                  </div>
                  {addMode === "duration" ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Date</label>
                        <input type="date" value={addDate} onChange={(e) => setAddDate(e.target.value)} className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Hours</label>
                        <input type="number" min="0" step="1" value={addHours} onChange={(e) => setAddHours(e.target.value)} placeholder="0" className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-gray-900" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Minutes</label>
                        <input type="number" min="0" max="59" step="1" value={addMinutes} onChange={(e) => setAddMinutes(e.target.value)} placeholder="0" className="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-gray-900" />
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-end gap-2">
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Start</label>
                        <input type="datetime-local" value={addStart} onChange={(e) => setAddStart(e.target.value)} className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">End</label>
                        <input type="datetime-local" value={addEnd} onChange={(e) => setAddEnd(e.target.value)} className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900" />
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={() => saveAdd(t.id)} disabled={addSaving} className="px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50">{addSaving ? "Adding..." : "Add time"}</button>
                    <button onClick={() => setAddingTaskId(null)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
                    {addMode === "duration" && <span className="text-xs text-gray-500">Logged starting 8:00 AM on the chosen date.</span>}
                  </div>
                </div>
              )}
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