"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabase";
import {
  getAvailableRawMaterials,
  getAvailablePurchasedParts,
  type AvailableRawMaterial,
  type AvailablePurchasedPart,
} from "../../lib/inventory";

const SHAPES = [
  { value: "round_tube", label: "Round Tube" },
  { value: "square_tube", label: "Square Tube" },
  { value: "rectangle_tube", label: "Rectangle Tube" },
  { value: "channel", label: "Channel" },
  { value: "i_beam", label: "I-Beam" },
  { value: "angle", label: "Angle" },
] as const;

const CATEGORIES = [
    { value: "laser_part", label: "Laser Part" },
    { value: "fastener", label: "Fastener" },
    { value: "caster", label: "Caster" },
    { value: "machined_part", label: "Machined Part" },
    { value: "electrical", label: "Electrical" },
    { value: "hardware", label: "Hardware" },
    { value: "other", label: "Other" },
  ] as const;

function shapeLabel(s: string) {
  return SHAPES.find((x) => x.value === s)?.label || s;
}

function categoryLabel(c: string) {
  return CATEGORIES.find((x) => x.value === c)?.label || c;
}

function describeMaterial(m: AvailableRawMaterial) {
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return shapeLabel(m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

type Tab = "raw_materials" | "purchased_parts";

export default function InventoryPage() {
  const supabase = createClient();
  const [tab, setTab] = useState<Tab>("raw_materials");
  const [materials, setMaterials] = useState<AvailableRawMaterial[]>([]);
  const [parts, setParts] = useState<AvailablePurchasedPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [shapeFilter, setShapeFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [companyId, setCompanyId] = useState<string | null>(null);

  // Purchase modal state
  const [showPurchase, setShowPurchase] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [savingPurchase, setSavingPurchase] = useState(false);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);

  // New item modal state
  const [showNewItem, setShowNewItem] = useState(false);
  const [newItemError, setNewItemError] = useState<string | null>(null);
  const [savingNewItem, setSavingNewItem] = useState(false);

  // New raw material form
  const [newMatForm, setNewMatForm] = useState({
    shape: "round_tube",
    size: "",
    wall_thickness: "",
    grade: "",
    current_cost_per_foot: "",
    notes: "",
  });

  // New purchased part form
  const [newPartForm, setNewPartForm] = useState({
    name: "",
    part_number: "",
    category: "other",
    description: "",
    current_cost_each: "",
    notes: "",
  });

  // Raw material purchase form
  const [rmForm, setRmForm] = useState({
    raw_material_id: "",
    supplier_id: "",
    stick_length_feet: "",
    quantity_sticks: "",
    cost_per_foot: "",
    purchase_date: new Date().toISOString().slice(0, 10),
    notes: "",
  });

  // Purchased part purchase form
  const [ppForm, setPpForm] = useState({
    purchased_part_id: "",
    supplier_id: "",
    quantity: "",
    cost_each: "",
    purchase_date: new Date().toISOString().slice(0, 10),
    notes: "",
  });

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [mats, pts, supsRes] = await Promise.all([
      getAvailableRawMaterials(),
      getAvailablePurchasedParts(),
      supabase.from("suppliers").select("id, name").order("name"),
    ]);
    setMaterials(mats);
    setParts(pts);
    setSuppliers(supsRes.data || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadCompanyId();
    loadData();
  }, [loadCompanyId, loadData]);

  const filteredMaterials = useMemo(() => {
    return materials.filter((m) => {
      if (shapeFilter !== "all" && m.shape !== shapeFilter) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!describeMaterial(m).toLowerCase().includes(s)) return false;
      }
      return true;
    });
  }, [materials, shapeFilter, search]);

  const filteredParts = useMemo(() => {
    return parts.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (search) {
        const s = search.toLowerCase();
        const text = (p.name + " " + (p.part_number || "")).toLowerCase();
        if (!text.includes(s)) return false;
      }
      return true;
    });
  }, [parts, categoryFilter, search]);

  function openPurchase() {
    setPurchaseError(null);
    setRmForm({
      raw_material_id: "",
      supplier_id: "",
      stick_length_feet: "",
      quantity_sticks: "",
      cost_per_foot: "",
      purchase_date: new Date().toISOString().slice(0, 10),
      notes: "",
    });
    setPpForm({
      purchased_part_id: "",
      supplier_id: "",
      quantity: "",
      cost_each: "",
      purchase_date: new Date().toISOString().slice(0, 10),
      notes: "",
    });
    setShowPurchase(true);
  }

  function openNewItem() {
    setNewItemError(null);
    setNewMatForm({
      shape: "round_tube",
      size: "",
      wall_thickness: "",
      grade: "",
      current_cost_per_foot: "",
      notes: "",
    });
    setNewPartForm({
      name: "",
      part_number: "",
      category: "other",
      description: "",
      current_cost_each: "",
      notes: "",
    });
    setShowNewItem(true);
  }

  async function saveNewRawMaterial(e: React.FormEvent) {
    e.preventDefault();
    setNewItemError(null);
    if (!companyId) {
      setNewItemError("Could not determine your company. Try refreshing.");
      return;
    }
    if (!newMatForm.size.trim() || !newMatForm.grade.trim()) {
      setNewItemError("Size and grade are required.");
      return;
    }
    const cost = parseFloat(newMatForm.current_cost_per_foot);
    if (isNaN(cost) || cost < 0) {
      setNewItemError("Please enter a valid cost per foot.");
      return;
    }
    setSavingNewItem(true);
    const { error } = await supabase.from("raw_materials").insert({
      company_id: companyId,
      shape: newMatForm.shape,
      size: newMatForm.size.trim(),
      wall_thickness: newMatForm.wall_thickness.trim() || null,
      grade: newMatForm.grade.trim(),
      current_cost_per_foot: cost,
      notes: newMatForm.notes.trim() || null,
      is_active: true,
    });
    setSavingNewItem(false);
    if (error) {
      setNewItemError(error.message);
      return;
    }
    setShowNewItem(false);
    loadData();
  }

  async function saveNewPurchasedPart(e: React.FormEvent) {
    e.preventDefault();
    setNewItemError(null);
    if (!companyId) {
      setNewItemError("Could not determine your company. Try refreshing.");
      return;
    }
    if (!newPartForm.name.trim()) {
      setNewItemError("Name is required.");
      return;
    }
    const cost = parseFloat(newPartForm.current_cost_each);
    if (isNaN(cost) || cost < 0) {
      setNewItemError("Please enter a valid cost each.");
      return;
    }
    setSavingNewItem(true);
    const { error } = await supabase.from("purchased_parts").insert({
      company_id: companyId,
      name: newPartForm.name.trim(),
      part_number: newPartForm.part_number.trim() || null,
      category: newPartForm.category,
      description: newPartForm.description.trim() || null,
      current_cost_each: cost,
      notes: newPartForm.notes.trim() || null,
      is_active: true,
    });
    setSavingNewItem(false);
    if (error) {
      setNewItemError(error.message);
      return;
    }
    setShowNewItem(false);
    loadData();
  }

  async function saveRawMaterialPurchase(e: React.FormEvent) {
    e.preventDefault();
    setPurchaseError(null);
    if (!companyId) {
      setPurchaseError("Could not determine your company. Try refreshing.");
      return;
    }
    const length = parseFloat(rmForm.stick_length_feet);
    const qty = parseInt(rmForm.quantity_sticks);
    const cost = parseFloat(rmForm.cost_per_foot);
    if (!rmForm.raw_material_id || isNaN(length) || length <= 0 || isNaN(qty) || qty <= 0 || isNaN(cost) || cost < 0) {
      setPurchaseError("Please fill in material, stick length, quantity, and cost per foot with valid values.");
      return;
    }
    setSavingPurchase(true);
    const { error } = await supabase.from("raw_material_inventory").insert({
      company_id: companyId,
      raw_material_id: rmForm.raw_material_id,
      supplier_id: rmForm.supplier_id || null,
      stick_length_feet: length,
      quantity_sticks: qty,
      cost_per_foot: cost,
      purchase_date: rmForm.purchase_date,
      notes: rmForm.notes.trim() || null,
    });
    setSavingPurchase(false);
    if (error) {
      setPurchaseError(error.message);
      return;
    }
    setShowPurchase(false);
    loadData();
  }

  async function savePurchasedPartPurchase(e: React.FormEvent) {
    e.preventDefault();
    setPurchaseError(null);
    if (!companyId) {
      setPurchaseError("Could not determine your company. Try refreshing.");
      return;
    }
    const qty = parseInt(ppForm.quantity);
    const cost = parseFloat(ppForm.cost_each);
    if (!ppForm.purchased_part_id || isNaN(qty) || qty <= 0 || isNaN(cost) || cost < 0) {
      setPurchaseError("Please fill in part, quantity, and cost each with valid values.");
      return;
    }
    setSavingPurchase(true);
    const { error } = await supabase.from("purchased_parts_inventory").insert({
      company_id: companyId,
      purchased_part_id: ppForm.purchased_part_id,
      supplier_id: ppForm.supplier_id || null,
      quantity: qty,
      cost_each: cost,
      purchase_date: ppForm.purchase_date,
      notes: ppForm.notes.trim() || null,
    });
    setSavingPurchase(false);
    if (error) {
      setPurchaseError(error.message);
      return;
    }
    setShowPurchase(false);
    loadData();
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Inventory</h1>
          <p className="text-gray-600 mt-1">Available stock on hand. Available = in stock minus what&apos;s allocated to active jobs.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={openNewItem} className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium hover:bg-gray-50 transition-colors">
            New item
          </button>
          <button onClick={openPurchase} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors">
            Add purchase
          </button>
        </div>
      </div>

      <div className="border-b border-gray-200 mb-6">
        <div className="flex gap-1">
          <button
            onClick={() => setTab("raw_materials")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "raw_materials" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            Raw Materials
          </button>
          <button
            onClick={() => setTab("purchased_parts")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === "purchased_parts" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            Purchased Parts
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        {tab === "raw_materials" ? (
          <select
            value={shapeFilter}
            onChange={(e) => setShapeFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All shapes</option>
            {SHAPES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        ) : (
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        )}
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : tab === "raw_materials" ? (
        filteredMaterials.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-600">No raw materials match your filters.</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Material</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Available (ft)</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Allocated (ft)</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">LIFO $/ft</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700"></th>
                </tr>
              </thead>
              <tbody>
                {filteredMaterials.map((m) => (
                  <tr key={m.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900 font-medium">{describeMaterial(m)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">
                      <span className={m.available <= 0 ? "text-red-600 font-semibold" : "text-gray-900"}>
                        {m.available.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-gray-500">{m.allocated.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-gray-700">${m.lifoCostPerFoot.toFixed(4)}</td>
                    <td className="px-4 py-3 text-sm text-right">
                      <Link href={"/admin/inventory/material/" + m.id} className="text-blue-600 hover:text-blue-800 font-medium">Details</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : filteredParts.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No purchased parts match your filters.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Part</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Category</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Available</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Allocated</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">LIFO $ each</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700"></th>
              </tr>
            </thead>
            <tbody>
              {filteredParts.map((p) => (
                <tr key={p.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm text-gray-900 font-medium">{p.name}{p.part_number ? " (" + p.part_number + ")" : ""}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{categoryLabel(p.category)}</td>
                  <td className="px-4 py-3 text-sm text-right font-mono">
                    <span className={p.available <= 0 ? "text-red-600 font-semibold" : "text-gray-900"}>
                      {p.available.toFixed(0)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-mono text-gray-500">{p.allocated.toFixed(0)}</td>
                  <td className="px-4 py-3 text-sm text-right font-mono text-gray-700">${p.lifoCostEach.toFixed(4)}</td>
                  <td className="px-4 py-3 text-sm text-right">
                    <Link href={"/admin/inventory/part/" + p.id} className="text-blue-600 hover:text-blue-800 font-medium">Details</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showPurchase && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Add purchase</h2>

              <div className="flex gap-1 mb-4 border-b border-gray-200">
                <button
                  onClick={() => setTab("raw_materials")}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 ${tab === "raw_materials" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600"}`}
                >
                  Raw Material
                </button>
                <button
                  onClick={() => setTab("purchased_parts")}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 ${tab === "purchased_parts" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600"}`}
                >
                  Purchased Part
                </button>
              </div>

              {tab === "raw_materials" ? (
                <form onSubmit={saveRawMaterialPurchase} className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Material</label>
                    <select
                      value={rmForm.raw_material_id}
                      onChange={(e) => setRmForm({ ...rmForm, raw_material_id: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">-- Select material --</option>
                      {materials.map((m) => (
                        <option key={m.id} value={m.id}>{describeMaterial(m)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
                    <select
                      value={rmForm.supplier_id}
                      onChange={(e) => setRmForm({ ...rmForm, supplier_id: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">-- Optional --</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Stick length (ft)</label>
                      <input type="number" step="0.01" min="0" value={rmForm.stick_length_feet} onChange={(e) => setRmForm({ ...rmForm, stick_length_feet: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Qty sticks</label>
                      <input type="number" step="1" min="0" value={rmForm.quantity_sticks} onChange={(e) => setRmForm({ ...rmForm, quantity_sticks: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Cost per foot</label>
                      <input type="number" step="0.0001" min="0" value={rmForm.cost_per_foot} onChange={(e) => setRmForm({ ...rmForm, cost_per_foot: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Purchase date</label>
                      <input type="date" value={rmForm.purchase_date} onChange={(e) => setRmForm({ ...rmForm, purchase_date: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                    <input type="text" value={rmForm.notes} onChange={(e) => setRmForm({ ...rmForm, notes: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  {purchaseError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{purchaseError}</div>}
                  <div className="flex justify-end gap-2 pt-2">
                    <button type="button" onClick={() => setShowPurchase(false)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Cancel</button>
                    <button type="submit" disabled={savingPurchase} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{savingPurchase ? "Saving..." : "Add purchase"}</button>
                  </div>
                </form>
              ) : (
                <form onSubmit={savePurchasedPartPurchase} className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Part</label>
                    <select
                      value={ppForm.purchased_part_id}
                      onChange={(e) => setPpForm({ ...ppForm, purchased_part_id: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">-- Select part --</option>
                      {parts.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}{p.part_number ? " (" + p.part_number + ")" : ""}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
                    <select
                      value={ppForm.supplier_id}
                      onChange={(e) => setPpForm({ ...ppForm, supplier_id: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">-- Optional --</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
                      <input type="number" step="1" min="0" value={ppForm.quantity} onChange={(e) => setPpForm({ ...ppForm, quantity: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Cost each</label>
                      <input type="number" step="0.0001" min="0" value={ppForm.cost_each} onChange={(e) => setPpForm({ ...ppForm, cost_each: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Purchase date</label>
                    <input type="date" value={ppForm.purchase_date} onChange={(e) => setPpForm({ ...ppForm, purchase_date: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                    <input type="text" value={ppForm.notes} onChange={(e) => setPpForm({ ...ppForm, notes: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  {purchaseError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{purchaseError}</div>}
                  <div className="flex justify-end gap-2 pt-2">
                    <button type="button" onClick={() => setShowPurchase(false)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Cancel</button>
                    <button type="submit" disabled={savingPurchase} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{savingPurchase ? "Saving..." : "Add purchase"}</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {showNewItem && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">New item</h2>
              <p className="text-sm text-gray-600 mb-4">Add a new material type or part to your catalog. To record a purchase of an existing item, use &quot;Add purchase&quot; instead.</p>

              <div className="flex gap-1 mb-4 border-b border-gray-200">
                <button
                  onClick={() => setTab("raw_materials")}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 ${tab === "raw_materials" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600"}`}
                >
                  Raw Material
                </button>
                <button
                  onClick={() => setTab("purchased_parts")}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 ${tab === "purchased_parts" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600"}`}
                >
                  Purchased Part
                </button>
              </div>

              {tab === "raw_materials" ? (
                <form onSubmit={saveNewRawMaterial} className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Shape</label>
                    <select
                      value={newMatForm.shape}
                      onChange={(e) => setNewMatForm({ ...newMatForm, shape: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {SHAPES.map((s) => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Size</label>
                      <input type="text" placeholder='e.g. 1" or 2x3' value={newMatForm.size} onChange={(e) => setNewMatForm({ ...newMatForm, size: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Wall thickness</label>
                      <input type="text" placeholder="e.g. 0.065 (optional)" value={newMatForm.wall_thickness} onChange={(e) => setNewMatForm({ ...newMatForm, wall_thickness: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Grade</label>
                      <input type="text" placeholder="e.g. A500" value={newMatForm.grade} onChange={(e) => setNewMatForm({ ...newMatForm, grade: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Current cost / ft</label>
                      <input type="number" step="0.0001" min="0" value={newMatForm.current_cost_per_foot} onChange={(e) => setNewMatForm({ ...newMatForm, current_cost_per_foot: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                    <input type="text" value={newMatForm.notes} onChange={(e) => setNewMatForm({ ...newMatForm, notes: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  {newItemError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{newItemError}</div>}
                  <div className="flex justify-end gap-2 pt-2">
                    <button type="button" onClick={() => setShowNewItem(false)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Cancel</button>
                    <button type="submit" disabled={savingNewItem} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{savingNewItem ? "Saving..." : "Add material"}</button>
                  </div>
                </form>
              ) : (
                <form onSubmit={saveNewPurchasedPart} className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                    <input type="text" value={newPartForm.name} onChange={(e) => setNewPartForm({ ...newPartForm, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Part number</label>
                      <input type="text" placeholder="Optional" value={newPartForm.part_number} onChange={(e) => setNewPartForm({ ...newPartForm, part_number: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                      <select
                        value={newPartForm.category}
                        onChange={(e) => setNewPartForm({ ...newPartForm, category: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Current cost each</label>
                    <input type="number" step="0.0001" min="0" value={newPartForm.current_cost_each} onChange={(e) => setNewPartForm({ ...newPartForm, current_cost_each: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                    <input type="text" value={newPartForm.description} onChange={(e) => setNewPartForm({ ...newPartForm, description: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                    <input type="text" value={newPartForm.notes} onChange={(e) => setNewPartForm({ ...newPartForm, notes: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  {newItemError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{newItemError}</div>}
                  <div className="flex justify-end gap-2 pt-2">
                    <button type="button" onClick={() => setShowNewItem(false)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Cancel</button>
                    <button type="submit" disabled={savingNewItem} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{savingNewItem ? "Saving..." : "Add part"}</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}