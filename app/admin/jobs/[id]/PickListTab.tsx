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
};

type PickListItem = {
  id: string;
  item_type: "raw_material" | "purchased_part";
  raw_material_id: string | null;
  purchased_part_id: string | null;
  planned_quantity: number;
  actual_quantity: number;
  unit: string;
  notes: string | null;
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
  return "Unknown item";
}

function itemCostPerUnit(item: PickListItem) {
  if (item.item_type === "raw_material") return Number(item.raw_materials?.current_cost_per_foot || 0);
  return Number(item.purchased_parts?.current_cost_each || 0);
}

export default function PickListTab({ jobId }: { jobId: string }) {
  const supabase = createClient();
  const [items, setItems] = useState<PickListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ planned_quantity: "", notes: "" });
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);

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
      .select("*, raw_materials(shape, size, wall_thickness, grade, current_cost_per_foot), purchased_parts(name, part_number, current_cost_each)")
      .eq("job_id", jobId)
      .order("item_type")
      .order("created_at");
    if (error) setError(error.message);
    else setItems((data || []) as PickListItem[]);
    setLoading(false);
  }, [supabase, jobId]);

  useEffect(() => {
    loadCompanyId();
    loadItems();
  }, [loadCompanyId, loadItems]);

  function openEdit(item: PickListItem) {
    setEditingId(item.id);
    setEditValues({
      planned_quantity: String(item.planned_quantity),
      notes: item.notes || "",
    });
  }

  async function saveEdit(itemId: string) {
    const qty = parseFloat(editValues.planned_quantity);
    if (isNaN(qty) || qty < 0) {
      alert("Planned quantity must be 0 or more.");
      return;
    }
    const { error } = await supabase
      .from("job_pick_list_items")
      .update({
        planned_quantity: qty,
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
    const queue = [...new Set(lineItems.map((li) => li.product_template_id))];
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

    // Fetch all materials, parts, and sub-assembly links
    const [matsRes, partsRes, subLinksRes] = await Promise.all([
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

    const tplMaterials = (matsRes.data || []) as MatRow[];
    const tplParts = (partsRes.data || []) as PartRow[];
    const tplSubs = (subLinksRes.data || []) as SubLinkRow[];

    // Calculate total quantity needed of each template
    const templateQtyTotals = new Map<string, number>();
    function expandTemplate(templateId: string, multiplier: number) {
      templateQtyTotals.set(templateId, (templateQtyTotals.get(templateId) || 0) + multiplier);
      const childLinks = tplSubs.filter((s) => s.parent_template_id === templateId);
      for (const link of childLinks) {
        expandTemplate(link.child_template_id, multiplier * Number(link.quantity_per_unit));
      }
    }
    for (const li of lineItems) {
      expandTemplate(li.product_template_id, Number(li.quantity));
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
        planned_quantity: qty,
        actual_quantity: 0,
        unit: "ft",
        notes: null,
      })),
      ...Array.from(partMap.entries()).map(([ppId, qty]) => ({
        company_id: companyId,
        job_id: jobId,
        item_type: "purchased_part" as const,
        purchased_part_id: ppId,
        raw_material_id: null,
        planned_quantity: qty,
        actual_quantity: 0,
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

  if (loading) return <p className="text-gray-600">Loading...</p>;

  return (
    <div className="space-y-6">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

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
        <button
          onClick={regeneratePickList}
          disabled={regenerating}
          className="px-3 py-2 text-sm border border-gray-300 rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
          title="Rebuild the pick list from the current product templates (includes sub-assemblies)"
        >
          {regenerating ? "Regenerating..." : "Regenerate pick list"}
        </button>
      </div>

      <PickListSection title="Raw Materials" items={rawMaterialItems} editingId={editingId} editValues={editValues} setEditValues={setEditValues} openEdit={openEdit} saveEdit={saveEdit} closeEdit={() => setEditingId(null)} handleDelete={handleDelete} />
      <PickListSection title="Purchased Parts" items={partItems} editingId={editingId} editValues={editValues} setEditValues={setEditValues} openEdit={openEdit} saveEdit={saveEdit} closeEdit={() => setEditingId(null)} handleDelete={handleDelete} />
    </div>
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
}: {
  title: string;
  items: PickListItem[];
  editingId: string | null;
  editValues: { planned_quantity: string; notes: string };
  setEditValues: (v: { planned_quantity: string; notes: string }) => void;
  openEdit: (item: PickListItem) => void;
  saveEdit: (id: string) => void;
  closeEdit: () => void;
  handleDelete: (item: PickListItem) => void;
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
                  <td className="px-4 py-3 text-sm text-right font-mono text-gray-700">
                    {Number(item.actual_quantity).toFixed(2)} {item.unit}
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
                    {isEditing ? (
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