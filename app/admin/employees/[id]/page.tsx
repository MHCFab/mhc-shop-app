"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "../../../lib/supabase";

type Profile = { id: string; full_name: string | null; email: string; role: string };

type Entry = {
  id: string;
  job_id: string;
  job_task_id: string;
  started_at: string;
  ended_at: string | null;
};

type JobInfo = { id: string; job_number: string; customers: { name: string } | null };
type TaskInfo = { id: string; name: string };

function fmt(secs: number) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (h > 0 ? h + ":" : "") + pad(m) + ":" + pad(s);
}

export default function EmployeeDetailPage() {
  const params = useParams<{ id: string }>();
  const employeeId = params.id;
  const supabase = createClient();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [jobs, setJobs] = useState<Record<string, JobInfo>>({});
  const [taskNames, setTaskNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    const { data: prof } = await supabase
      .from("profiles")
      .select("id, full_name, email, role")
      .eq("id", employeeId)
      .single();
    setProfile((prof || null) as Profile | null);

    const { data: entryData } = await supabase
      .from("time_entries")
      .select("id, job_id, job_task_id, started_at, ended_at")
      .eq("employee_id", employeeId)
      .order("started_at", { ascending: false });
    const entryList = (entryData || []) as Entry[];
    setEntries(entryList);

    // Load job and task info for the entries
    const jobIds = Array.from(new Set(entryList.map((e) => e.job_id)));
    const taskIds = Array.from(new Set(entryList.map((e) => e.job_task_id)));

    if (jobIds.length > 0) {
      const { data: jobData } = await supabase
        .from("jobs")
        .select("id, job_number, customers(name)")
        .in("id", jobIds);
      const jobMap: Record<string, JobInfo> = {};
      for (const j of (jobData || []) as JobInfo[]) jobMap[j.id] = j;
      setJobs(jobMap);
    }

    if (taskIds.length > 0) {
      const { data: taskData } = await supabase
        .from("job_tasks")
        .select("id, name")
        .in("id", taskIds);
      const taskMap: Record<string, string> = {};
      for (const t of (taskData || []) as TaskInfo[]) taskMap[t.id] = t.name;
      setTaskNames(taskMap);
    }

    setLoading(false);
  }, [supabase, employeeId]);

  useEffect(() => {
    load();
  }, [load]);

  function entrySeconds(e: Entry) {
    const end = e.ended_at ? new Date(e.ended_at).getTime() : Date.now();
    return Math.max(0, Math.floor((end - new Date(e.started_at).getTime()) / 1000));
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link href="/admin/employees" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to employees</Link>
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700">Employee not found.</div>
      </div>
    );
  }

  const totalSeconds = entries.reduce((s, e) => s + entrySeconds(e), 0);

  // Group entries by job
  const byJob = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!byJob.has(e.job_id)) byJob.set(e.job_id, []);
    byJob.get(e.job_id)!.push(e);
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link href="/admin/employees" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to employees</Link>

      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">{profile.full_name || profile.email}</h1>
        <p className="text-gray-600 mt-1">{profile.email}</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Total time logged (active jobs)</span>
        <span className="text-2xl font-bold font-mono text-gray-900">{fmt(totalSeconds)}</span>
      </div>

      <p className="text-xs text-gray-500 mb-4">Time logs reflect jobs currently in the system. Once a job is invoiced and archived, its detailed time entries are removed, though the labor is captured in the job&apos;s archived cost summary.</p>

      {entries.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No time logged on any active jobs.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(byJob.entries()).map(([jobId, jobEntries]) => {
            const job = jobs[jobId];
            const jobTotal = jobEntries.reduce((s, e) => s + entrySeconds(e), 0);
            return (
              <div key={jobId} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                  <div>
                    {job ? (
                      <Link href={"/admin/jobs/" + jobId} className="font-semibold text-blue-600 hover:text-blue-800">{job.job_number}</Link>
                    ) : (
                      <span className="font-semibold text-gray-900">Job</span>
                    )}
                    {job?.customers?.name && <span className="text-sm text-gray-600 ml-2">{job.customers.name}</span>}
                  </div>
                  <span className="font-mono text-sm font-semibold text-gray-900">{fmt(jobTotal)}</span>
                </div>
                <table className="w-full">
                  <tbody>
                    {jobEntries.map((e) => (
                      <tr key={e.id} className="border-b border-gray-100 last:border-0">
                        <td className="px-4 py-3 text-sm text-gray-900">{taskNames[e.job_task_id] || "Task"}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {new Date(e.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          {" - "}
                          {e.ended_at ? new Date(e.ended_at).toLocaleString([], { hour: "2-digit", minute: "2-digit" }) : <span className="text-amber-700">open</span>}
                        </td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-gray-900">{fmt(entrySeconds(e))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}