"use client";

import { Fragment, useEffect, useMemo, useState, useCallback } from "react";
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
  { value: "flat_bar", label: "Flat Bar" },
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

// Categories whose parts are further grouped by customer in the list.
const CUSTOMER_GROUPED = new Set(["laser_part", "machined_part"]);

function shapeLabel(s: string) {
  return SHAPES.find((x) => x.value === s)?.label || s;
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
  const [showInactive, setShowInactive] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);

  // Purchase modal state
  const [showPurchase, setShowPurchase] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [savingPurchase, setSavingPurchase] = useState(false);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);

  // Collapsible group state (keys are open). Empty = all collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

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
    open_length: "",
    open_qty: "",
    open_cost: "",
  });

  // New purchased part form
  const [newPartForm, setNewPartForm] = useState({
    name: "",
    part_number: "",
    category: "other",
    description: "",
    current_cost_each: "",
    customer_id: "",
    notes: "",
    open_qty: "",
    open_cost: "",
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
    const [mats, pts, supsRes, custRes] = await Promise.all([
      getAvailableRawMaterials(),
      getAvailablePurchasedParts(),
      supabase.from("suppliers").select("id, name").order("name"),
      supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
    ]);
    setMaterials(mats);
    setParts(pts);
    setSuppliers(supsRes.data || []);
    setCustomers((custRes.data || []) as { id: string; name: string }[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadCompanyId();
    loadData();
  }, [loadCompanyId, loadData]);

  const filteredMaterials = useMemo(() => {
    return materials.filter((m) => {
      if (!showInactive && !m.is_active) return false;
      if (shapeFilter !== "all" && m.shape !== shapeFilter) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!describeMaterial(m).toLowerCase().includes(s)) return false;
      }
      return true;
    });
  }, [materials, shapeFilter, search, showInactive]);

  const filteredParts = useMemo(() => {
    return parts.filter((p) => {
      if (!showInactive && !p.is_active) return false;
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (search) {
        const s = search.toLowerCase();
        const text = (p.name + " " + (p.part_number || "")).toLowerCase();
        if (!text.includes(s)) return false;
      }
      return true;
    });
  }, [parts, categoryFilter, search, showInactive]);

  // Group materials by shape (in SHAPES order) for collapsible sections.
  const materialGroups = useMemo(() => {
    return SHAPES
      .map((s) => ({
        key: s.value,
        label: s.label,
        items: filteredMaterials.filter((m) => m.shape === s.value),
      }))
      .filter((g) => g.items.length > 0);
  }, [filteredMaterials]);

  // Group parts by category (in CATEGORIES order). Laser & machined parts get a
  // second level grouped by customer, with an "Unassigned" bucket last.
  const partGroups = useMemo(() => {
    return CATEGORIES
      .map((c) => {
        const items = filteredParts.filter((p) => p.category === c.value);
        let customerGroups:
          | { key: string; label: string; items: AvailablePurchasedPart[] }[]
          | null = null;
        if (CUSTOMER_GROUPED.has(c.value) && items.length > 0) {
          const map = new Map<string, { key: string; label: string; items: AvailablePurchasedPart[] }>();
          for (const p of items) {
            const cid = p.customer_id || "__none__";
            const label = p.customerName || "Unassigned";
            if (!map.has(cid)) map.set(cid, { key: c.value + "::" + cid, label, items: [] });
            map.get(cid)!.items.push(p);
          }
          customerGroups = Array.from(map.values()).sort((a, b) => {
            if (a.label === "Unassigned") return 1;
            if (b.label === "Unassigned") return -1;
            return a.label.localeCompare(b.label);
          });
        }
        return { key: c.value, label: c.label, items, customerGroups };
      })
      .filter((g) => g.items.length > 0);
  }, [filteredParts]);

  // When searching, auto-reveal every group so matches are always visible.
  const searching = search.trim() !== "";
  const isOpen = (key: string) => searching || expanded.has(key);

  function renderPartRow(p: AvailablePurchasedPart, indent = false) {
    return (
      <tr key={p.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
        <td className={"px-4 py-3 text-sm text-gray-900 font-medium" + (indent ? " pl-12" : "")}>
          {p.name}{p.part_number ? " (" + p.part_number + ")" : ""}
          {!p.is_active && <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">Inactive</span>}
        </td>
        <td className="px-4 py-3 text-sm text-right font-mono">
          <span className={p.available <= 0 ? "text-red-600 font-semibold" : "text-gray-900"}>{p.available.toFixed(0)}</span>
        </td>
        <td className="px-4 py-3 text-sm text-right font-mono text-gray-500">{p.allocated.toFixed(0)}</td>
        <td className="px-4 py-3 text-sm text-right font-mono text-gray-700">${p.lifoCostEach.toFixed(4)}</td>
        <td className="px-4 py-3 text-sm text-right">
          <Link href={"/admin/inventory/part/" + p.id} className="text-blue-600 hover:text-blue-800 font-medium">Details</Link>
        </td>
      </tr>
    );
  }

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
      open_length: "",
      open_qty: "",
      open_cost: "",
    });
    setNewPartForm({
      name: "",
      part_number: "",
      category: "other",
      description: "",
      current_cost_each: "",
      customer_id: "",
      notes: "",
      open_qty: "",
      open_cost: "",
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

    // Optional starting stock added along with the new material.
    const hasOpening = newMatForm.open_qty.trim() !== "" || newMatForm.open_length.trim() !== "";
    let openLength = 0;
    let openQty = 0;
    let openCost = cost;
    if (hasOpening) {
      openLength = parseFloat(newMatForm.open_length);
      openQty = parseInt(newMatForm.open_qty);
      if (isNaN(openLength) || openLength <= 0 || isNaN(openQty) || openQty <= 0) {
        setNewItemError("To add starting stock, enter a stick length and quantity greater than 0 (or leave both blank).");
        return;
      }
      if (newMatForm.open_cost.trim() !== "") {
        openCost = parseFloat(newMatForm.open_cost);
        if (isNaN(openCost) || openCost < 0) {
          setNewItemError("Starting stock cost per foot is invalid.");
          return;
        }
      }
    }

    setSavingNewItem(true);
    const { data: newMat, error } = await supabase.from("raw_materials").insert({
      company_id: companyId,
      shape: newMatForm.shape,
      size: newMatForm.size.trim(),
      wall_thickness: newMatForm.wall_thickness.trim() || null,
      grade: newMatForm.grade.trim(),
      current_cost_per_foot: cost,
      notes: newMatForm.notes.trim() || null,
      is_active: true,
    }).select("id").single();
    if (error || !newMat) {
      setSavingNewItem(false);
      setNewItemError(error?.message || "Could not create the material.");
      return;
    }

    if (hasOpening) {
      const { error: invErr } = await supabase.from("raw_material_inventory").insert({
        company_id: companyId,
        raw_material_id: newMat.id,
        supplier_id: null,
        stick_length_feet: openLength,
        quantity_sticks: openQty,
        cost_per_foot: openCost,
        purchase_date: new Date().toISOString().slice(0, 10),
        source_note: "Opening stock",
        notes: "Added when material was created",
      });
      if (invErr) {
        setSavingNewItem(false);
        setNewItemError("Material was created, but saving the starting stock failed: " + invErr.message);
        return;
      }
    }

    setSavingNewItem(false);
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

    // Optional quantity on hand added along with the new part.
    const hasOpening = newPartForm.open_qty.trim() !== "";
    let openQty = 0;
    let openCost = cost;
    if (hasOpening) {
      openQty = parseInt(newPartForm.open_qty);
      if (isNaN(openQty) || openQty <= 0) {
        setNewItemError("Quantity on hand must be a whole number greater than 0 (or leave it blank).");
        return;
      }
      if (newPartForm.open_cost.trim() !== "") {
        openCost = parseFloat(newPartForm.open_cost);
        if (isNaN(openCost) || openCost < 0) {
          setNewItemError("Quantity-on-hand cost each is invalid.");
          return;
        }
      }
    }

    setSavingNewItem(true);
    const { data: newPart, error } = await supabase.from("purchased_parts").insert({
      company_id: companyId,
      name: newPartForm.name.trim(),
      part_number: newPartForm.part_number.trim() || null,
      category: newPartForm.category,
      description: newPartForm.description.trim() || null,
      current_cost_each: cost,
      customer_id: newPartForm.customer_id || null,
      notes: newPartForm.notes.trim() || null,
      is_active: true,
    }).select("id").single();
    if (error || !newPart) {
      setSavingNewItem(false);
      setNewItemError(error?.message || "Could not create the part.");
      return;
    }

    if (hasOpening) {
      const { error: invErr } = await supabase.from("purchased_parts_inventory").insert({
        company_id: companyId,
        purchased_part_id: newPart.id,
        supplier_id: null,
        quantity: openQty,
        cost_each: openCost,
        purchase_date: new Date().toISOString().slice(0, 10),
        notes: "Opening stock (added when part was created)",
      });
      if (invErr) {
        setSavingNewItem(false);
        setNewItemError("Part was created, but saving the quantity on hand failed: " + invErr.message);
        return;
      }
    }

    setSavingNewItem(false);
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
        <label className="flex items-center gap-2 px-1 text-sm text-gray-700 whitespace-nowrap cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          Show inactive
        </label>
      </div>

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : tab === "raw_materials" ? (
        materialGroups.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-600">No raw materials match your filters.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {materialGroups.map((g) => {
              const open = isOpen(g.key);
              return (
                <div key={g.key} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <button onClick={() => toggleGroup(g.key)} className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left">
                    <span className="flex items-center gap-2 font-semibold text-gray-900">
                      <span className={"inline-block transition-transform " + (open ? "rotate-90" : "")}>&#9656;</span>
                      {g.label}
                    </span>
                    <span className="text-sm text-gray-500">{g.items.length} item{g.items.length === 1 ? "" : "s"}</span>
                  </button>
                  {open && (
                    <table className="w-full border-t border-gray-200">
                      <thead className="bg-white border-b border-gray-200">
                        <tr>
                          <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Material</th>
                          <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Available (ft)</th>
                          <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Allocated (ft)</th>
                          <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">LIFO $/ft</th>
                          <th className="px-4 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((m) => (
                          <tr key={m.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                            <td className="px-4 py-3 text-sm text-gray-900 font-medium">
                              {describeMaterial(m)}
                              {!m.is_active && <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">Inactive</span>}
                            </td>
                            <td className="px-4 py-3 text-sm text-right font-mono">
                              <span className={m.available <= 0 ? "text-red-600 font-semibold" : "text-gray-900"}>{m.available.toFixed(2)}</span>
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
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : partGroups.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No purchased parts match your filters.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {partGroups.map((g) => {
            const open = isOpen(g.key);
            return (
              <div key={g.key} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <button onClick={() => toggleGroup(g.key)} className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left">
                  <span className="flex items-center gap-2 font-semibold text-gray-900">
                    <span className={"inline-block transition-transform " + (open ? "rotate-90" : "")}>&#9656;</span>
                    {g.label}
                  </span>
                  <span className="text-sm text-gray-500">{g.items.length} item{g.items.length === 1 ? "" : "s"}</span>
                </button>
                {open && (
                  <table className="w-full border-t border-gray-200">
                    <thead className="bg-white border-b border-gray-200">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Part</th>
                        <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Available</th>
                        <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Allocated</th>
                        <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">LIFO $ each</th>
                        <th className="px-4 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.customerGroups
                        ? g.customerGroups.map((cg) => {
                            const copen = isOpen(cg.key);
                            return (
                              <Fragment key={cg.key}>
                                <tr className="bg-gray-50/60 border-b border-gray-100">
                                  <td colSpan={5} className="px-4 py-2 pl-8">
                                    <button onClick={() => toggleGroup(cg.key)} className="flex items-center gap-2 text-sm font-medium text-gray-700 w-full text-left">
                                      <span className={"inline-block transition-transform " + (copen ? "rotate-90" : "")}>&#9656;</span>
                                      {cg.label}
                                      <span className="text-xs text-gray-400 font-normal">({cg.items.length})</span>
                                    </button>
                                  </td>
                                </tr>
                                {copen && cg.items.map((p) => renderPartRow(p, true))}
                              </Fragment>
                            );
                          })
                        : g.items.map((p) => renderPartRow(p))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
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
                      {materials.filter((m) => m.is_active).map((m) => (
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
                      {parts.filter((p) => p.is_active).map((p) => (
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
                  <div className="border-t border-gray-200 pt-3">
                    <p className="text-sm font-medium text-gray-700">Starting stock <span className="text-gray-400 font-normal">(optional)</span></p>
                    <p className="text-xs text-gray-500 mb-2">Already have this on hand &mdash; e.g. just received an order? Add it here. Leave blank to add stock later.</p>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Stick length (ft)</label>
                        <input type="number" step="0.01" min="0" value={newMatForm.open_length} onChange={(e) => setNewMatForm({ ...newMatForm, open_length: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Qty sticks</label>
                        <input type="number" step="1" min="0" value={newMatForm.open_qty} onChange={(e) => setNewMatForm({ ...newMatForm, open_qty: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Cost / ft</label>
                        <input type="number" step="0.0001" min="0" value={newMatForm.open_cost} onChange={(e) => setNewMatForm({ ...newMatForm, open_cost: e.target.value })} placeholder={newMatForm.current_cost_per_foot || "catalog"} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                    </div>
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">Customer <span className="text-gray-400 font-normal">(optional)</span></label>
                    <select value={newPartForm.customer_id} onChange={(e) => setNewPartForm({ ...newPartForm, customer_id: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="">&mdash; None &mdash;</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">Mainly for laser &amp; machined parts that belong to a specific customer.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                    <input type="text" value={newPartForm.notes} onChange={(e) => setNewPartForm({ ...newPartForm, notes: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div className="border-t border-gray-200 pt-3">
                    <p className="text-sm font-medium text-gray-700">Quantity on hand <span className="text-gray-400 font-normal">(optional)</span></p>
                    <p className="text-xs text-gray-500 mb-2">Already have some of these? Add the count now instead of adjusting later.</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Quantity</label>
                        <input type="number" step="1" min="0" value={newPartForm.open_qty} onChange={(e) => setNewPartForm({ ...newPartForm, open_qty: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Cost each</label>
                        <input type="number" step="0.0001" min="0" value={newPartForm.open_cost} onChange={(e) => setNewPartForm({ ...newPartForm, open_cost: e.target.value })} placeholder={newPartForm.current_cost_each || "catalog"} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      </div>
                    </div>
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