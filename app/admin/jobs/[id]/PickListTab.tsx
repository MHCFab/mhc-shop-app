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
    loadItems();
  }, [loadItems]);

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

  const totalPlannedCost = items.reduce((sum, i) => sum + Number(i.planned_quantity) * itemCostPerUnit(i), 0);
  const totalActualCost = items.reduce((sum, i) => sum + Number(i.actual_quantity) * itemCostPerUnit(i), 0);
  const rawMaterialItems = items.filter((i) => i.item_type === "raw_material");
  const partItems = items.filter((i) => i.item_type === "purchased_part");

  if (loading) return <p className="text-gray-600">Loading...</p>;

  return (
    <div className="space-y-6">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Planned material cost</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${totalPlannedCost.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Actual material cost (so far)</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${totalActualCost.toFixed(2)}</div>
        </div>
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