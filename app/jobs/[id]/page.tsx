"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "../../lib/supabase";

export default function JobDetailPage() {
  const params = useParams();
  const jobId = params.id as string;

  const [job, setJob] = useState<any>(null);
  const [jobTasks, setJobTasks] = useState<any[]>([]);

  async function fetchJob() {
    const { data } = await supabase
      .from("jobs")
      .select("*, products(*)")
      .eq("id", jobId)
      .single();

    if (data) setJob(data);
  }

  async function fetchJobTasks() {
    const { data } = await supabase
      .from("job_tasks")
      .select("*")
      .eq("job_id", jobId)
      .order("task_order", { ascending: true });

    if (data) setJobTasks(data);
  }

  async function updateTaskStatus(taskId: string, status: string) {
    await supabase
      .from("job_tasks")
      .update({ status })
      .eq("id", taskId);
  
    const updatedTasks = jobTasks.map((task) =>
      task.id === taskId ? { ...task, status } : task
    );
  
    let newJobStatus = "not_started";
  
    if (updatedTasks.every((task) => task.status === "complete")) {
      newJobStatus = "complete";
    } else if (updatedTasks.some((task) => task.status === "blocked")) {
      newJobStatus = "blocked";
    } else if (updatedTasks.some((task) => task.status === "in_progress")) {
      newJobStatus = "in_progress";
    } else if (updatedTasks.some((task) => task.status === "complete")) {
      newJobStatus = "in_progress";
    }
  
    await supabase
      .from("jobs")
      .update({ status: newJobStatus })
      .eq("id", jobId);
  
    fetchJob();
    fetchJobTasks();
  }

  useEffect(() => {
    fetchJob();
    fetchJobTasks();
  }, []);

  if (!job) {
    return (
      <main className="min-h-screen bg-gray-900 text-white p-8">
        Loading job...
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-900 text-white p-8">
      <nav className="mb-8 flex gap-4">
        <a href="/" className="text-blue-400 hover:underline">
          Dashboard
        </a>
        <a href="/jobs" className="text-blue-400 hover:underline">
          Job Boards
        </a>
        <a href="/product-templates" className="text-blue-400 hover:underline">
          Products
        </a>
        <a href="/cost-sheets" className="text-blue-400 hover:underline">
          Cost Sheets
        </a>
      </nav>

      <h1 className="text-4xl font-bold mb-4">
        {job.products?.part_number}
      </h1>

      <div className="bg-gray-800 rounded-xl p-6 mb-8">
        <p className="text-gray-300">
          Quantity: {job.quantity}
        </p>

        <p className="text-gray-300">
          Due Date: {job.due_date || "No due date"}
        </p>

        <p className="text-gray-300">
          Status: {job.status}
        </p>

        <p className="text-gray-300">
          Priority: {job.priority}
        </p>

        {job.products?.description && (
          <p className="text-gray-400 mt-4">
            {job.products.description}
          </p>
        )}

        {job.products?.sop_text && (
          <div className="mt-6">
            <h2 className="text-2xl font-semibold mb-2">
              SOP Notes
            </h2>
            <p className="text-gray-300 whitespace-pre-wrap">
              {job.products.sop_text}
            </p>
          </div>
        )}
      </div>

      <section className="bg-gray-800 rounded-xl p-6">
        <h2 className="text-2xl font-semibold mb-4">
          Job Tasks
        </h2>

        <div className="space-y-3">
          {jobTasks.length > 0 ? (
            jobTasks.map((task) => (
              <div
                key={task.id}
                className="border border-gray-700 rounded-lg p-4"
              >
                <p className="font-semibold text-lg">
                  {task.task_order}. {task.task_name}
                </p>

                <p className="text-gray-400 mb-3">
                  Status: {task.status}
                </p>

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() =>
                      updateTaskStatus(task.id, "not_started")
                    }
                    className="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded-lg"
                  >
                    Not Started
                  </button>

                  <button
                    onClick={() =>
                      updateTaskStatus(task.id, "in_progress")
                    }
                    className="bg-yellow-600 hover:bg-yellow-500 px-4 py-2 rounded-lg"
                  >
                    In Progress
                  </button>

                  <button
                    onClick={() =>
                      updateTaskStatus(task.id, "complete")
                    }
                    className="bg-green-600 hover:bg-green-500 px-4 py-2 rounded-lg"
                  >
                    Complete
                  </button>

                  <button
                    onClick={() =>
                      updateTaskStatus(task.id, "blocked")
                    }
                    className="bg-red-600 hover:bg-red-500 px-4 py-2 rounded-lg"
                  >
                    Blocked
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-gray-400">
              No tasks found for this job.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}