"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function JobsPage() {
  const [boards, setBoards] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [productTasks, setProductTasks] = useState<any[]>([]);

  const [selectedBoardId, setSelectedBoardId] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [dueDate, setDueDate] = useState("");

  async function fetchBoards() {
    const { data } = await supabase
      .from("job_boards")
      .select("*")
      .order("name");

    if (data) setBoards(data);
  }

  async function fetchProducts() {
    const { data } = await supabase
      .from("products")
      .select("*")
      .order("part_number");

    if (data) setProducts(data);
  }

  async function fetchJobs() {
    const { data } = await supabase
      .from("jobs")
      .select("*, products(*)")
      .order("priority", { ascending: true });

    if (data) setJobs(data);
  }

  async function fetchProductTasks() {
    const { data } = await supabase
      .from("product_tasks")
      .select("*")
      .order("task_order", { ascending: true });

    if (data) setProductTasks(data);
  }

  async function addJob() {
    if (!selectedBoardId || !selectedProductId || !quantity) return;

    const { data: newJob, error } = await supabase
      .from("jobs")
      .insert([
        {
          board_id: selectedBoardId,
          product_id: selectedProductId,
          quantity: Number(quantity),
          due_date: dueDate || null,
          priority: getJobsForBoard(selectedBoardId).length + 1,
          status: "not_started",
        },
      ])
      .select()
      .single();

    if (error || !newJob) {
      alert("Error adding job");
      return;
    }

    const tasksForProduct = productTasks.filter(
      (task) => task.product_id === selectedProductId
    );

    if (tasksForProduct.length > 0) {
      await supabase.from("job_tasks").insert(
        tasksForProduct.map((task) => ({
          job_id: newJob.id,
          task_name: task.task_name,
          task_order: task.task_order,
          status: "not_started",
        }))
      );
    }

    setSelectedBoardId("");
    setSelectedProductId("");
    setQuantity("1");
    setDueDate("");

    fetchJobs();
    }

  async function moveJob(jobId: string, boardId: string, direction: "up" | "down") {
    const boardJobs = getJobsForBoard(boardId).sort(
      (a, b) => Number(a.priority) - Number(b.priority)
    );
    
    const currentIndex = boardJobs.findIndex((job) => job.id === jobId);
    const swapIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    
    if (swapIndex < 0 || swapIndex >= boardJobs.length) return;
    
    const currentJob = boardJobs[currentIndex];
    const swapJob = boardJobs[swapIndex];
    
    await supabase
      .from("jobs")
      .update({ priority: swapJob.priority })
      .eq("id", currentJob.id);
    
    await supabase
      .from("jobs")
      .update({ priority: currentJob.priority })
      .eq("id", swapJob.id);
    
    fetchJobs();
  }

  function getJobsForBoard(boardId: string) {
    return jobs.filter((job) => job.board_id === boardId);
  }

  useEffect(() => {
    fetchBoards();
    fetchProducts();
    fetchJobs();
    fetchProductTasks();
  }, []);

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

      <h1 className="text-4xl font-bold mb-8">Job Boards</h1>

      <section className="bg-gray-800 rounded-xl p-6 mb-8">
        <h2 className="text-2xl font-semibold mb-4">Add Job</h2>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <select
            value={selectedBoardId}
            onChange={(e) => setSelectedBoardId(e.target.value)}
            className="p-3 rounded-lg bg-gray-700 border border-gray-600"
          >
            <option value="">Select Board</option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </select>

          <select
            value={selectedProductId}
            onChange={(e) => setSelectedProductId(e.target.value)}
            className="p-3 rounded-lg bg-gray-700 border border-gray-600"
          >
            <option value="">Select Product</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.part_number}
              </option>
            ))}
          </select>

          <input
            type="number"
            placeholder="Qty"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="p-3 rounded-lg bg-gray-700 border border-gray-600"
          />

          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="p-3 rounded-lg bg-gray-700 border border-gray-600"
          />

        </div>

        <button
          onClick={addJob}
          className="mt-4 bg-green-600 hover:bg-green-500 px-6 py-3 rounded-lg font-semibold"
        >
          Add Job
        </button>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {boards.map((board) => (
          <div key={board.id} className="bg-gray-800 rounded-xl p-6">
            <h2 className="text-2xl font-semibold mb-4">{board.name}</h2>

            <div className="space-y-3">
              {getJobsForBoard(board.id).length > 0 ? (
                getJobsForBoard(board.id)
                .sort((a, b) => Number(a.priority) - Number(b.priority))
                .map((job) => (
                  <div
                    key={job.id}
                    className="border border-gray-700 rounded-lg p-4"
                  >
                    <p className="font-semibold text-lg">
                      {job.products?.part_number || "Unknown Product"}
                    </p>

                    <p className="text-gray-300">
                      Qty: {job.quantity}
                    </p>

                    <p className="text-gray-400">
                      Due: {job.due_date || "No due date"}
                    </p>

                    <p className="text-gray-400">
                      Status: {job.status}
                    </p>

                    <div className="flex gap-2 mt-3">
                      <button
                        type="button"
                        onClick={() => moveJob(job.id, board.id, "up")}
                        className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg"
                      >
                        Move Up
                      </button>

                      <button
                        type="button"
                        onClick={() => moveJob(job.id, board.id, "down")}
                        className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg"
                      >
                        Move Down
                      </button>
                    </div>

                    <a
                      href={`/jobs/${job.id}`}
                      className="inline-block mt-3 text-blue-400 hover:underline"
                    >
                      Open Job
                    </a>
                  </div>    
                ))
              ) : (
                <p className="text-gray-400">No jobs on this board</p>
              )}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}