"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "../../../lib/supabase";

type Profile = { id: string; full_name: string | null; email: string; role: string };

type Entry = {
  id: string;
  job_id: string | null;
  job_task_id: string | null;
  started_at: string;
  ended_at: string | null;
  archived_job_number: string | null;
  archived_task_name: string | null;
  invoiced_on: string | null;
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
  // job number -> customer, for invoiced (archived) jobs
  const [archivedCustomers, setArchivedCustomers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    const { data: prof } = await supabase
      .from("profiles")
      .select("id, full_name, email, role")
      .eq("id", employeeId)
      .single();
    setProfile((prof || null) as Profile | null);

    // Time from invoiced jobs is kept for good (KEEP-TIME-V1) - no cleanup here.
    // Entries are kept for good now, so an employee can pass the API's
    // 1000-rows-a-call limit - read them in pages.
    const entryList: Entry[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: entryData } = await supabase
        .from("time_entries")
        .select("id, job_id, job_task_id, started_at, ended_at, archived_job_number, archived_task_name, invoiced_on")
        .eq("employee_id", employeeId)
        .order("started_at", { ascending: false })
        .order("id")
        .range(from, from + 999);
      const rows = (entryData || []) as unknown as Entry[];
      entryList.push(...rows);
      if (rows.length < 1000) break;
    }
    setEntries(entryList);

    // Lookups go in batches so a long list of ids can't overrun the request.
    const chunks = <T,>(arr: T[]) => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += 100) out.push(arr.slice(i, i + 100));
      return out;
    };

    // Load job and task info for the entries
    const jobIds = Array.from(new Set(entryList.map((e) => e.job_id).filter((x): x is string => !!x)));
    const taskIds = Array.from(new Set(entryList.map((e) => e.job_task_id).filter((x): x is string => !!x)));

    const jobMap: Record<string, JobInfo> = {};
    for (const ids of chunks(jobIds)) {
      const { data: jobData } = await supabase
        .from("jobs")
        .select("id, job_number, customers(name)")
        .in("id", ids);
      for (const j of ((jobData || []) as unknown as JobInfo[])) jobMap[j.id] = j;
    }
    setJobs(jobMap);

    const taskMap: Record<string, string> = {};
    for (const ids of chunks(taskIds)) {
      const { data: taskData } = await supabase
        .from("job_tasks")
        .select("id, name")
        .in("id", ids);
      for (const t of (taskData || []) as unknown as TaskInfo[]) taskMap[t.id] = t.name;
    }
    setTaskNames(taskMap);

    // Invoiced jobs are gone from jobs - look the customer up on the archive
    // record by the job number stamped on the entry.
    const archNums = Array.from(new Set(entryList.filter((e) => !e.job_id && e.archived_job_number).map((e) => e.archived_job_number as string)));
    const custMap: Record<string, string> = {};
    for (const nums of chunks(archNums)) {
      const { data: archData } = await supabase
        .from("completed_jobs_archive")
        .select("job_number, customer_name")
        .in("job_number", nums);
      for (const a of (archData || []) as unknown as { job_number: string; customer_name: string | null }[]) {
        if (a.customer_name) custMap[a.job_number] = a.customer_name;
      }
    }
    setArchivedCustomers(custMap);

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

  // Group entries by job (invoiced jobs group by their stamped job number)
  const byJob = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = e.job_id || "archived|" + (e.archived_job_number || "Job");
    if (!byJob.has(key)) byJob.set(key, []);
    byJob.get(key)!.push(e);
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link href="/admin/employees" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">&larr; Back to employees</Link>

      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">{profile.full_name || profile.email}</h1>
        <p className="text-gray-600 mt-1">{profile.email}</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Total time logged</span>
        <span className="text-2xl font-bold font-mono text-gray-900">{fmt(totalSeconds)}</span>
      </div>

      <p className="text-xs text-gray-500 mb-4">Time from invoiced jobs stays here for good, marked &quot;Invoiced&quot;, under the job number it was tracked on.</p>

      {entries.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No time logged yet.</p>
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
                      <span className="font-semibold text-gray-900">
                        {jobEntries[0].archived_job_number || "Job"}
                        {jobEntries[0].invoiced_on && (
                          <span className="ml-2 text-xs font-normal text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">Invoiced</span>
                        )}
                      </span>
                    )}
                    {job?.customers?.name && <span className="text-sm text-gray-600 ml-2">{job.customers.name}</span>}
                    {!job && jobEntries[0].archived_job_number && archivedCustomers[jobEntries[0].archived_job_number] && (
                      <span className="text-sm text-gray-600 ml-2">{archivedCustomers[jobEntries[0].archived_job_number]}</span>
                    )}
                  </div>
                  <span className="font-mono text-sm font-semibold text-gray-900">{fmt(jobTotal)}</span>
                </div>
                <table className="w-full">
                  <tbody>
                    {jobEntries.map((e) => (
                      <tr key={e.id} className="border-b border-gray-100 last:border-0">
                        <td className="px-4 py-3 text-sm text-gray-900">{(e.job_task_id && taskNames[e.job_task_id]) || e.archived_task_name || "Task"}</td>
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