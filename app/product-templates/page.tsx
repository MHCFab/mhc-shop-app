"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function ProductsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [productTasks, setProductTasks] = useState<any[]>([]);
  const [partNumber, setPartNumber] = useState("");
  const [description, setDescription] = useState("");
  const [sopText, setSopText] = useState("");
  const [taskListText, setTaskListText] = useState("");

  async function fetchProducts() {
    const { data } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });

    if (data) setProducts(data);
  }

  async function fetchProductTasks() {
    const { data } = await supabase
      .from("product_tasks")
      .select("*")
      .order("task_order", { ascending: true });

    if (data) setProductTasks(data);
  }

  async function addProduct() {
    if (!partNumber) return;

    const { data: newProduct, error } = await supabase
      .from("products")
      .insert([
        {
          part_number: partNumber,
          description,
          sop_text: sopText,
        },
      ])
      .select()
      .single();

    if (error || !newProduct) {
      alert("Error adding product");
      return;
    }

    const tasks = taskListText
      .split(",")
      .map((task) => task.trim())
      .filter((task) => task.length > 0);

    if (tasks.length > 0) {
      await supabase.from("product_tasks").insert(
        tasks.map((task, index) => ({
          product_id: newProduct.id,
          task_name: task,
          task_order: index + 1,
        }))
      );
    }

    setPartNumber("");
    setDescription("");
    setSopText("");
    setTaskListText("");

    fetchProducts();
    fetchProductTasks();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addProduct();
    }
  }

  useEffect(() => {
    fetchProducts();
    fetchProductTasks();
  }, []);

  return (
    <main className="min-h-screen bg-gray-900 text-white p-8">
      <div className="mb-8">
        <a href="/" className="text-blue-400 hover:underline">
          ← Dashboard
        </a>
      </div>

      <h1 className="text-4xl font-bold mb-8">
        Products
      </h1>

      <div className="bg-gray-800 rounded-xl p-6 mb-8">
        <h2 className="text-2xl font-semibold mb-4">
          Add Product Template
        </h2>

        <div className="grid grid-cols-1 gap-4" onKeyDown={handleKeyDown}>
          <input
            type="text"
            placeholder="Part Number"
            value={partNumber}
            onChange={(e) => setPartNumber(e.target.value)}
            className="p-3 rounded-lg bg-gray-700 border border-gray-600"
          />

          <input
            type="text"
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="p-3 rounded-lg bg-gray-700 border border-gray-600"
          />

          <textarea
            placeholder="Checklist Tasks — separate each task with a comma"
            value={taskListText}
            onChange={(e) => setTaskListText(e.target.value)}
            className="p-3 rounded-lg bg-gray-700 border border-gray-600 min-h-24"
          />

          <textarea
            placeholder="SOP Notes / Product Procedure"
            value={sopText}
            onChange={(e) => setSopText(e.target.value)}
            className="p-3 rounded-lg bg-gray-700 border border-gray-600 min-h-32"
          />

          <button
            onClick={addProduct}
            className="bg-green-600 hover:bg-green-500 px-6 py-3 rounded-lg font-semibold"
          >
            Add Product
          </button>
        </div>
      </div>

      <div className="bg-gray-800 rounded-xl p-6">
        <h2 className="text-2xl font-semibold mb-4">
          Product Templates
        </h2>

        <div className="space-y-3">
          {products.length > 0 ? (
            products.map((product) => (
              <div
                key={product.id}
                className="border border-gray-700 rounded-lg p-4"
              >
                <p className="font-semibold text-lg">
                  {product.part_number}
                </p>

                <p className="text-gray-300">
                  {product.description}
                </p>

                <p className="text-gray-400 text-sm mt-2">
                  Checklist tasks:{" "}
                  {
                    productTasks.filter(
                      (task) => task.product_id === product.id
                    ).length
                  }
                </p>
              </div>
            ))
          ) : (
            <div className="text-gray-400">
              No products yet
            </div>
          )}
        </div>
      </div>
    </main>
  );
}