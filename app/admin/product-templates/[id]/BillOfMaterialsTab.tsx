"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";

const SHAPES = [
  { value: "round_tube", label: "Round Tube" },
  { value: "square_tube", label: "Square Tube" },
  { value: "rectangle_tube", label: "Rectangle Tube" },
  { value: "channel", label: "Channel" },
  { value: "i_beam", label: "I-Beam" },
  { value: "angle", label: "Angle" },
] as const;

type Shape = (typeof SHAPES)[number]["value"];

type RawMaterial = {
  id: string;
  shape: Shape;
  size: string;
  wall_thickness: string | null;
  grade: string;
  current_cost_per_foot: number;
};

type PurchasedPart = {
  id: string;
  name: string;
  part_number: string | null;
  current_cost_each: number;
};

type Template = {
  id: string;
  name: string;
  product_number: string | null;
};

type MaterialRow = {
  id: string;
  raw_material_id: string;
  feet_per_unit: number;
  notes: string | null;
  raw_materials: RawMaterial | null;
};

type PartRow = {
  id: string;
  purchased_part_id: string;
  quantity_per_unit: number;
  notes: string | null;
  purchased_parts: PurchasedPart | null;
};

type SubRow = {
  id: string;
  child_template_id: string;
  quantity_per_unit: number;
  notes: string | null;
  product_templates: Template | null;
};

function shapeLabel(s: Shape) {
  return SHAPES.find((x) => x.value === s)?.label || s;
}

function describeMaterial(m: RawMaterial | null) {
  if (!m) return "Unknown material";
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return shapeLabel(m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

export default function BillOfMaterialsTab({ templateId }: { templateId: string }) {
  const supabase = createClient();
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [parts, setParts] = useState<PartRow[]>([]);
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [subAssemblyCosts, setSubAssemblyCosts] = useState<Record<string, number>>({});
  const [allMaterials, setAllMaterials] = useState<RawMaterial[]>([]);
  const [allParts, setAllParts] = useState<PurchasedPart[]>([]);
  const [allTemplates, setAllTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState<string | null>(null);

  const [addingMat, setAddingMat] = useState(false);
  const [addingPart, setAddingPart] = useState(false);
  const [addingSub, setAddingSub] = useState(false);

  const [matForm, setMatForm] = useState({ raw_material_id: "", feet_per_unit: "", notes: "" });
  const [partForm, setPartForm] = useState({ purchased_part_id: "", quantity_per_unit: "", notes: "" });
  const [subForm, setSubForm] = useState({ child_template_id: "", quantity_per_unit: "", notes: "" });

  const [error, setError] = useState<string | null>(null);

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [matsRes, partsRes, subsRes, allMatsRes, allPartsRes, allTplRes] = await Promise.all([
      supabase
        .from("product_template_materials")
        .select("*, raw_materials(id, shape, size, wall_thickness, grade, current_cost_per_foot)")
        .eq("product_template_id", templateId)
        .order("sort_order"),
      supabase
        .from("product_template_parts")
        .select("*, purchased_parts(id, name, part_number, current_cost_each)")
        .eq("product_template_id", templateId)
        .order("sort_order"),
      supabase
        .from("product_template_sub_assemblies")
        .select("*, product_templates!product_template_sub_assemblies_child_template_id_fkey(id, name, product_number)")
        .eq("parent_template_id", templateId)
        .order("sort_order"),
      supabase
        .from("raw_materials")
        .select("id, shape, size, wall_thickness, grade, current_cost_per_foot")
        .eq("is_active", true)
        .order("shape")
        .order("size"),
      supabase
        .from("purchased_parts")
        .select("id, name, part_number, current_cost_each")
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("product_templates")
        .select("id, name, product_number")
        .eq("is_active", true)
        .neq("id", templateId)
        .order("name"),
    ]);

    const subRows = (subsRes.data || []) as SubRow[];

    // For each sub-assembly, calculate its per-unit cost by summing its own materials and parts
    const subTemplateIds = Array.from(new Set(subRows.map((s) => s.child_template_id)));
    const subCosts: Record<string, number> = {};

    if (subTemplateIds.length > 0) {
      const [subMatsRes, subPartsRes] = await Promise.all([
        supabase
          .from("product_template_materials")
          .select("product_template_id, feet_per_unit, raw_materials(current_cost_per_foot)")
          .in("product_template_id", subTemplateIds),
        supabase
          .from("product_template_parts")
          .select("product_template_id, quantity_per_unit, purchased_parts(current_cost_each)")
          .in("product_template_id", subTemplateIds),
      ]);

      type SubMatRow = {
        product_template_id: string;
        feet_per_unit: number;
        raw_materials: { current_cost_per_foot: number } | null;
      };
      type SubPartRow = {
        product_template_id: string;
        quantity_per_unit: number;
        purchased_parts: { current_cost_each: number } | null;
      };

      const subMats = (subMatsRes.data || []) as SubMatRow[];
      const subParts = (subPartsRes.data || []) as SubPartRow[];

      for (const id of subTemplateIds) {
        const matCost = subMats
          .filter((m) => m.product_template_id === id)
          .reduce((sum, m) => sum + Number(m.feet_per_unit) * Number(m.raw_materials?.current_cost_per_foot || 0), 0);
        const partCost = subParts
          .filter((p) => p.product_template_id === id)
          .reduce((sum, p) => sum + Number(p.quantity_per_unit) * Number(p.purchased_parts?.current_cost_each || 0), 0);
        subCosts[id] = matCost + partCost;
      }
    }

    setMaterials((matsRes.data || []) as MaterialRow[]);
    setParts((partsRes.data || []) as PartRow[]);
    setSubs(subRows);
    setSubAssemblyCosts(subCosts);
    setAllMaterials((allMatsRes.data || []) as RawMaterial[]);
    setAllParts((allPartsRes.data || []) as PurchasedPart[]);
    setAllTemplates((allTplRes.data || []) as Template[]);
    setLoading(false);
  }, [supabase, templateId]);

  useEffect(() => {
    loadCompanyId();
    loadAll();
  }, [loadCompanyId, loadAll]);

  async function addMaterial(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) return;
    const feet = parseFloat(matForm.feet_per_unit);
    if (!matForm.raw_material_id || isNaN(feet) || feet <= 0) {
      setError("Please select a material and enter feet per unit greater than 0.");
      return;
    }
    const { error } = await supabase.from("product_template_materials").insert({
      company_id: companyId,
      product_template_id: templateId,
      raw_material_id: matForm.raw_material_id,
      feet_per_unit: feet,
      notes: matForm.notes.trim() || null,
      sort_order: materials.length,
    });
    if (error) {
      setError(error.message);
      return;
    }
    setMatForm({ raw_material_id: "", feet_per_unit: "", notes: "" });
    setAddingMat(false);
    loadAll();
  }

  async function addPart(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) return;
    const qty = parseFloat(partForm.quantity_per_unit);
    if (!partForm.purchased_part_id || isNaN(qty) || qty <= 0) {
      setError("Please select a part and enter quantity per unit greater than 0.");
      return;
    }
    const { error } = await supabase.from("product_template_parts").insert({
      company_id: companyId,
      product_template_id: templateId,
      purchased_part_id: partForm.purchased_part_id,
      quantity_per_unit: qty,
      notes: partForm.notes.trim() || null,
      sort_order: parts.length,
    });
    if (error) {
      setError(error.message);
      return;
    }
    setPartForm({ purchased_part_id: "", quantity_per_unit: "", notes: "" });
    setAddingPart(false);
    loadAll();
  }

  async function addSub(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) return;
    const qty = parseFloat(subForm.quantity_per_unit);
    if (!subForm.child_template_id || isNaN(qty) || qty <= 0) {
      setError("Please select a sub-assembly and enter quantity per unit greater than 0.");
      return;
    }
    const { error } = await supabase.from("product_template_sub_assemblies").insert({
      company_id: companyId,
      parent_template_id: templateId,
      child_template_id: subForm.child_template_id,
      quantity_per_unit: qty,
      notes: subForm.notes.trim() || null,
      sort_order: subs.length,
    });
    if (error) {
      setError(error.message);
      return;
    }
    setSubForm({ child_template_id: "", quantity_per_unit: "", notes: "" });
    setAddingSub(false);
    loadAll();
  }

  async function deleteMaterial(rowId: string) {
    if (!confirm("Remove this material from the BOM?")) return;
    await supabase.from("product_template_materials").delete().eq("id", rowId);
    loadAll();
  }

  async function deletePart(rowId: string) {
    if (!confirm("Remove this part from the BOM?")) return;
    await supabase.from("product_template_parts").delete().eq("id", rowId);
    loadAll();
  }

  async function deleteSub(rowId: string) {
    if (!confirm("Remove this sub-assembly from the BOM?")) return;
    await supabase.from("product_template_sub_assemblies").delete().eq("id", rowId);
    loadAll();
  }

  const materialCost = materials.reduce(
    (sum, m) => sum + Number(m.feet_per_unit) * Number(m.raw_materials?.current_cost_per_foot || 0),
    0
  );
  const partCost = parts.reduce(
    (sum, p) => sum + Number(p.quantity_per_unit) * Number(p.purchased_parts?.current_cost_each || 0),
    0
  );
  const subAssemblyCost = subs.reduce(
    (sum, s) => sum + Number(s.quantity_per_unit) * (subAssemblyCosts[s.child_template_id] || 0),
    0
  );

  if (loading) {
    return <p className="text-gray-600">Loading...</p>;
  }

  return (
    <div className="space-y-8">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Material cost</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${materialCost.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Parts cost</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${partCost.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Sub-assemblies</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${subAssemblyCost.toFixed(2)}</div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-blue-700 font-medium">Total cost per unit</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${(materialCost + partCost + subAssemblyCost).toFixed(2)}</div>
          <div className="text-xs text-gray-500 mt-1">Labor not included</div>
        </div>
      </div>

      <BomSection
        title="Raw Materials"
        emptyText="No raw materials added yet."
        adding={addingMat}
        onOpenAdd={() => setAddingMat(true)}
        onCloseAdd={() => setAddingMat(false)}
      >
        {materials.length > 0 && (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Material</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Feet / unit</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / ft</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / unit</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => {
                const cf = Number(m.raw_materials?.current_cost_per_foot || 0);
                const unitCost = Number(m.feet_per_unit) * cf;
                return (
                  <tr key={m.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-900">{describeMaterial(m.raw_materials)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(m.feet_per_unit).toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${cf.toFixed(4)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${unitCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{m.notes || "-"}</td>
                    <td className="px-4 py-3 text-sm text-right">
                      <button onClick={() => deleteMaterial(m.id)} className="text-red-600 hover:text-red-800 font-medium">Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {addingMat && (
          <form onSubmit={addMaterial} className="p-4 bg-gray-50 border-t border-gray-200 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Material</label>
              <select
                value={matForm.raw_material_id}
                onChange={(e) => setMatForm({ ...matForm, raw_material_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">-- Select material --</option>
                {allMaterials.map((m) => (
                  <option key={m.id} value={m.id}>{describeMaterial(m)}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Feet per unit</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 8"
                  value={matForm.feet_per_unit}
                  onChange={(e) => setMatForm({ ...matForm, feet_per_unit: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input
                  type="text"
                  value={matForm.notes}
                  onChange={(e) => setMatForm({ ...matForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAddingMat(false)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
              <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-md text-sm font-medium">Add</button>
            </div>
          </form>
        )}
      </BomSection>

      <BomSection
        title="Purchased Parts"
        emptyText="No purchased parts added yet."
        adding={addingPart}
        onOpenAdd={() => setAddingPart(true)}
        onCloseAdd={() => setAddingPart(false)}
      >
        {parts.length > 0 && (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Part</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Qty / unit</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ each</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / unit</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => {
                const ce = Number(p.purchased_parts?.current_cost_each || 0);
                const unitCost = Number(p.quantity_per_unit) * ce;
                return (
                  <tr key={p.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-900">{p.purchased_parts?.name || "Unknown"}{p.purchased_parts?.part_number ? " (" + p.purchased_parts.part_number + ")" : ""}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(p.quantity_per_unit).toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${ce.toFixed(4)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${unitCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{p.notes || "-"}</td>
                    <td className="px-4 py-3 text-sm text-right">
                      <button onClick={() => deletePart(p.id)} className="text-red-600 hover:text-red-800 font-medium">Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {addingPart && (
          <form onSubmit={addPart} className="p-4 bg-gray-50 border-t border-gray-200 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Part</label>
              <select
                value={partForm.purchased_part_id}
                onChange={(e) => setPartForm({ ...partForm, purchased_part_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">-- Select part --</option>
                {allParts.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.part_number ? " (" + p.part_number + ")" : ""}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantity per unit</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 4"
                  value={partForm.quantity_per_unit}
                  onChange={(e) => setPartForm({ ...partForm, quantity_per_unit: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input
                  type="text"
                  value={partForm.notes}
                  onChange={(e) => setPartForm({ ...partForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAddingPart(false)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
              <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-md text-sm font-medium">Add</button>
            </div>
          </form>
        )}
      </BomSection>

      <BomSection
        title="Sub-Assemblies"
        emptyText="No sub-assemblies added yet."
        adding={addingSub}
        onOpenAdd={() => setAddingSub(true)}
        onCloseAdd={() => setAddingSub(false)}
      >
        {subs.length > 0 && (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Sub-assembly</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Qty / unit</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / sub</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / unit</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => {
                const costPerSub = subAssemblyCosts[s.child_template_id] || 0;
                const unitCost = Number(s.quantity_per_unit) * costPerSub;
                return (
                  <tr key={s.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-900">{s.product_templates?.name || "Unknown"}{s.product_templates?.product_number ? " (" + s.product_templates.product_number + ")" : ""}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(s.quantity_per_unit).toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${costPerSub.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${unitCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{s.notes || "-"}</td>
                    <td className="px-4 py-3 text-sm text-right">
                      <button onClick={() => deleteSub(s.id)} className="text-red-600 hover:text-red-800 font-medium">Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {addingSub && (
          <form onSubmit={addSub} className="p-4 bg-gray-50 border-t border-gray-200 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sub-assembly template</label>
              <select
                value={subForm.child_template_id}
                onChange={(e) => setSubForm({ ...subForm, child_template_id: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">-- Select another template --</option>
                {allTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.product_number ? " (" + t.product_number + ")" : ""}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantity per unit</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 1"
                  value={subForm.quantity_per_unit}
                  onChange={(e) => setSubForm({ ...subForm, quantity_per_unit: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input
                  type="text"
                  value={subForm.notes}
                  onChange={(e) => setSubForm({ ...subForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAddingSub(false)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
              <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-md text-sm font-medium">Add</button>
            </div>
          </form>
        )}
      </BomSection>
    </div>
  );
}

function BomSection({
  title,
  emptyText,
  adding,
  onOpenAdd,
  onCloseAdd,
  children,
}: {
  title: string;
  emptyText: string;
  adding: boolean;
  onOpenAdd: () => void;
  onCloseAdd: () => void;
  children: React.ReactNode;
}) {
  const hasContent = Array.isArray(children) ? children.some(Boolean) : Boolean(children);

  return (
    <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        {!adding && (
          <button onClick={onOpenAdd} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ Add</button>
        )}
      </div>
      {hasContent ? children : <p className="px-4 py-6 text-sm text-gray-600">{emptyText}</p>}
      {!hasContent && !adding && (
        <div className="px-4 pb-4">
          <button onClick={onOpenAdd} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ Add the first one</button>
        </div>
      )}
    </section>
  );
}