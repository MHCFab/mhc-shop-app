"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabase";

type Entry = {
  id: string;
  job_id: string;
  job_task_id: string;
  employee_id: string;
  started_at: string;
  ended_at: string | null;
};

type Profile = { id: string; full_name: string | null; email: string };
type JobInfo = { id: string; job_number: string; customers: { name: string } | null };

// Format seconds as "32h 15m" (or "45m" / "3h").
function fmtHM(secs: number) {
  const totalMin = Math.round(secs / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return m + "m";
  if (m === 0) return h + "h";
  return h + "h " + m + "m";
}

// Decimal hours, e.g. 32.3
function decHours(secs: number) {
  return (secs / 3600).toFixed(1);
}

// Start of the week (Sunday 00:00 local) for a given week offset (0 = this week).
function weekStartFor(offset: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // back up to Sunday
  d.setDate(d.getDate() + offset * 7);
  return d;
}

export default function TimeReportPage() {
  const supabase = createClient();

  const [weekOffset, setWeekOffset] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [jobs, setJobs] = useState<Record<string, JobInfo>>({});
  const [taskNames, setTaskNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const weekStart = weekStartFor(weekOffset);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const load = useCallback(async () => {
    setLoading(true);

    const startIso = weekStart.toISOString();
    const endIso = weekEnd.toISOString();

    const { data: entryData } = await supabase
      .from("time_entries")
      .select("id, job_id, job_task_id, employee_id, started_at, ended_at")
      .gte("started_at", startIso)
      .lt("started_at", endIso)
      .order("started_at");
    const entryList = (entryData || []) as unknown as Entry[];
    setEntries(entryList);

    const empIds = Array.from(new Set(entryList.map((e) => e.employee_id)));
    const jobIds = Array.from(new Set(entryList.map((e) => e.job_id)));
    const taskIds = Array.from(new Set(entryList.map((e) => e.job_task_id)));

    if (empIds.length > 0) {
      const { data: profData } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", empIds);
      const profMap: Record<string, Profile> = {};
      for (const p of (profData || []) as unknown as Profile[]) profMap[p.id] = p;
      setProfiles(profMap);
    } else {
      setProfiles({});
    }

    if (jobIds.length > 0) {
      const { data: jobData } = await supabase
        .from("jobs")
        .select("id, job_number, customers(name)")
        .in("id", jobIds);
      const jobMap: Record<string, JobInfo> = {};
      for (const j of (jobData || []) as unknown as JobInfo[]) jobMap[j.id] = j;
      setJobs(jobMap);
    } else {
      setJobs({});
    }

    if (taskIds.length > 0) {
      const { data: taskData } = await supabase
        .from("job_tasks")
        .select("id, name")
        .in("id", taskIds);
      const taskMap: Record<string, string> = {};
      for (const t of (taskData || []) as unknown as { id: string; name: string }[]) taskMap[t.id] = t.name;
      setTaskNames(taskMap);
    } else {
      setTaskNames({});
    }

    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, weekOffset]);

  useEffect(() => {
    load();
  }, [load]);

  // Seconds an entry contributes, clamped to the week window.
  function entrySeconds(e: Entry) {
    const segStart = Math.max(new Date(e.started_at).getTime(), weekStart.getTime());
    const rawEnd = e.ended_at ? new Date(e.ended_at).getTime() : Date.now();
    const segEnd = Math.min(rawEnd, weekEnd.getTime());
    return Math.max(0, Math.floor((segEnd - segStart) / 1000));
  }

  function employeeName(id: string) {
    const p = profiles[id];
    if (!p) return "Unknown";
    return p.full_name || p.email;
  }

  const lastDay = new Date(weekEnd);
  lastDay.setDate(lastDay.getDate() - 1);
  const rangeLabel =
    weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " – " +
    lastDay.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  // Group entries by employee, then by job, then summed per task.
  const byEmp = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!byEmp.has(e.employee_id)) byEmp.set(e.employee_id, []);
    byEmp.get(e.employee_id)!.push(e);
  }

  const empSummaries = Array.from(byEmp.entries())
    .map(([empId, empEntries]) => {
      const total = empEntries.reduce((s, e) => s + entrySeconds(e), 0);

      const byJob = new Map<string, Entry[]>();
      for (const e of empEntries) {
        if (!byJob.has(e.job_id)) byJob.set(e.job_id, []);
        byJob.get(e.job_id)!.push(e);
      }

      const jobRows = Array.from(byJob.entries())
        .map(([jobId, jobEntries]) => {
          const jobTotal = jobEntries.reduce((s, e) => s + entrySeconds(e), 0);

          const taskSecs = new Map<string, number>();
          for (const e of jobEntries) {
            taskSecs.set(e.job_task_id, (taskSecs.get(e.job_task_id) || 0) + entrySeconds(e));
          }
          const taskRows = Array.from(taskSecs.entries())
            .map(([taskId, secs]) => ({ taskId, secs }))
            .sort((a, b) => b.secs - a.secs);

          return { jobId, jobTotal, taskRows };
        })
        .sort((a, b) => b.jobTotal - a.jobTotal);

      return { empId, total, jobRows };
    })
    .sort((a, b) => b.total - a.total);

  const companyTotal = empSummaries.reduce((s, e) => s + e.total, 0);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Weekly Time Report</h1>
        <p className="text-gray-600 mt-1">What everyone worked on, and total hours tracked for the week.</p>
      </div>

      {/* Week navigation */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => setWeekOffset((w) => w - 1)}
          className="px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-md"
        >
          &larr; Previous
        </button>
        <div className="text-center">
          <div className="text-lg font-semibold text-gray-900">{rangeLabel}</div>
          {weekOffset === 0 && <div className="text-xs text-gray-500">This week</div>}
        </div>
        <button
          onClick={() => setWeekOffset((w) => Math.min(0, w + 1))}
          disabled={weekOffset >= 0}
          className="px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Next &rarr;
        </button>
      </div>

      {/* Company total */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-gray-700">Total time tracked this week</div>
          <div className="text-xs text-gray-500">
            {empSummaries.length} {empSummaries.length === 1 ? "person" : "people"} logged time
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold text-gray-900">{fmtHM(companyTotal)}</div>
          <div className="text-xs text-gray-500">{decHours(companyTotal)} hrs</div>
        </div>
      </div>

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : empSummaries.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-600">
          No time was logged this week.
        </div>
      ) : (
        <div className="space-y-4">
          {empSummaries.map((emp) => (
            <div key={emp.empId} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900">{employeeName(emp.empId)}</h2>
                <span className="text-right">
                  <span className="font-bold text-gray-900">{fmtHM(emp.total)}</span>
                  <span className="text-xs text-gray-500 ml-2">{decHours(emp.total)} hrs</span>
                </span>
              </div>
              <div className="divide-y divide-gray-100">
                {emp.jobRows.map((jr) => {
                  const job = jobs[jr.jobId];
                  return (
                    <div key={jr.jobId} className="px-4 py-3">
                      <div className="flex items-center justify-between">
                        <div className="text-sm">
                          {job ? (
                            <Link href={"/admin/jobs/" + jr.jobId} className="font-medium text-blue-600 hover:text-blue-800">
                              {job.job_number}
                            </Link>
                          ) : (
                            <span className="font-medium text-gray-900">Job</span>
                          )}
                          {job?.customers?.name && <span className="text-gray-600 ml-2">{job.customers.name}</span>}
                        </div>
                        <span className="font-mono text-sm font-semibold text-gray-900">{fmtHM(jr.jobTotal)}</span>
                      </div>
                      <div className="mt-1.5 space-y-1">
                        {jr.taskRows.map((tr) => (
                          <div key={tr.taskId} className="flex items-center justify-between text-sm text-gray-600 pl-3">
                            <span>{taskNames[tr.taskId] || "Task"}</span>
                            <span className="font-mono text-gray-500">{fmtHM(tr.secs)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-gray-500 mt-6">
        This report reads time from jobs currently in the system. Once a job is invoiced and archived, its detailed time
        entries are removed, so a past week may read low if its jobs have since been archived.
      </p>
    </div>
  );
}
