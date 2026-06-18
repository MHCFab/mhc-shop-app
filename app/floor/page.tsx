"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "../lib/supabase";

type Job = {
  id: string;
  job_number: string;
  status: string;
  due_date: string | null;
  board_order: number;
  customer_id: string;
  customers: { name: string } | null;
  job_line_items: { id: string; quantity: number }[];
  job_tasks: { id: string; status: string }[];
};

type CustomerGroup = {
  customerId: string;
  customerName: string;
  jobs: Job[];
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  ready: { label: "Ready", color: "bg-blue-100 text-blue-800" },
  in_progress: { label: "In Progress", color: "bg-amber-100 text-amber-800" },
};

export default function FloorBoard() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("jobs")
      .select("id, job_number, status, due_date, board_order, customer_id, customers(name), job_line_items(id, quantity), job_tasks(id, status)")
      .in("status", ["ready", "in_progress"])
      .order("board_order", { ascending: true })
      .order("created_at", { ascending: true });

    setJobs((data || []) as unknown as Job[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Group by customer, alphabetical
  const groupMap = new Map<string, CustomerGroup>();
  for (const j of jobs) {
    const cid = j.customer_id;
    const cname = j.customers?.name || "Unknown customer";
    if (!groupMap.has(cid)) groupMap.set(cid, { customerId: cid, customerName: cname, jobs: [] });
    groupMap.get(cid)!.jobs.push(j);
  }
  const groups = Array.from(groupMap.values()).sort((a, b) => a.customerName.localeCompare(b.customerName));

  if (loading) {
    return <p className="text-gray-600">Loading...</p>;
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Job Board</h1>
        <p className="text-gray-600 text-sm mt-1">Jobs ready to build, by customer in priority order.</p>
      </div>

      {groups.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No jobs on the board right now.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.customerId}>
              <h2 className="text-lg font-bold text-gray-900 mb-2">{group.customerName}</h2>
              <div className="space-y-3">
                {group.jobs.map((job, idx) => {
                  const totalUnits = job.job_line_items.reduce((s, li) => s + Number(li.quantity), 0);
                  const totalTasks = job.job_tasks.length;
                  const doneTasks = job.job_tasks.filter((t) => t.status === "complete").length;
                  const status = STATUS_LABELS[job.status] || { label: job.status, color: "bg-gray-100 text-gray-700" };

                  return (
                    <Link
                      key={job.id}
                      href={"/floor/jobs/" + job.id}
                      className="block bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-400 hover:shadow-sm transition-all active:bg-gray-50"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-100 text-gray-700 font-bold text-sm shrink-0">
                            {idx + 1}
                          </div>
                          <div>
                            <div className="font-bold text-gray-900 text-lg leading-tight">{job.job_number}</div>
                            {job.due_date && <div className="text-xs text-gray-500 mt-1">Due {job.due_date}</div>}
                          </div>
                        </div>
                        <span className={"inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0 " + status.color}>
                          {status.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 mt-3 text-sm text-gray-600">
                        <span>{totalUnits} unit{totalUnits === 1 ? "" : "s"}</span>
                        <span>{doneTasks}/{totalTasks} tasks done</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}