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
  customers: { name: string } | null;
  job_line_items: { id: string; quantity: number }[];
  job_tasks: { id: string; status: string }[];
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  ready: { label: "Ready", color: "bg-blue-100 text-blue-800" },
  in_progress: { label: "In Progress", color: "bg-amber-100 text-amber-800" },
};

export default function FloorBoard() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      setIsAdmin(profile?.role === "admin");
    }

    // Show only Ready and In Progress jobs on the floor board
    const { data } = await supabase
      .from("jobs")
      .select("id, job_number, status, due_date, board_order, customers(name), job_line_items(id, quantity), job_tasks(id, status)")
      .in("status", ["ready", "in_progress"])
      .order("board_order", { ascending: true })
      .order("created_at", { ascending: true });

    setJobs((data || []) as Job[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return <p className="text-gray-600">Loading...</p>;
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Job Board</h1>
        <p className="text-gray-600 text-sm mt-1">Jobs ready to build, in priority order.</p>
      </div>

      {jobs.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No jobs on the board right now.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job, idx) => {
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
                      <div className="text-sm text-gray-600 mt-0.5">{job.customers?.name || "Unknown customer"}</div>
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
      )}
    </div>
  );
}