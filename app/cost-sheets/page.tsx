"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function CostSheetsPage() {
  const [rawMaterials, setRawMaterials] = useState<any[]>([]);
  const [parts, setParts] = useState<any[]>([]);

  const [materialName, setMaterialName] = useState("");
  const [materialUnit, setMaterialUnit] = useState("ft");
  const [materialCost, setMaterialCost] = useState("");

  const [partName, setPartName] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [partCost, setPartCost] = useState("");

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

  async function addRawMaterial() {
    if (!materialName || !materialCost) return;

    await supabase.from("raw_materials").insert([
      {
        name: materialName,
        unit: materialUnit,
        cost_per_unit: Number(materialCost),
      },
    ]);

    setMaterialName("");
    setMaterialUnit("ft");
    setMaterialCost("");

    fetchRawMaterials();
  }

  async function addPart() {
    if (!partName || !partCost) return;

    await supabase.from("parts").insert([
      {
        name: partName,
        part_number: partNumber,
        cost_each: Number(partCost),
      },
    ]);

    setPartName("");
    setPartNumber("");
    setPartCost("");

    fetchParts();
  }

  function handleMaterialKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addRawMaterial();
    }
  }

  function handlePartKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addPart();
    }
  }

  useEffect(() => {
    fetchRawMaterials();
    fetchParts();
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

      <h1 className="text-4xl font-bold mb-8">
        Cost Sheets
      </h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-semibold mb-4">
            Raw Material Cost Sheet
          </h2>

          <div
            className="grid grid-cols-1 gap-4 mb-6"
            onKeyDown={handleMaterialKeyDown}
          >
            <input
              type="text"
              placeholder="Material Name"
              value={materialName}
              onChange={(e) => setMaterialName(e.target.value)}
              className="p-3 rounded-lg bg-gray-700 border border-gray-600"
            />

            <input
              type="text"
              placeholder="Unit — ft, each, lb, sheet"
              value={materialUnit}
              onChange={(e) => setMaterialUnit(e.target.value)}
              className="p-3 rounded-lg bg-gray-700 border border-gray-600"
            />

            <input
              type="number"
              placeholder="Cost Per Unit"
              value={materialCost}
              onChange={(e) => setMaterialCost(e.target.value)}
              className="p-3 rounded-lg bg-gray-700 border border-gray-600"
            />

            <button
              onClick={addRawMaterial}
              className="bg-blue-600 hover:bg-blue-500 px-6 py-3 rounded-lg font-semibold"
            >
              Add Raw Material
            </button>
          </div>

          <div className="space-y-2">
            {rawMaterials.length > 0 ? (
              rawMaterials.map((material) => (
                <div
                  key={material.id}
                  className="border border-gray-700 rounded-lg p-4"
                >
                  <p className="font-semibold">
                    {material.name}
                  </p>

                  <p className="text-gray-400">
                    ${material.cost_per_unit} / {material.unit}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-gray-400">
                No raw materials yet
              </p>
            )}
          </div>
        </section>

        <section className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-semibold mb-4">
            Parts Cost Sheet
          </h2>

          <div
            className="grid grid-cols-1 gap-4 mb-6"
            onKeyDown={handlePartKeyDown}
          >
            <input
              type="text"
              placeholder="Part Name"
              value={partName}
              onChange={(e) => setPartName(e.target.value)}
              className="p-3 rounded-lg bg-gray-700 border border-gray-600"
            />

            <input
              type="text"
              placeholder="Part Number"
              value={partNumber}
              onChange={(e) => setPartNumber(e.target.value)}
              className="p-3 rounded-lg bg-gray-700 border border-gray-600"
            />

            <input
              type="number"
              placeholder="Cost Each"
              value={partCost}
              onChange={(e) => setPartCost(e.target.value)}
              className="p-3 rounded-lg bg-gray-700 border border-gray-600"
            />

            <button
              onClick={addPart}
              className="bg-green-600 hover:bg-green-500 px-6 py-3 rounded-lg font-semibold"
            >
              Add Part
            </button>
          </div>

          <div className="space-y-2">
            {parts.length > 0 ? (
              parts.map((part) => (
                <div
                  key={part.id}
                  className="border border-gray-700 rounded-lg p-4"
                >
                  <p className="font-semibold">
                    {part.name}
                  </p>

                  <p className="text-gray-400">
                    {part.part_number}
                  </p>

                  <p className="text-gray-400">
                    ${part.cost_each} each
                  </p>
                </div>
              ))
            ) : (
              <p className="text-gray-400">
                No parts yet
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}