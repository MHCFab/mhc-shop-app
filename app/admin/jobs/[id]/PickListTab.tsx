"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";

const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
  flat_bar: "Flat Bar",
};

const CUSTOM_CATEGORIES: { value: string; label: string }[] = [
  { value: "material", label: "Material" },
  { value: "laser_part", label: "Laser part" },
  { value: "powdercoat", label: "Powdercoat" },
  { value: "hardware", label: "Hardware" },
];

function customCategoryLabel(value: string | null) {
  return CUSTOM_CATEGORIES.find((c) => c.value === value)?.label || "Other";
}

type PickListItem = {
  id: string;
  item_type: "raw_material" | "purchased_part" | "fabricated" | "custom";
  raw_material_id: string | null;
  purchased_part_id: string | null;
  product_template_id: string | null;
  planned_quantity: number;
  actual_quantity: number;
  unit: string;
  notes: string | null;
  custom_name: string | null;
  custom_category: string | null;
  custom_unit_cost: number | null;
  raw_materials: {
    shape: string;
    size: string;
    wall_thickness: string | null;
    grade: string;
    current_cost_per_foot: number;
  } | null;
  purchased_parts: {
    name: string;
    part_number: string | null;
    current_cost_each: number;
  } | null;
  product_templates: {
    name: string;
    product_number: string | null;
  } | null;
};

type RawMaterialOption = {
  id: string;
  shape: string;
  size: string;
  wall_thickness: string | null;
  grade: string;
};

type PartOption = {
  id: string;
  name: string;
  part_number: string | null;
};

function describePickItem(item: PickListItem) {
  if (item.item_type === "raw_material" && item.raw_materials) {
    const m = item.raw_materials;
    const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
    return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
  }
  if (item.item_type === "purchased_part" && item.purchased_parts) {
    const p = item.purchased_parts;
    return p.name + (p.part_number ? " (" + p.part_number + ")" : "");
  }
  if (item.item_type === "fabricated" && item.product_templates) {
    const t = item.product_templates;
    return t.name + (t.product_number ? " (" + t.product_number + ")" : "");
  }
  if (item.item_type === "custom") {
    return item.custom_name || "One-off item";
  }
  return "Unknown item";
}

function describeMaterialOption(m: RawMaterialOption) {
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

function itemCostPerUnit(item: PickListItem) {
  if (item.item_type === "custom") return Number(item.custom_unit_cost || 0);
  if (item.item_type === "raw_material") return Number(item.raw_materials?.current_cost_per_foot || 0);
  return Number(item.purchased_parts?.current_cost_each || 0);
}

export default function PickListTab({ jobId, readOnly = false }: { jobId: string; readOnly?: boolean }) {
  const supabase = createClient();
  const [items, setItems] = useState<PickListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ planned_quantity: "", actual_quantity: "", notes: "" });
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);

  // Is this a custom (no-template) job? If so, hide Regenerate and allow manual add.
  const [isCustomJob, setIsCustomJob] = useState(false);

  // Add-item form
  const [adding, setAdding] = useState(false);
  const [allMaterials, setAllMaterials] = useState<RawMaterialOption[]>([]);
  const [allParts, setAllParts] = useState<PartOption[]>([]);
  const [addForm, setAddForm] = useState({ mode: "inventory" as "inventory" | "custom", item_type: "raw_material" as "raw_material" | "purchased_part", item_id: "", planned_quantity: "", notes: "", custom_category: "material", custom_name: "", custom_unit_cost: "" });
  const [savingAdd, setSavingAdd] = useState(false);

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("job_pick_list_items")
      .select("*, raw_materials(shape, size, wall_thickness, grade, current_cost_per_foot), purchased_parts(name, part_number, current_cost_each), product_templates(name, product_number)")
      .eq("job_id", jobId)
      .order("item_type")
      .order("created_at");
    if (error) setError(error.message);
    else setItems((data || []) as unknown as PickListItem[]);
    setLoading(false);
  }, [supabase, jobId]);

  // Determine whether any line item on this job has no template (= custom job)
  const loadIsCustom = useCallback(async () => {
    const { data } = await supabase
      .from("job_line_items")
      .select("product_template_id")
      .eq("job_id", jobId);
    const rows = (data || []) as unknown as { product_template_id: string | null }[];
    setIsCustomJob(rows.length > 0 && rows.some((r) => r.product_template_id === null));
  }, [supabase, jobId]);

  // Load inventory options for the add-item dropdowns
  const loadOptions = useCallback(async () => {
    const [matsRes, partsRes] = await Promise.all([
      supabase.from("raw_materials").select("id, shape, size, wall_thickness, grade").eq("is_active", true).order("shape").order("size"),
      supabase.from("purchased_parts").select("id, name, part_number").eq("is_active", true).order("name"),
    ]);
    setAllMaterials((matsRes.data || []) as unknown as RawMaterialOption[]);
    setAllParts((partsRes.data || []) as unknown as PartOption[]);
  }, [supabase]);

  useEffect(() => {
    loadCompanyId();
    loadItems();
    loadIsCustom();
    loadOptions();
  }, [loadCompanyId, loadItems, loadIsCustom, loadOptions]);

  function openEdit(item: PickListItem) {
    setEditingId(item.id);
    setEditValues({
      planned_quantity: String(item.planned_quantity),
      actual_quantity: String(item.actual_quantity),
      notes: item.notes || "",
    });
  }

  async function saveEdit(itemId: string) {
    const qty = parseFloat(editValues.planned_quantity);
    if (isNaN(qty) || qty < 0) {
      alert("Planned quantity must be 0 or more.");
      return;
    }
    const actualQty = parseFloat(editValues.actual_quantity);
    if (isNaN(actualQty) || actualQty < 0) {
      alert("Actual quantity must be 0 or more.");
      return;
    }
    const { error } = await supabase
      .from("job_pick_list_items")
      .update({
        planned_quantity: qty,
        actual_quantity: actualQty,
        notes: editValues.notes.trim() || null,
      })
      .eq("id", itemId);
    if (error) {
      alert("Failed to save: " + error.message);
      return;
    }
    setEditingId(null);
    loadItems();
  }

  async function handleDelete(item: PickListItem) {
    if (!confirm("Remove this item from the pick list?")) return;
    const { error } = await supabase.from("job_pick_list_items").delete().eq("id", item.id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    loadItems();
  }

  function openAdd() {
    setAddForm({ mode: "inventory", item_type: "raw_material", item_id: "", planned_quantity: "", notes: "", custom_category: "material", custom_name: "", custom_unit_cost: "" });
    setAdding(true);
  }

  async function saveAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId) {
      alert("Could not determine your company. Try refreshing the page.");
      return;
    }

    if (addForm.mode === "custom") {
      const name = addForm.custom_name.trim();
      if (!name) {
        alert("Enter a name for the one-off item.");
        return;
      }
      const unitCost = parseFloat(addForm.custom_unit_cost);
      if (isNaN(unitCost) || unitCost < 0) {
        alert("Enter a cost of 0 or more.");
        return;
      }
      const cq = parseFloat(addForm.planned_quantity);
      if (isNaN(cq) || cq <= 0) {
        alert("Enter a quantity greater than 0.");
        return;
      }
      setSavingAdd(true);
      const { error: cErr } = await supabase.from("job_pick_list_items").insert({
        company_id: companyId,
        job_id: jobId,
        item_type: "custom",
        is_custom: true,
        raw_material_id: null,
        purchased_part_id: null,
        product_template_id: null,
        custom_name: name,
        custom_category: addForm.custom_category,
        custom_unit_cost: unitCost,
        planned_quantity: cq,
        actual_quantity: cq,
        unit: "ea",
        notes: addForm.notes.trim() || null,
      });
      setSavingAdd(false);
      if (cErr) {
        alert("Failed to add item: " + cErr.message);
        return;
      }
      setAdding(false);
      loadItems();
      return;
    }

    if (!addForm.item_id) {
      alert(addForm.item_type === "raw_material" ? "Pick a material to add." : "Pick a part to add.");
      return;
    }
    const qty = parseFloat(addForm.planned_quantity);
    if (isNaN(qty) || qty <= 0) {
      alert("Enter a planned quantity greater than 0.");
      return;
    }

    setSavingAdd(true);
    const isRaw = addForm.item_type === "raw_material";
    const { error } = await supabase.from("job_pick_list_items").insert({
      company_id: companyId,
      job_id: jobId,
      item_type: addForm.item_type,
      raw_material_id: isRaw ? addForm.item_id : null,
      purchased_part_id: isRaw ? null : addForm.item_id,
      planned_quantity: qty,
      // Materials get their actual from the cutting nest; added parts default
      // to "all used".
      actual_quantity: isRaw ? 0 : qty,
      unit: isRaw ? "ft" : "ea",
      notes: addForm.notes.trim() || null,
    });
    setSavingAdd(false);
    if (error) {
      alert("Failed to add item: " + error.message);
      return;
    }
    setAdding(false);
    loadItems();
  }

  async function regeneratePickList() {
    if (!companyId) {
      alert("Could not determine your company. Try refreshing the page.");
      return;
    }
    const ok = confirm(
      "Regenerate the pick list from the current product templates? This will delete the existing pick list (including any edits you've made) and rebuild it from scratch."
    );
    if (!ok) return;

    setRegenerating(true);

    // Get all line items for this job
    const { data: lineItems, error: liError } = await supabase
      .from("job_line_items")
      .select("id, product_template_id, quantity")
      .eq("job_id", jobId);

    if (liError || !lineItems) {
      alert("Failed to load line items: " + (liError?.message || "Unknown error"));
      setRegenerating(false);
      return;
    }

    // Delete existing pick list
    const { error: delError } = await supabase
      .from("job_pick_list_items")
      .delete()
      .eq("job_id", jobId);

    if (delError) {
      alert("Failed to clear existing pick list: " + delError.message);
      setRegenerating(false);
      return;
    }

    // Recursively expand all template ids (top-level + sub-assemblies)
    const allTemplateIds = new Set<string>();
    const queue = [...new Set(lineItems.map((li) => li.product_template_id).filter((id): id is string => id !== null))];
    while (queue.length > 0) {
      const tid = queue.shift()!;
      if (allTemplateIds.has(tid)) continue;
      allTemplateIds.add(tid);
      const { data: subData } = await supabase
        .from("product_template_sub_assemblies")
        .select("child_template_id")
        .eq("parent_template_id", tid);
      if (subData) {
        for (const row of subData) {
          if (!allTemplateIds.has(row.child_template_id)) {
            queue.push(row.child_template_id);
          }
        }
      }
    }

    const templateIdArr = Array.from(allTemplateIds);

    // Fetch all materials, parts, sub-assembly links, and the stockable flag
    const [matsRes, partsRes, subLinksRes, stockRes] = await Promise.all([
      supabase
        .from("product_template_materials")
        .select("product_template_id, feet_per_unit, raw_materials(id)")
        .in("product_template_id", templateIdArr),
      supabase
        .from("product_template_parts")
        .select("product_template_id, quantity_per_unit, purchased_parts(id)")
        .in("product_template_id", templateIdArr),
      supabase
        .from("product_template_sub_assemblies")
        .select("parent_template_id, child_template_id, quantity_per_unit")
        .in("parent_template_id", templateIdArr),
      supabase
        .from("product_templates")
        .select("id, is_stockable")
        .in("id", templateIdArr),
    ]);

    type MatRow = {
      product_template_id: string;
      feet_per_unit: number;
      raw_materials: { id: string } | null;
    };
    type PartRow = {
      product_template_id: string;
      quantity_per_unit: number;
      purchased_parts: { id: string } | null;
    };
    type SubLinkRow = {
      parent_template_id: string;
      child_template_id: string;
      quantity_per_unit: number;
    };

    const tplMaterials = (matsRes.data || []) as unknown as MatRow[];
    const tplParts = (partsRes.data || []) as unknown as PartRow[];
    const tplSubs = (subLinksRes.data || []) as unknown as SubLinkRow[];
    const stockableIds = new Set<string>(
      ((stockRes.data || []) as unknown as { id: string; is_stockable: boolean | null }[])
        .filter((t) => t.is_stockable)
        .map((t) => t.id)
    );

    // Calculate total quantity needed of each template. Stockable sub-assemblies
    // are pulled from fabricated stock, so we stop recursion at a stockable child
    // and record how many finished units to pull instead.
    const templateQtyTotals = new Map<string, number>();
    const fabricatedQtyTotals = new Map<string, number>();
    function expandTemplate(templateId: string, multiplier: number) {
      templateQtyTotals.set(templateId, (templateQtyTotals.get(templateId) || 0) + multiplier);
      const childLinks = tplSubs.filter((s) => s.parent_template_id === templateId);
      for (const link of childLinks) {
        const childQty = multiplier * Number(link.quantity_per_unit);
        if (stockableIds.has(link.child_template_id)) {
          fabricatedQtyTotals.set(
            link.child_template_id,
            (fabricatedQtyTotals.get(link.child_template_id) || 0) + childQty
          );
        } else {
          expandTemplate(link.child_template_id, childQty);
        }
      }
    }
    for (const li of lineItems) {
      if (li.product_template_id) expandTemplate(li.product_template_id, Number(li.quantity));
    }

    // Aggregate materials and parts
    const matMap = new Map<string, number>();
    const partMap = new Map<string, number>();
    for (const [tid, totalQty] of templateQtyTotals.entries()) {
      for (const m of tplMaterials.filter((x) => x.product_template_id === tid)) {
        if (!m.raw_materials) continue;
        const total = Number(m.feet_per_unit) * totalQty;
        matMap.set(m.raw_materials.id, (matMap.get(m.raw_materials.id) || 0) + total);
      }
      for (const p of tplParts.filter((x) => x.product_template_id === tid)) {
        if (!p.purchased_parts) continue;
        const total = Number(p.quantity_per_unit) * totalQty;
        partMap.set(p.purchased_parts.id, (partMap.get(p.purchased_parts.id) || 0) + total);
      }
    }

    // Insert new pick list rows
    const rows = [
      ...Array.from(matMap.entries()).map(([rmId, qty]) => ({
        company_id: companyId,
        job_id: jobId,
        item_type: "raw_material" as const,
        raw_material_id: rmId,
        purchased_part_id: null,
        product_template_id: null,
        planned_quantity: qty,
        actual_quantity: 0,
        unit: "ft",
        notes: null,
      })),
      ...Array.from(partMap.entries()).map(([ppId, qty]) => ({
        company_id: companyId,
        job_id: jobId,
        item_type: "purchased_part" as const,
        raw_material_id: null,
        purchased_part_id: ppId,
        product_template_id: null,
        planned_quantity: qty,
        actual_quantity: qty,
        unit: "ea",
        notes: null,
      })),
      ...Array.from(fabricatedQtyTotals.entries()).map(([templateId, qty]) => ({
        company_id: companyId,
        job_id: jobId,
        item_type: "fabricated" as const,
        raw_material_id: null,
        purchased_part_id: null,
        product_template_id: templateId,
        planned_quantity: qty,
        actual_quantity: qty,
        unit: "ea",
        notes: null,
      })),
    ];

    if (rows.length > 0) {
      const { error: insError } = await supabase.from("job_pick_list_items").insert(rows);
      if (insError) {
        alert("Failed to insert new pick list: " + insError.message);
        setRegenerating(false);
        return;
      }
    }

    setRegenerating(false);
    loadItems();
  }

  const totalPlannedCost = items.reduce((sum, i) => sum + Number(i.planned_quantity) * itemCostPerUnit(i), 0);
  const totalActualCost = items.reduce((sum, i) => sum + Number(i.actual_quantity) * itemCostPerUnit(i), 0);
  const rawMaterialItems = items.filter((i) => i.item_type === "raw_material");
  const partItems = items.filter((i) => i.item_type === "purchased_part");
  const fabricatedItems = items.filter((i) => i.item_type === "fabricated");
  const customItems = items.filter((i) => i.item_type === "custom");

  if (loading) return <p className="text-gray-600">Loading...</p>;

  return (
    <div className="space-y-6">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <p className="text-sm text-gray-600">
        {isCustomJob
          ? "Add the materials and parts this custom job needs. For raw materials, Actual reflects net consumed from the cutting nest (sticks pulled minus drops saved)."
          : "Planned comes from the product templates. For raw materials, Actual reflects net consumed from the cutting nest (sticks pulled minus drops saved)."}
      </p>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1">
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Planned material cost</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">${totalPlannedCost.toFixed(2)}</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Actual material cost (so far)</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">${totalActualCost.toFixed(2)}</div>
          </div>
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <button
              onClick={openAdd}
              className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              + Add item
            </button>
            {!isCustomJob && (
              <button
                onClick={regeneratePickList}
                disabled={regenerating}
                className="px-3 py-2 text-sm border border-gray-300 rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
                title="Rebuild the pick list from the current product templates (includes sub-assemblies)"
              >
                {regenerating ? "Regenerating..." : "Regenerate pick list"}
              </button>
            )}
          </div>
        )}
      </div>

      {adding && !readOnly && (
        <form onSubmit={saveAdd} className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <h4 className="text-sm font-semibold text-gray-900">Add an item to the pick list</h4>

          {isCustomJob && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
              <select
                value={addForm.mode}
                onChange={(e) => setAddForm({ ...addForm, mode: e.target.value as "inventory" | "custom" })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="inventory">From inventory</option>
                <option value="custom">One-off cost (not from inventory)</option>
              </select>
            </div>
          )}

          {addForm.mode === "inventory" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select
                  value={addForm.item_type}
                  onChange={(e) => setAddForm({ ...addForm, item_type: e.target.value as "raw_material" | "purchased_part", item_id: "" })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="raw_material">Raw material</option>
                  <option value="purchased_part">Purchased part</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {addForm.item_type === "raw_material" ? "Material" : "Part"}
                </label>
                <select
                  value={addForm.item_id}
                  onChange={(e) => setAddForm({ ...addForm, item_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">-- Select --</option>
                  {addForm.item_type === "raw_material"
                    ? allMaterials.map((m) => <option key={m.id} value={m.id}>{describeMaterialOption(m)}</option>)
                    : allParts.map((p) => <option key={p.id} value={p.id}>{p.name}{p.part_number ? " (" + p.part_number + ")" : ""}</option>)}
                </select>
              </div>
            </div>
          )}

          {addForm.mode === "custom" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={addForm.custom_category}
                  onChange={(e) => setAddForm({ ...addForm, custom_category: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {CUSTOM_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input
                  type="text"
                  value={addForm.custom_name}
                  onChange={(e) => setAddForm({ ...addForm, custom_name: e.target.value })}
                  placeholder="e.g. Powdercoat - black, 2 gates"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {addForm.mode === "custom" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cost each ($)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={addForm.custom_unit_cost}
                  onChange={(e) => setAddForm({ ...addForm, custom_unit_cost: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {addForm.mode === "custom" ? "Quantity" : "Planned quantity " + (addForm.item_type === "raw_material" ? "(ft)" : "(ea)")}
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={addForm.planned_quantity}
                onChange={(e) => setAddForm({ ...addForm, planned_quantity: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <input
                type="text"
                value={addForm.notes}
                onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
            <button type="submit" disabled={savingAdd} className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-md text-sm font-medium disabled:opacity-50">
              {savingAdd ? "Adding..." : "Add to pick list"}
            </button>
          </div>
        </form>
      )}

      <PickListSection title="Raw Materials" items={rawMaterialItems} editingId={editingId} editValues={editValues} setEditValues={setEditValues} openEdit={openEdit} saveEdit={saveEdit} closeEdit={() => setEditingId(null)} handleDelete={handleDelete} readOnly={readOnly} />
      <PickListSection title="Purchased Parts" items={partItems} editingId={editingId} editValues={editValues} setEditValues={setEditValues} openEdit={openEdit} saveEdit={saveEdit} closeEdit={() => setEditingId(null)} handleDelete={handleDelete} readOnly={readOnly} />
      {fabricatedItems.length > 0 && (
        <FabricatedPickSection items={fabricatedItems} handleDelete={handleDelete} readOnly={readOnly} />
      )}
      {customItems.length > 0 && (
        <CustomPickSection items={customItems} handleDelete={handleDelete} readOnly={readOnly} onChanged={loadItems} />
      )}
    </div>
  );
}

// Stockable sub-assemblies pulled from fabricated stock. Shown separately from
// the material-cost table — their cost is computed under the "highest cost on
// hand" rule and reported on the Cost tab, not from a catalog price here.
function FabricatedPickSection({
  items,
  handleDelete,
  readOnly,
}: {
  items: PickListItem[];
  handleDelete: (item: PickListItem) => void;
  readOnly: boolean;
}) {
  return (
    <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h3 className="text-base font-semibold text-gray-900">Fabricated Sub-Assemblies</h3>
        <p className="text-xs text-gray-500 mt-0.5">Pulled finished from fabricated stock at release. Cost is on the Cost tab.</p>
      </div>
      <table className="w-full">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Item</th>
            <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Quantity</th>
            <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
            <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-gray-100 last:border-0">
              <td className="px-4 py-3 text-sm text-gray-900">{describePickItem(item)}</td>
              <td className="px-4 py-3 text-sm text-right font-mono text-gray-900">{Number(item.planned_quantity).toFixed(2)} {item.unit}</td>
              <td className="px-4 py-3 text-sm text-gray-700">{item.notes || "-"}</td>
              <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                {readOnly ? (
                  <span className="text-gray-400">-</span>
                ) : (
                  <button onClick={() => handleDelete(item)} className="text-red-600 hover:text-red-800 font-medium">Remove</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CustomPickSection({
  items,
  handleDelete,
  readOnly,
  onChanged,
}: {
  items: PickListItem[];
  handleDelete: (item: PickListItem) => void;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const supabase = createClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [vals, setVals] = useState({ planned_quantity: "", actual_quantity: "", custom_unit_cost: "", notes: "" });
  const [saving, setSaving] = useState(false);

  function openEdit(item: PickListItem) {
    setEditingId(item.id);
    setVals({
      planned_quantity: String(item.planned_quantity),
      actual_quantity: String(item.actual_quantity),
      custom_unit_cost: item.custom_unit_cost != null ? String(item.custom_unit_cost) : "",
      notes: item.notes || "",
    });
  }

  async function save(id: string) {
    const pq = parseFloat(vals.planned_quantity);
    const aq = parseFloat(vals.actual_quantity);
    const uc = parseFloat(vals.custom_unit_cost);
    if (isNaN(pq) || pq < 0) { alert("Quantity must be 0 or more."); return; }
    if (isNaN(aq) || aq < 0) { alert("Actual quantity must be 0 or more."); return; }
    if (isNaN(uc) || uc < 0) { alert("Cost each must be 0 or more."); return; }
    setSaving(true);
    const { error } = await supabase
      .from("job_pick_list_items")
      .update({ planned_quantity: pq, actual_quantity: aq, custom_unit_cost: uc, notes: vals.notes.trim() || null })
      .eq("id", id);
    setSaving(false);
    if (error) { alert("Failed to save: " + error.message); return; }
    setEditingId(null);
    onChanged();
  }

  return (
    <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h3 className="text-base font-semibold text-gray-900">One-off Items</h3>
        <p className="text-xs text-gray-500 mt-0.5">Ad-hoc purchases entered with a manual cost (not from inventory).</p>
      </div>
      <table className="w-full">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Category</th>
            <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Item</th>
            <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Planned</th>
            <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actual</th>
            <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$/unit</th>
            <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Planned $</th>
            <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
            <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isEditing = editingId === item.id;
            const cost = Number(item.custom_unit_cost || 0);
            const plannedCost = Number(item.planned_quantity) * cost;
            return (
              <tr key={item.id} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-3 text-sm text-gray-700">{customCategoryLabel(item.custom_category)}</td>
                <td className="px-4 py-3 text-sm text-gray-900">{item.custom_name || "One-off item"}</td>
                <td className="px-4 py-3 text-sm text-right font-mono">
                  {isEditing ? (
                    <input type="number" step="0.01" min="0" value={vals.planned_quantity} onChange={(e) => setVals({ ...vals, planned_quantity: e.target.value })} className="w-20 px-2 py-1 border border-gray-300 rounded text-right text-gray-900" />
                  ) : (
                    <span className="text-gray-900">{Number(item.planned_quantity).toFixed(2)} {item.unit}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-right font-mono">
                  {isEditing ? (
                    <input type="number" step="0.01" min="0" value={vals.actual_quantity} onChange={(e) => setVals({ ...vals, actual_quantity: e.target.value })} className="w-20 px-2 py-1 border border-gray-300 rounded text-right text-gray-900" />
                  ) : (
                    <span className="text-gray-700">{Number(item.actual_quantity).toFixed(2)} {item.unit}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-right font-mono text-gray-700">
                  {isEditing ? (
                    <input type="number" step="0.01" min="0" value={vals.custom_unit_cost} onChange={(e) => setVals({ ...vals, custom_unit_cost: e.target.value })} className="w-24 px-2 py-1 border border-gray-300 rounded text-right text-gray-900" />
                  ) : (
                    "$" + cost.toFixed(2)
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-right font-mono text-gray-900">${plannedCost.toFixed(2)}</td>
                <td className="px-4 py-3 text-sm text-gray-700">
                  {isEditing ? (
                    <input type="text" value={vals.notes} onChange={(e) => setVals({ ...vals, notes: e.target.value })} className="w-full px-2 py-1 border border-gray-300 rounded text-gray-900" />
                  ) : (
                    item.notes || "-"
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                  {readOnly ? (
                    <span className="text-gray-400">-</span>
                  ) : isEditing ? (
                    <>
                      <button onClick={() => save(item.id)} disabled={saving} className="text-blue-600 hover:text-blue-800 font-medium mr-3 disabled:opacity-50">Save</button>
                      <button onClick={() => setEditingId(null)} className="text-gray-600 hover:text-gray-900 font-medium">Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => openEdit(item)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Edit</button>
                      <button onClick={() => handleDelete(item)} className="text-red-600 hover:text-red-800 font-medium">Remove</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function PickListSection({
  title,
  items,
  editingId,
  editValues,
  setEditValues,
  openEdit,
  saveEdit,
  closeEdit,
  handleDelete,
  readOnly,
}: {
  title: string;
  items: PickListItem[];
  editingId: string | null;
  editValues: { planned_quantity: string; actual_quantity: string; notes: string };
  setEditValues: (v: { planned_quantity: string; actual_quantity: string; notes: string }) => void;
  openEdit: (item: PickListItem) => void;
  saveEdit: (id: string) => void;
  closeEdit: () => void;
  handleDelete: (item: PickListItem) => void;
  readOnly: boolean;
}) {
  return (
    <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-600">No items in this category.</p>
      ) : (
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Item</th>
              <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Planned</th>
              <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actual</th>
              <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$/unit</th>
              <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Planned $</th>
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
              <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const cost = itemCostPerUnit(item);
              const plannedCost = Number(item.planned_quantity) * cost;
              const isEditing = editingId === item.id;
              return (
                <tr key={item.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm text-gray-900">{describePickItem(item)}</td>
                  <td className="px-4 py-3 text-sm text-right font-mono">
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editValues.planned_quantity}
                        onChange={(e) => setEditValues({ ...editValues, planned_quantity: e.target.value })}
                        className="w-20 px-2 py-1 border border-gray-300 rounded text-right text-gray-900"
                      />
                    ) : (
                      <span className="text-gray-900">{Number(item.planned_quantity).toFixed(2)} {item.unit}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-mono">
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editValues.actual_quantity}
                        onChange={(e) => setEditValues({ ...editValues, actual_quantity: e.target.value })}
                        className="w-20 px-2 py-1 border border-gray-300 rounded text-right text-gray-900"
                      />
                    ) : (
                      <span className="text-gray-700">{Number(item.actual_quantity).toFixed(2)} {item.unit}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-mono text-gray-700">${cost.toFixed(4)}</td>
                  <td className="px-4 py-3 text-sm text-right font-mono text-gray-900">${plannedCost.toFixed(2)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editValues.notes}
                        onChange={(e) => setEditValues({ ...editValues, notes: e.target.value })}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-gray-900"
                      />
                    ) : (
                      item.notes || "-"
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                    {readOnly ? (
                      <span className="text-gray-400">-</span>
                    ) : isEditing ? (
                      <>
                        <button onClick={() => saveEdit(item.id)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Save</button>
                        <button onClick={closeEdit} className="text-gray-600 hover:text-gray-900 font-medium">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => openEdit(item)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Edit</button>
                        <button onClick={() => handleDelete(item)} className="text-red-600 hover:text-red-800 font-medium">Remove</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}