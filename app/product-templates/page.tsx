"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function ProductTemplatesPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [rawMaterials, setRawMaterials] = useState<any[]>([]);
  const [parts, setParts] = useState<any[]>([]);
  const [productMaterials, setProductMaterials] = useState<any[]>([]);
  const [productParts, setProductParts] = useState<any[]>([]);
  const [productTasks, setProductTasks] = useState<any[]>([]);

  const [productName, setProductName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedMaterialId, setSelectedMaterialId] = useState("");
  const [materialQuantity, setMaterialQuantity] = useState("");
  const [selectedPartId, setSelectedPartId] = useState("");
  const [partQuantity, setPartQuantity] = useState("");
  const [taskListText, setTaskListText] = useState("");
  const [sopText, setSopText] = useState("");

  const [templateMaterials, setTemplateMaterials] = useState<any[]>([]);
  const [templateParts, setTemplateParts] = useState<any[]>([]);

  async function fetchProducts() {
    const { data } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });

    if (data) setProducts(data);
  }

  async function fetchRawMaterials() {
    const { data } = await supabase
      .from("raw_materials")
      .select("*")
      .order("name");

    if (data) setRawMaterials(data);
  }

  async function fetchParts() {
    const { data } = await supabase
      .from("parts")
      .select("*")
      .order("name");

    if (data) setParts(data);
  }

  async function fetchProductMaterials() {
    const { data } = await supabase
      .from("product_materials")
      .select("*, raw_materials(*)");

    if (data) setProductMaterials(data);
  }

  async function fetchProductParts() {
    const { data } = await supabase
      .from("product_parts")
      .select("*, parts(*)");

    if (data) setProductParts(data);
  }
  async function fetchProductTasks() {
    const { data } = await supabase
      .from("product_tasks")
      .select("*")
      .order("task_order", { ascending: true });

    if (data) setProductTasks(data);
  }

  function addMaterialToTemplate() {
    if (!selectedMaterialId || !materialQuantity) return;

    const material = rawMaterials.find(
      (item) => item.id === selectedMaterialId
    );

    if (!material) return;

    setTemplateMaterials([
      ...templateMaterials,
      {
        raw_material_id: material.id,
        name: material.name,
        unit: material.unit,
        cost_per_unit: material.cost_per_unit,
        quantity: Number(materialQuantity),
      },
    ]);

    setSelectedMaterialId("");
    setMaterialQuantity("");
  }

  function addPartToTemplate() {
    if (!selectedPartId || !partQuantity) return;

    const part = parts.find((item) => item.id === selectedPartId);

    if (!part) return;

    setTemplateParts([
      ...templateParts,
      {
        part_id: part.id,
        name: part.name,
        part_number: part.part_number,
        cost_each: part.cost_each,
        quantity: Number(partQuantity),
      },
    ]);

    setSelectedPartId("");
    setPartQuantity("");
  }

  async function addProduct() {
    if (!productName) return;

    const { data: newProduct, error } = await supabase
      .from("products")
      .insert([
        {
          part_number: productName,
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

    if (templateMaterials.length > 0) {
      await supabase.from("product_materials").insert(
        templateMaterials.map((item) => ({
          product_id: newProduct.id,
          raw_material_id: item.raw_material_id,
          quantity: item.quantity,
        }))
      );
    }

    if (templateParts.length > 0) {
      await supabase.from("product_parts").insert(
        templateParts.map((item) => ({
          product_id: newProduct.id,
          part_id: item.part_id,
          quantity: item.quantity,
        }))
      );
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

    setProductName("");
    setDescription("");
    setSelectedMaterialId("");
    setMaterialQuantity("");
    setSelectedPartId("");
    setPartQuantity("");
    setTaskListText("");
    setSopText("");
    setTemplateMaterials([]);
    setTemplateParts([]);

    fetchProducts();
    fetchProductMaterials();
    fetchProductParts();
    fetchProductTasks();
  }
  function getMaterialCost(productId: string) {
    return productMaterials
      .filter((item) => item.product_id === productId)
      .reduce((total, item) => {
        return (
          total +
          Number(item.quantity) *
            Number(item.raw_materials?.cost_per_unit || 0)
        );
      }, 0);
  }

  function getPartsCost(productId: string) {
    return productParts
      .filter((item) => item.product_id === productId)
      .reduce((total, item) => {
        return total + Number(item.quantity) * Number(item.parts?.cost_each || 0);
      }, 0);
  }

  useEffect(() => {
    fetchProducts();
    fetchRawMaterials();
    fetchParts();
    fetchProductMaterials();
    fetchProductParts();
    fetchProductTasks();
  }, []);

  return (
    <main className="min-h-screen bg-gray-900 text-white p-8">
      <nav className="mb-8 flex gap-4">
        <a href="/" className="text-blue-400 hover:underline">Dashboard</a>
        <a href="/jobs" className="text-blue-400 hover:underline">Job Boards</a>
        <a href="/product-templates" className="text-blue-400 hover:underline">Products</a>
        <a href="/cost-sheets" className="text-blue-400 hover:underline">Cost Sheets</a>
      </nav>

      <h1 className="text-4xl font-bold mb-8">Product Templates</h1>

      <section className="bg-gray-800 rounded-xl p-6 mb-8">
        <h2 className="text-2xl font-semibold mb-4">Add Product Template</h2>

        <div className="grid grid-cols-1 gap-4">
          <input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="Name / Part Number" className="p-3 rounded-lg bg-gray-700 border border-gray-600" />

          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="p-3 rounded-lg bg-gray-700 border border-gray-600" />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <select value={selectedMaterialId} onChange={(e) => setSelectedMaterialId(e.target.value)} className="p-3 rounded-lg bg-gray-700 border border-gray-600">
              <option value="">Select Material</option>
              {rawMaterials.map((m) => (
                <option key={m.id} value={m.id}>{m.name} — ${m.cost_per_unit}/{m.unit}</option>
              ))}
            </select>

            <input type="number" value={materialQuantity} onChange={(e) => setMaterialQuantity(e.target.value)} placeholder="Material Quantity" className="p-3 rounded-lg bg-gray-700 border border-gray-600" />

            <button onClick={addMaterialToTemplate} className="bg-blue-600 hover:bg-blue-500 px-6 py-3 rounded-lg font-semibold">
              Add Material
            </button>
          </div>

          {templateMaterials.length > 0 && (
            <div className="space-y-2">
              {templateMaterials.map((m, index) => (
                <div key={index} className="border border-gray-700 rounded-lg p-3">
                  {m.quantity} {m.unit} — {m.name}
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <select value={selectedPartId} onChange={(e) => setSelectedPartId(e.target.value)} className="p-3 rounded-lg bg-gray-700 border border-gray-600">
              <option value="">Select Part</option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — ${p.cost_each} each</option>
              ))}
            </select>

            <input type="number" value={partQuantity} onChange={(e) => setPartQuantity(e.target.value)} placeholder="Part Quantity" className="p-3 rounded-lg bg-gray-700 border border-gray-600" />

            <button onClick={addPartToTemplate} className="bg-purple-600 hover:bg-purple-500 px-6 py-3 rounded-lg font-semibold">
              Add Part
            </button>
          </div>

          {templateParts.length > 0 && (
            <div className="space-y-2">
              {templateParts.map((p, index) => (
                <div key={index} className="border border-gray-700 rounded-lg p-3">
                  {p.quantity} each — {p.name}
                </div>
              ))}
            </div>
          )}

          <textarea value={taskListText} onChange={(e) => setTaskListText(e.target.value)} placeholder="Tasks — separate with commas" className="p-3 rounded-lg bg-gray-700 border border-gray-600 min-h-24" />

          <textarea value={sopText} onChange={(e) => setSopText(e.target.value)} placeholder="SOPs / Product Notes" className="p-3 rounded-lg bg-gray-700 border border-gray-600 min-h-32" />

          <button onClick={addProduct} className="bg-green-600 hover:bg-green-500 px-6 py-3 rounded-lg font-semibold">
            Save Product Template
          </button>
        </div>
      </section>

      <section className="bg-gray-800 rounded-xl p-6">
        <h2 className="text-2xl font-semibold mb-4">Saved Product Templates</h2>

        <div className="space-y-3">
          {products.map((product) => (
            <div key={product.id} className="border border-gray-700 rounded-lg p-4">
              <p className="font-semibold text-lg">{product.part_number}</p>
              <p className="text-gray-300">{product.description}</p>
              <p className="text-gray-400 mt-2">Material Cost: ${getMaterialCost(product.id).toFixed(2)}</p>
              <p className="text-gray-400">Parts Cost: ${getPartsCost(product.id).toFixed(2)}</p>
              <p className="text-gray-300 font-semibold mt-2">
                Total Product Cost: ${(getMaterialCost(product.id) + getPartsCost(product.id)).toFixed(2)}
              </p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}