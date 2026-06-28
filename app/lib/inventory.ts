import { createClient } from "./supabase";

const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
  flat_bar: "Flat Bar",
};

// ============================================
// Cost layers — "highest cost still on hand"
// ============================================
// Cost is driven only by purchase/opening layers. Stock leaving (pulls and
// negative adjustments) depletes layers oldest-first; among same-day layers the
// cheaper is consumed first so the higher-cost stock stays longest. Drops and
// positive adjustments add quantity but never set price. The reported cost is the
// highest cost among layers that still have quantity on hand.
export type CostLayer = { date: string; qty: number; cost: number };

export function highestCostOnHand(layers: CostLayer[], totalOut: number, fallback: number): number {
  if (layers.length === 0) return fallback;
  const sorted = [...layers].sort((a, b) => {
    const d = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (d !== 0) return d;
    return a.cost - b.cost; // same day: consume the cheaper layer first
  });
  let out = totalOut;
  let maxCost = 0;
  let anyRemaining = false;
  for (const layer of sorted) {
    let remaining = layer.qty;
    if (out > 0) {
      const used = Math.min(out, remaining);
      remaining -= used;
      out -= used;
    }
    if (remaining > 0.0001) {
      anyRemaining = true;
      if (layer.cost > maxCost) maxCost = layer.cost;
    }
  }
  // If every layer is depleted (e.g. saved drops were re-pulled), fall back to
  // the most recent layer's cost so we never report $0.
  return anyRemaining ? maxCost : sorted[sorted.length - 1].cost;
}

export type AvailableRawMaterial = {
  id: string;
  shape: string;
  size: string;
  wall_thickness: string | null;
  grade: string;
  current_cost_per_foot: number;
  is_active: boolean;
  totalInStock: number;
  allocated: number;
  available: number;
  costPerFoot: number; // highest cost still on hand (see highestCostOnHand)
};

export type AvailablePurchasedPart = {
  id: string;
  name: string;
  part_number: string | null;
  category: string;
  current_cost_each: number;
  is_active: boolean;
  customer_id: string | null;
  customerName: string | null;
  totalInStock: number;
  allocated: number;
  available: number;
  costEach: number; // highest cost still on hand (see highestCostOnHand)
};

// Pull all raw materials with computed in-stock, allocated, and available quantities.
export async function getAvailableRawMaterials(): Promise<AvailableRawMaterial[]> {
  const supabase = createClient();

  const [matsRes, invRes, allocRes] = await Promise.all([
    supabase
      .from("raw_materials")
      .select("id, shape, size, wall_thickness, grade, current_cost_per_foot, is_active")
      .order("shape")
      .order("size"),
    supabase
      .from("raw_material_inventory")
      .select("raw_material_id, stick_length_feet, quantity_sticks, cost_per_foot, purchase_date, entry_type"),
    supabase
      .from("inventory_allocations")
      .select("raw_material_id, allocated_quantity")
      .eq("item_type", "raw_material"),
  ]);

  const mats = matsRes.data || [];
  const inv = invRes.data || [];
  const allocs = allocRes.data || [];

  return mats.map((m) => {
    const batches = inv.filter((b) => b.raw_material_id === m.id);
    const totalInStock = batches.reduce(
      (sum, b) => sum + Number(b.stick_length_feet) * Number(b.quantity_sticks),
      0
    );
    const allocated = allocs
      .filter((a) => a.raw_material_id === m.id)
      .reduce((sum, a) => sum + Number(a.allocated_quantity), 0);

    // Cost layers: feet added by purchases/opening stock; feet removed by pulls
    // and negative adjustments deplete them oldest-first.
    const layers: CostLayer[] = batches
      .filter((b) => (b.entry_type === "purchase" || b.entry_type === "opening") && Number(b.quantity_sticks) > 0)
      .map((b) => ({
        date: b.purchase_date,
        qty: Number(b.stick_length_feet) * Number(b.quantity_sticks),
        cost: Number(b.cost_per_foot),
      }));
    const totalOut = batches.reduce((sum, b) => {
      const feet = Number(b.stick_length_feet) * Number(b.quantity_sticks);
      return feet < 0 ? sum + -feet : sum;
    }, 0);
    const costPerFoot = highestCostOnHand(layers, totalOut, Number(m.current_cost_per_foot));

    return {
      id: m.id,
      shape: m.shape,
      size: m.size,
      wall_thickness: m.wall_thickness,
      grade: m.grade,
      current_cost_per_foot: Number(m.current_cost_per_foot),
      is_active: m.is_active,
      totalInStock,
      allocated,
      available: totalInStock - allocated,
      costPerFoot,
    };
  });
}

export async function getAvailablePurchasedParts(): Promise<AvailablePurchasedPart[]> {
  const supabase = createClient();

  const [partsRes, invRes, allocRes, custRes] = await Promise.all([
    supabase
      .from("purchased_parts")
      .select("id, name, part_number, category, current_cost_each, is_active, customer_id")
      .order("name"),
    supabase
      .from("purchased_parts_inventory")
      .select("purchased_part_id, quantity, cost_each, purchase_date, entry_type"),
    supabase
      .from("inventory_allocations")
      .select("purchased_part_id, allocated_quantity")
      .eq("item_type", "purchased_part"),
    supabase.from("customers").select("id, name"),
  ]);

  const parts = partsRes.data || [];
  const inv = invRes.data || [];
  const allocs = allocRes.data || [];
  const custMap = new Map<string, string>();
  for (const c of custRes.data || []) custMap.set(c.id, c.name);

  return parts.map((p) => {
    const batches = inv.filter((b) => b.purchased_part_id === p.id);
    const totalInStock = batches.reduce((sum, b) => sum + Number(b.quantity), 0);
    const allocated = allocs
      .filter((a) => a.purchased_part_id === p.id)
      .reduce((sum, a) => sum + Number(a.allocated_quantity), 0);

    // Cost layers: purchases/opening add stock; pulls and negative adjustments deplete oldest-first.
    const layers: CostLayer[] = batches
      .filter((b) => (b.entry_type === "purchase" || b.entry_type === "opening") && Number(b.quantity) > 0)
      .map((b) => ({ date: b.purchase_date, qty: Number(b.quantity), cost: Number(b.cost_each) }));
    const totalOut = batches.reduce((sum, b) => {
      const q = Number(b.quantity);
      return q < 0 ? sum + -q : sum;
    }, 0);
    const costEach = highestCostOnHand(layers, totalOut, Number(p.current_cost_each));

    return {
      id: p.id,
      name: p.name,
      part_number: p.part_number,
      category: p.category,
      current_cost_each: Number(p.current_cost_each),
      is_active: p.is_active,
      customer_id: p.customer_id,
      customerName: p.customer_id ? (custMap.get(p.customer_id) || null) : null,
      totalInStock,
      allocated,
      available: totalInStock - allocated,
      costEach,
    };
  });
}

// ============================================
// Fabricated (stockable sub-assembly) stock
// ============================================

export type FabricatedStockItem = {
  id: string;                 // product_template_id
  name: string;
  product_number: string | null;
  is_active: boolean;
  onHand: number;             // running sum of the ledger (signed)
  costPerUnit: number | null; // highest cost still on hand (builds + opening stock)
  reorderPoint: number | null;   // build more when onHand <= this (null = not tracked)
  reorderTarget: number | null;  // build back up to this level
  belowReorder: boolean;         // reorderPoint set and onHand at/below it
  suggestedBuild: number;        // how many to build to reach target (0 if not below)
};

// Each stockable template, with its on-hand quantity (sum of the fabricated_inventory
// ledger) and its unit cost under the "highest cost still on hand" rule: build and
// opening-stock entries are price layers; consumption depletes them oldest-first.
export async function getFabricatedStock(): Promise<FabricatedStockItem[]> {
  const supabase = createClient();

  const [tplRes, ledgerRes] = await Promise.all([
    supabase
      .from("product_templates")
      .select("id, name, product_number, is_active, reorder_point, reorder_target")
      .eq("is_stockable", true)
      .order("name"),
    supabase
      .from("fabricated_inventory")
      .select("product_template_id, quantity, cost_per_unit, source, created_at"),
  ]);

  type TplRow = { id: string; name: string; product_number: string | null; is_active: boolean; reorder_point: number | null; reorder_target: number | null };
  type LedgerRow = { product_template_id: string; quantity: number; cost_per_unit: number; source: string; created_at: string };

  const tpls = (tplRes.data || []) as unknown as TplRow[];
  const ledger = (ledgerRes.data || []) as unknown as LedgerRow[];

  return tpls.map((t) => {
    const rows = ledger.filter((l) => l.product_template_id === t.id);
    const onHand = rows.reduce((s, r) => s + Number(r.quantity), 0);
    const layers: CostLayer[] = rows
      .filter((r) => (r.source === "build" || r.source === "opening") && Number(r.quantity) > 0)
      .map((r) => ({ date: r.created_at, qty: Number(r.quantity), cost: Number(r.cost_per_unit) }));
    const totalOut = rows.reduce((s, r) => {
      const q = Number(r.quantity);
      return q < 0 ? s + -q : s;
    }, 0);
    const reorderPoint = t.reorder_point != null ? Number(t.reorder_point) : null;
    const reorderTarget = t.reorder_target != null ? Number(t.reorder_target) : null;
    const belowReorder = reorderPoint != null && onHand <= reorderPoint;
    // Build back up to the target (or just to the point if no target is set).
    const buildTo = reorderTarget != null ? reorderTarget : reorderPoint;
    const suggestedBuild = belowReorder && buildTo != null ? Math.max(0, buildTo - onHand) : 0;
    return {
      id: t.id,
      name: t.name,
      product_number: t.product_number,
      is_active: t.is_active,
      onHand,
      costPerUnit: layers.length > 0 ? highestCostOnHand(layers, totalOut, 0) : null,
      reorderPoint,
      reorderTarget,
      belowReorder,
      suggestedBuild,
    };
  });
}

// ============================================
// Job stock shortfall (stockout alert)
// ============================================

export type JobStockShortfallItem = {
  itemType: "raw_material" | "purchased_part" | "fabricated";
  id: string;        // raw_material_id, purchased_part_id, or product_template_id
  label: string;     // human-readable description
  unit: string;      // "ft" for materials, "ea" for parts and fabricated units
  required: number;  // how much this job needs (from its pick list)
  available: number; // stock on hand minus what OTHER jobs have claimed
  short: number;     // how much you still need to acquire (required - available, min 0)
};

// Compare a job's pick list against what's actually free in inventory and return
// only the items that are short. "Available" excludes this job's own allocations,
// so the number stays correct whether the job is still 'ordered' or already 'ready'.
export async function getJobStockShortfall(jobId: string): Promise<JobStockShortfallItem[]> {
  const supabase = createClient();

  const [pickRes, rmInvRes, ppInvRes, fabInvRes, allocRes] = await Promise.all([
    supabase
      .from("job_pick_list_items")
      .select("item_type, raw_material_id, purchased_part_id, product_template_id, planned_quantity, unit, raw_materials(shape, size, wall_thickness, grade), purchased_parts(name, part_number), product_templates(name, product_number)")
      .eq("job_id", jobId),
    supabase
      .from("raw_material_inventory")
      .select("raw_material_id, stick_length_feet, quantity_sticks"),
    supabase
      .from("purchased_parts_inventory")
      .select("purchased_part_id, quantity"),
    supabase
      .from("fabricated_inventory")
      .select("product_template_id, quantity"),
    // All allocations EXCEPT this job's own, so we don't count the job against itself
    supabase
      .from("inventory_allocations")
      .select("item_type, raw_material_id, purchased_part_id, product_template_id, allocated_quantity")
      .neq("job_id", jobId),
  ]);

  type PickRow = {
    item_type: string;
    raw_material_id: string | null;
    purchased_part_id: string | null;
    product_template_id: string | null;
    planned_quantity: number;
    unit: string;
    raw_materials: { shape: string; size: string; wall_thickness: string | null; grade: string } | null;
    purchased_parts: { name: string; part_number: string | null } | null;
    product_templates: { name: string; product_number: string | null } | null;
  };
  type RmInvRow = { raw_material_id: string; stick_length_feet: number; quantity_sticks: number };
  type PpInvRow = { purchased_part_id: string; quantity: number };
  type FabInvRow = { product_template_id: string; quantity: number };
  type AllocRow = { item_type: string; raw_material_id: string | null; purchased_part_id: string | null; product_template_id: string | null; allocated_quantity: number };

  const pick = (pickRes.data || []) as unknown as PickRow[];
  const rmInv = (rmInvRes.data || []) as unknown as RmInvRow[];
  const ppInv = (ppInvRes.data || []) as unknown as PpInvRow[];
  const fabInv = (fabInvRes.data || []) as unknown as FabInvRow[];
  const allocs = (allocRes.data || []) as unknown as AllocRow[];

  // Total stock on hand per material / part / fabricated item
  const rmStock = new Map<string, number>();
  for (const b of rmInv) {
    rmStock.set(
      b.raw_material_id,
      (rmStock.get(b.raw_material_id) || 0) + Number(b.stick_length_feet) * Number(b.quantity_sticks)
    );
  }
  const ppStock = new Map<string, number>();
  for (const b of ppInv) {
    ppStock.set(b.purchased_part_id, (ppStock.get(b.purchased_part_id) || 0) + Number(b.quantity));
  }
  const fabStock = new Map<string, number>();
  for (const b of fabInv) {
    fabStock.set(b.product_template_id, (fabStock.get(b.product_template_id) || 0) + Number(b.quantity));
  }

  // What OTHER jobs have already claimed
  const rmAlloc = new Map<string, number>();
  const ppAlloc = new Map<string, number>();
  const fabAlloc = new Map<string, number>();
  for (const a of allocs) {
    if (a.item_type === "raw_material" && a.raw_material_id) {
      rmAlloc.set(a.raw_material_id, (rmAlloc.get(a.raw_material_id) || 0) + Number(a.allocated_quantity));
    } else if (a.item_type === "purchased_part" && a.purchased_part_id) {
      ppAlloc.set(a.purchased_part_id, (ppAlloc.get(a.purchased_part_id) || 0) + Number(a.allocated_quantity));
    } else if (a.item_type === "fabricated" && a.product_template_id) {
      fabAlloc.set(a.product_template_id, (fabAlloc.get(a.product_template_id) || 0) + Number(a.allocated_quantity));
    }
  }

  function describeMaterial(m: { shape: string; size: string; wall_thickness: string | null; grade: string }) {
    const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
    return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
  }

  // Aggregate this job's requirements by item (pick list is normally one row per item,
  // but we sum defensively in case of duplicates)
  const reqMap = new Map<string, JobStockShortfallItem>();
  for (const row of pick) {
    const planned = Number(row.planned_quantity);
    if (!(planned > 0)) continue;

    if (row.item_type === "raw_material" && row.raw_material_id) {
      const key = "rm:" + row.raw_material_id;
      const existing = reqMap.get(key);
      if (existing) {
        existing.required += planned;
      } else {
        reqMap.set(key, {
          itemType: "raw_material",
          id: row.raw_material_id,
          label: row.raw_materials ? describeMaterial(row.raw_materials) : "Material",
          unit: row.unit || "ft",
          required: planned,
          available: 0,
          short: 0,
        });
      }
    } else if (row.item_type === "purchased_part" && row.purchased_part_id) {
      const key = "pp:" + row.purchased_part_id;
      const existing = reqMap.get(key);
      if (existing) {
        existing.required += planned;
      } else {
        reqMap.set(key, {
          itemType: "purchased_part",
          id: row.purchased_part_id,
          label: row.purchased_parts
            ? row.purchased_parts.name + (row.purchased_parts.part_number ? " (" + row.purchased_parts.part_number + ")" : "")
            : "Part",
          unit: row.unit || "ea",
          required: planned,
          available: 0,
          short: 0,
        });
      }
    } else if (row.item_type === "fabricated" && row.product_template_id) {
      const key = "fab:" + row.product_template_id;
      const existing = reqMap.get(key);
      if (existing) {
        existing.required += planned;
      } else {
        reqMap.set(key, {
          itemType: "fabricated",
          id: row.product_template_id,
          label: row.product_templates
            ? row.product_templates.name + (row.product_templates.product_number ? " (" + row.product_templates.product_number + ")" : "")
            : "Fabricated item",
          unit: row.unit || "ea",
          required: planned,
          available: 0,
          short: 0,
        });
      }
    }
  }

  const result: JobStockShortfallItem[] = [];
  for (const item of reqMap.values()) {
    const stock =
      item.itemType === "raw_material" ? (rmStock.get(item.id) || 0)
      : item.itemType === "purchased_part" ? (ppStock.get(item.id) || 0)
      : (fabStock.get(item.id) || 0);
    const claimedByOthers =
      item.itemType === "raw_material" ? (rmAlloc.get(item.id) || 0)
      : item.itemType === "purchased_part" ? (ppAlloc.get(item.id) || 0)
      : (fabAlloc.get(item.id) || 0);
    const available = stock - claimedByOthers;
    const short = item.required - available;

    item.available = available;
    item.short = short;

    // Ignore floating-point dust (a thousandth of a foot is meaningless)
    if (short > 0.001) result.push(item);
  }

  // Materials first, then parts, then fabricated; each alphabetical by label
  const typeOrder: Record<string, number> = { raw_material: 0, purchased_part: 1, fabricated: 2 };
  result.sort((a, b) => {
    if (a.itemType !== b.itemType) return typeOrder[a.itemType] - typeOrder[b.itemType];
    return a.label.localeCompare(b.label);
  });

  return result;
}

// ============================================
// Allocation management
// ============================================

// Allocate a job's pick list quantities from inventory (called when a job is released).
// Creates allocation rows at basis 'estimated' based on the current pick list.
export async function allocateJobInventory(jobId: string, companyId: string): Promise<void> {
  const supabase = createClient();

  // Don't double-allocate: clear any existing allocations for this job first
  await supabase.from("inventory_allocations").delete().eq("job_id", jobId);

  // Read the job's pick list
  const { data: pickList } = await supabase
    .from("job_pick_list_items")
    .select("item_type, raw_material_id, purchased_part_id, product_template_id, planned_quantity, unit")
    .eq("job_id", jobId);

  if (!pickList || pickList.length === 0) return;

  // Soft reservations for every line — raw materials, purchased parts, AND
  // fabricated sub-assemblies. Fabricated units reserve against fabricated stock
  // exactly like purchased parts reserve against parts stock: the ledger itself
  // isn't decremented here, only held by the allocation.
  const rows = pickList
    .filter((item) => Number(item.planned_quantity) > 0)
    .map((item) => ({
      company_id: companyId,
      job_id: jobId,
      item_type: item.item_type,
      raw_material_id: item.raw_material_id,
      purchased_part_id: item.purchased_part_id,
      product_template_id: item.product_template_id,
      allocated_quantity: Number(item.planned_quantity),
      unit: item.unit,
      basis: "estimated" as const,
    }));

  if (rows.length > 0) {
    await supabase.from("inventory_allocations").insert(rows);
  }
}

// Release (delete) all allocations for a job (called when a job goes back to quoted or is cancelled).
export async function releaseJobInventory(jobId: string): Promise<void> {
  const supabase = createClient();
  await supabase.from("inventory_allocations").delete().eq("job_id", jobId);
}
// ============================================
// Cutting nest stick pulls and drops
// ============================================

// Available lengths in stock for a material: each distinct length and how many sticks.
export async function getAvailableLengths(rawMaterialId: string): Promise<{ length: number; sticks: number }[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("raw_material_inventory")
    .select("stick_length_feet, quantity_sticks")
    .eq("raw_material_id", rawMaterialId);

  const map = new Map<number, number>();
  for (const b of data || []) {
    const len = Number(b.stick_length_feet);
    map.set(len, (map.get(len) || 0) + Number(b.quantity_sticks));
  }
  return Array.from(map.entries())
    .map(([length, sticks]) => ({ length, sticks }))
    .filter((g) => g.sticks > 0)
    .sort((a, b) => b.length - a.length);
}

// Pull sticks of a given length from inventory (inserts a negative-quantity batch) and logs the cutting nest entry.
export async function pullSticks(params: {
  companyId: string;
  jobId: string;
  rawMaterialId: string;
  length: number;
  quantity: number;
  costPerFoot: number;
}): Promise<void> {
  const supabase = createClient();
  const { companyId, jobId, rawMaterialId, length, quantity, costPerFoot } = params;

  // Deplete inventory with a negative batch at this length
  await supabase.from("raw_material_inventory").insert({
    company_id: companyId,
    raw_material_id: rawMaterialId,
    supplier_id: null,
    stick_length_feet: length,
    quantity_sticks: -quantity,
    cost_per_foot: costPerFoot,
    purchase_date: new Date().toISOString().slice(0, 10),
    source_note: "Pulled for cutting nest",
    source_job_id: jobId,
    notes: "Sticks pulled for job cutting nest",
    entry_type: "pull",
  });

  // Log the pull entry
  await supabase.from("cutting_nest_entries").insert({
    company_id: companyId,
    job_id: jobId,
    raw_material_id: rawMaterialId,
    entry_type: "pull",
    length_feet: length,
    quantity,
    cost_per_foot: costPerFoot,
  });
}

// Save a drop back to inventory and log the cutting nest entry (linked so it can be reversed).
export async function saveDrop(params: {
  companyId: string;
  jobId: string;
  rawMaterialId: string;
  length: number;
  quantity: number;
  costPerFoot: number;
  jobNumber: string;
}): Promise<void> {
  const supabase = createClient();
  const { companyId, jobId, rawMaterialId, length, quantity, costPerFoot, jobNumber } = params;

  // Add the drop back into inventory
  const { data: inv } = await supabase
    .from("raw_material_inventory")
    .insert({
      company_id: companyId,
      raw_material_id: rawMaterialId,
      supplier_id: null,
      stick_length_feet: length,
      quantity_sticks: quantity,
      cost_per_foot: costPerFoot,
      purchase_date: new Date().toISOString().slice(0, 10),
      source_note: "Drop from job " + jobNumber,
      source_job_id: jobId,
      notes: "Saved remnant from cutting nest",
      entry_type: "drop",
    })
    .select("id")
    .single();

  // Log the drop entry, linked to the inventory row it created
  await supabase.from("cutting_nest_entries").insert({
    company_id: companyId,
    job_id: jobId,
    raw_material_id: rawMaterialId,
    entry_type: "drop",
    length_feet: length,
    quantity,
    cost_per_foot: costPerFoot,
    created_inventory_id: inv?.id || null,
  });
}

// Reverse a cutting nest entry: undo its inventory effect and delete the log row.
export async function reverseCuttingNestEntry(entry: {
  id: string;
  entry_type: string;
  raw_material_id: string;
  length_feet: number;
  quantity: number;
  cost_per_foot: number;
  created_inventory_id: string | null;
  company_id: string;
  job_id: string;
}): Promise<void> {
  const supabase = createClient();

  if (entry.entry_type === "pull") {
    // Reverse a pull by adding the sticks back
    await supabase.from("raw_material_inventory").insert({
      company_id: entry.company_id,
      raw_material_id: entry.raw_material_id,
      supplier_id: null,
      stick_length_feet: entry.length_feet,
      quantity_sticks: entry.quantity,
      cost_per_foot: entry.cost_per_foot,
      purchase_date: new Date().toISOString().slice(0, 10),
      source_note: "Reversed pull",
      source_job_id: entry.job_id,
      notes: "Reversed a cutting nest stick pull",
      entry_type: "reversal",
    });
  } else if (entry.entry_type === "drop") {
    // Reverse a saved drop by removing the inventory it created (if still present)
    if (entry.created_inventory_id) {
      await supabase.from("raw_material_inventory").delete().eq("id", entry.created_inventory_id);
    } else {
      // Fallback: insert a negative batch to cancel it out
      await supabase.from("raw_material_inventory").insert({
        company_id: entry.company_id,
        raw_material_id: entry.raw_material_id,
        supplier_id: null,
        stick_length_feet: entry.length_feet,
        quantity_sticks: -entry.quantity,
        cost_per_foot: entry.cost_per_foot,
        purchase_date: new Date().toISOString().slice(0, 10),
        source_note: "Reversed drop",
        source_job_id: entry.job_id,
        notes: "Reversed a saved drop",
        entry_type: "reversal",
      });
    }
  }

  // Delete the log entry
  await supabase.from("cutting_nest_entries").delete().eq("id", entry.id);
}

// ============================================
// Job cost report
// ============================================

export type JobCostReport = {
  units: number;
  laborMinutes: number;
  laborHours: number;
  laborCost: number;
  materialActualCost: number;
  partsActualCost: number;
  fabricatedActualCost: number;
  scrapCost: number;
  totalActualCost: number;
  costPerUnit: number;
  // Estimate
  estimateMaterialCost: number;
  estimatePartsCost: number;
  estimateFabricatedCost: number;
  estimateLaborCost: number;
  totalEstimate: number;
  // Suggested retail
  suggestedMaterial: number;
  suggestedParts: number;
  suggestedFabricated: number;
  suggestedLabor: number;
  suggestedRetailTotal: number;
  suggestedRetailPerUnit: number;
  // Your retail
  retailPerUnit: number;
  retailTotal: number;
  // Margins
  netProfitTotal: number;
  netProfitPerUnit: number;
  marginPercent: number;
  // Settings used
  burdenRate: number;
  shopLaborRate: number;
  markupPercent: number;
};

export async function getJobCostReport(jobId: string): Promise<JobCostReport> {
  const supabase = createClient();

  // Company settings
  const { data: { user } } = await supabase.auth.getUser();
  let burdenRate = 0, shopLaborRate = 0, markupPercent = 0, companyId: string | null = null;
  if (user) {
    const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    companyId = profile?.company_id || null;
    if (companyId) {
      const { data: company } = await supabase
        .from("companies")
        .select("burden_rate_per_hour, shop_labor_rate_per_hour, material_markup_percent")
        .eq("id", companyId)
        .single();
      burdenRate = Number(company?.burden_rate_per_hour || 0);
      shopLaborRate = Number(company?.shop_labor_rate_per_hour || 0);
      markupPercent = Number(company?.material_markup_percent || 0);
    }
  }

  const [liRes, pickRes, timeRes, varRes, tasksRes, rmInvRes, ppInvRes, fabInvRes] = await Promise.all([
    supabase.from("job_line_items").select("quantity, product_template_id, unit_price, product_templates(retail_price_per_unit)").eq("job_id", jobId),
    supabase
      .from("job_pick_list_items")
      .select("item_type, planned_quantity, actual_quantity, raw_material_id, purchased_part_id, product_template_id, raw_materials(current_cost_per_foot), purchased_parts(current_cost_each)")
      .eq("job_id", jobId),
    supabase.from("time_entries").select("started_at, ended_at").eq("job_id", jobId),
    supabase
      .from("job_material_variances")
      .select("item_type, extra_quantity, raw_material_id, purchased_part_id, raw_materials(current_cost_per_foot), purchased_parts(current_cost_each)")
      .eq("job_id", jobId),
    supabase.from("job_tasks").select("estimated_minutes_total").eq("job_id", jobId),
    supabase.from("raw_material_inventory").select("raw_material_id, stick_length_feet, quantity_sticks, cost_per_foot, purchase_date, entry_type"),
    supabase.from("purchased_parts_inventory").select("purchased_part_id, quantity, cost_each, purchase_date, entry_type"),
    supabase.from("fabricated_inventory").select("product_template_id, quantity, cost_per_unit, source, created_at"),
  ]);

  type LiRow = { quantity: number; product_template_id: string | null; unit_price: number | null; product_templates: { retail_price_per_unit: number } | null };
  type PickRow = {
    item_type: string;
    planned_quantity: number;
    actual_quantity: number;
    raw_material_id: string | null;
    purchased_part_id: string | null;
    product_template_id: string | null;
    raw_materials: { current_cost_per_foot: number } | null;
    purchased_parts: { current_cost_each: number } | null;
  };
  type TimeRow = { started_at: string; ended_at: string | null };
  type VarRow = {
    item_type: string;
    extra_quantity: number;
    raw_material_id: string | null;
    purchased_part_id: string | null;
    raw_materials: { current_cost_per_foot: number } | null;
    purchased_parts: { current_cost_each: number } | null;
  };
  type TaskRow = { estimated_minutes_total: number };
  type RmInvRow = { raw_material_id: string; stick_length_feet: number; quantity_sticks: number; cost_per_foot: number; purchase_date: string; entry_type: string | null };
  type PpInvRow = { purchased_part_id: string; quantity: number; cost_each: number; purchase_date: string; entry_type: string | null };
  type FabInvRow = { product_template_id: string; quantity: number; cost_per_unit: number; source: string; created_at: string };

  const lineItems = (liRes.data || []) as unknown as LiRow[];
  const pick = (pickRes.data || []) as unknown as PickRow[];
  const times = (timeRes.data || []) as unknown as TimeRow[];
  const variances = (varRes.data || []) as unknown as VarRow[];
  const tasks = (tasksRes.data || []) as unknown as TaskRow[];
  const rmInv = (rmInvRes.data || []) as unknown as RmInvRow[];
  const ppInv = (ppInvRes.data || []) as unknown as PpInvRow[];
  const fabInv = (fabInvRes.data || []) as unknown as FabInvRow[];

  // Per-item unit cost under the "highest cost still on hand" rule.
  function rawCost(rawMaterialId: string | null, fallback: number): number {
    if (!rawMaterialId) return fallback;
    const rows = rmInv.filter((r) => r.raw_material_id === rawMaterialId);
    if (rows.length === 0) return fallback;
    const layers: CostLayer[] = rows
      .filter((r) => (r.entry_type === "purchase" || r.entry_type === "opening") && Number(r.stick_length_feet) * Number(r.quantity_sticks) > 0)
      .map((r) => ({ date: r.purchase_date, qty: Number(r.stick_length_feet) * Number(r.quantity_sticks), cost: Number(r.cost_per_foot) }));
    const out = rows.reduce((s, r) => {
      const f = Number(r.stick_length_feet) * Number(r.quantity_sticks);
      return f < 0 ? s + -f : s;
    }, 0);
    return highestCostOnHand(layers, out, fallback);
  }
  function partCost(purchasedPartId: string | null, fallback: number): number {
    if (!purchasedPartId) return fallback;
    const rows = ppInv.filter((r) => r.purchased_part_id === purchasedPartId);
    if (rows.length === 0) return fallback;
    const layers: CostLayer[] = rows
      .filter((r) => (r.entry_type === "purchase" || r.entry_type === "opening") && Number(r.quantity) > 0)
      .map((r) => ({ date: r.purchase_date, qty: Number(r.quantity), cost: Number(r.cost_each) }));
    const out = rows.reduce((s, r) => {
      const q = Number(r.quantity);
      return q < 0 ? s + -q : s;
    }, 0);
    return highestCostOnHand(layers, out, fallback);
  }
  // Per-unit cost of a fabricated sub-assembly under the same rule: build and
  // opening rows are price layers; consumption depletes them oldest-first.
  function fabCost(productTemplateId: string | null): number {
    if (!productTemplateId) return 0;
    const rows = fabInv.filter((r) => r.product_template_id === productTemplateId);
    const layers: CostLayer[] = rows
      .filter((r) => (r.source === "build" || r.source === "opening") && Number(r.quantity) > 0)
      .map((r) => ({ date: r.created_at, qty: Number(r.quantity), cost: Number(r.cost_per_unit) }));
    if (layers.length === 0) return 0;
    const out = rows.reduce((s, r) => {
      const q = Number(r.quantity);
      return q < 0 ? s + -q : s;
    }, 0);
    return highestCostOnHand(layers, out, 0);
  }

  const units = lineItems.reduce((s, li) => s + Number(li.quantity), 0);

  // Labor: sum completed time entries (open ones counted to now)
  const nowMs = Date.now();
  const laborMinutes = times.reduce((sum, t) => {
    const end = t.ended_at ? new Date(t.ended_at).getTime() : nowMs;
    return sum + Math.max(0, (end - new Date(t.started_at).getTime()) / 60000);
  }, 0);
  const laborHours = laborMinutes / 60;
  const laborCost = laborHours * burdenRate;

  // Material, parts, and fabricated-stock actual cost
  let materialActualCost = 0;
  let partsActualCost = 0;
  let fabricatedActualCost = 0;
  let estimateMaterialCost = 0;
  let estimatePartsCost = 0;
  let estimateFabricatedCost = 0;
  for (const p of pick) {
    if (p.item_type === "raw_material") {
      const cost = rawCost(p.raw_material_id, Number(p.raw_materials?.current_cost_per_foot || 0));
      materialActualCost += Number(p.actual_quantity) * cost;
      estimateMaterialCost += Number(p.planned_quantity) * cost;
    } else if (p.item_type === "fabricated") {
      // Fabricated units are pulled at the planned quantity at release (no
      // cutting-nest "actual" applies), so planned drives both estimate and actual.
      const cost = fabCost(p.product_template_id);
      fabricatedActualCost += Number(p.planned_quantity) * cost;
      estimateFabricatedCost += Number(p.planned_quantity) * cost;
    } else {
      const cost = partCost(p.purchased_part_id, Number(p.purchased_parts?.current_cost_each || 0));
      partsActualCost += Number(p.actual_quantity) * cost;
      estimatePartsCost += Number(p.planned_quantity) * cost;
    }
  }

  // Scrap cost (informational; already inside actuals)
  let scrapCost = 0;
  for (const v of variances) {
    if (v.item_type === "raw_material") {
      scrapCost += Number(v.extra_quantity) * rawCost(v.raw_material_id, Number(v.raw_materials?.current_cost_per_foot || 0));
    } else {
      scrapCost += Number(v.extra_quantity) * partCost(v.purchased_part_id, Number(v.purchased_parts?.current_cost_each || 0));
    }
  }

  const totalActualCost = laborCost + materialActualCost + partsActualCost + fabricatedActualCost;
  const costPerUnit = units > 0 ? totalActualCost / units : 0;

  // Estimate labor from template task estimates
  const estimateLaborMinutes = tasks.reduce((s, t) => s + Number(t.estimated_minutes_total), 0);
  const estimateLaborCost = (estimateLaborMinutes / 60) * burdenRate;
  const totalEstimate = estimateMaterialCost + estimatePartsCost + estimateFabricatedCost + estimateLaborCost;

  // Suggested retail: estimated material/parts/fabricated with markup + actual labor at shop rate (no scrap)
  const markupMult = 1 + markupPercent / 100;
  const suggestedMaterial = estimateMaterialCost * markupMult;
  const suggestedParts = estimatePartsCost * markupMult;
  const suggestedFabricated = estimateFabricatedCost * markupMult;
  const suggestedLabor = laborHours * shopLaborRate;
  const suggestedRetailTotal = suggestedMaterial + suggestedParts + suggestedFabricated + suggestedLabor;
  const suggestedRetailPerUnit = units > 0 ? suggestedRetailTotal / units : 0;

  // Your retail (from product template, summed across line items)
  // Retail per unit: template price if the line has a template, otherwise the custom job's unit_price
  const retailTotal = lineItems.reduce((s, li) => {
    const perUnit = li.product_templates?.retail_price_per_unit != null
      ? Number(li.product_templates.retail_price_per_unit)
      : Number(li.unit_price || 0);
    return s + perUnit * Number(li.quantity);
  }, 0);
  const retailPerUnit = units > 0 ? retailTotal / units : 0;

  // Net profit based on YOUR retail
  const netProfitTotal = retailTotal - totalActualCost;
  const netProfitPerUnit = units > 0 ? netProfitTotal / units : 0;
  const marginPercent = retailTotal > 0 ? (netProfitTotal / retailTotal) * 100 : 0;

  return {
    units,
    laborMinutes,
    laborHours,
    laborCost,
    materialActualCost,
    partsActualCost,
    fabricatedActualCost,
    scrapCost,
    totalActualCost,
    costPerUnit,
    estimateMaterialCost,
    estimatePartsCost,
    estimateFabricatedCost,
    estimateLaborCost,
    totalEstimate,
    suggestedMaterial,
    suggestedParts,
    suggestedFabricated,
    suggestedLabor,
    suggestedRetailTotal,
    suggestedRetailPerUnit,
    retailPerUnit,
    retailTotal,
    netProfitTotal,
    netProfitPerUnit,
    marginPercent,
    burdenRate,
    shopLaborRate,
    markupPercent,
  };
}
// ============================================
// Build-order output cost split (shared-nest builds)
// ============================================

export type BuildOutputCost = {
  templateId: string;
  name: string;
  quantity: number;
  estCostPerUnit: number; // estimated bill-of-materials cost per unit (material + parts + fabricated children)
  costPerUnit: number;    // actual job cost allocated to this output, per unit
  totalCost: number;      // costPerUnit * quantity
};

// Split a build order's total ACTUAL cost (material + parts + labor, from
// getJobCostReport) across the items it produces, in proportion to each item's
// estimated bill-of-materials cost (BOM cost per unit x quantity), valued under the
// same "highest cost still on hand" rule used everywhere else.
//
// Outputs come from the build_outputs table (one row per item a shared-nest build
// produces). A plain single-output build that predates build_outputs has no rows, so
// we fall back to jobs.build_template_id / jobs.build_quantity and return one output.
//
// If no BOM cost can be determined (totalWeight is 0), the cost is split evenly per
// unit so nothing is ever stocked at $0 by surprise.
export async function getBuildOutputsCostSplit(jobId: string): Promise<BuildOutputCost[]> {
  const supabase = createClient();

  // 1) Determine the outputs (build_outputs rows, else the single build fields).
  const { data: jobRow } = await supabase
    .from("jobs")
    .select("build_template_id, build_quantity")
    .eq("id", jobId)
    .single();
  const { data: boData } = await supabase
    .from("build_outputs")
    .select("product_template_id, quantity")
    .eq("job_id", jobId);

  type BoRow = { product_template_id: string; quantity: number };
  const bo = (boData || []) as unknown as BoRow[];
  const jr = jobRow as { build_template_id: string | null; build_quantity: number | null } | null;

  let outputs: { templateId: string; quantity: number }[] = [];
  if (bo.length > 0) {
    outputs = bo.map((r) => ({ templateId: r.product_template_id, quantity: Number(r.quantity) }));
  } else if (jr?.build_template_id && jr?.build_quantity != null) {
    outputs = [{ templateId: jr.build_template_id, quantity: Number(jr.build_quantity) }];
  }
  if (outputs.length === 0) return [];

  // 2) Walk every output's sub-assembly tree so we can value its full BOM.
  const allTemplateIds = new Set<string>();
  const queue = [...new Set(outputs.map((o) => o.templateId))];
  while (queue.length > 0) {
    const tid = queue.shift()!;
    if (allTemplateIds.has(tid)) continue;
    allTemplateIds.add(tid);
    const { data } = await supabase
      .from("product_template_sub_assemblies")
      .select("child_template_id")
      .eq("parent_template_id", tid);
    for (const row of (data || []) as { child_template_id: string }[]) {
      if (!allTemplateIds.has(row.child_template_id)) queue.push(row.child_template_id);
    }
  }
  const templateIdArr = Array.from(allTemplateIds);

  const [matsRes, partsRes, subLinksRes, tplRes, rmInvRes, ppInvRes, fabInvRes] = await Promise.all([
    supabase
      .from("product_template_materials")
      .select("product_template_id, feet_per_unit, raw_materials(id, current_cost_per_foot)")
      .in("product_template_id", templateIdArr),
    supabase
      .from("product_template_parts")
      .select("product_template_id, quantity_per_unit, purchased_parts(id, current_cost_each)")
      .in("product_template_id", templateIdArr),
    supabase
      .from("product_template_sub_assemblies")
      .select("parent_template_id, child_template_id, quantity_per_unit")
      .in("parent_template_id", templateIdArr),
    supabase
      .from("product_templates")
      .select("id, name, is_stockable")
      .in("id", templateIdArr),
    supabase.from("raw_material_inventory").select("raw_material_id, stick_length_feet, quantity_sticks, cost_per_foot, purchase_date, entry_type"),
    supabase.from("purchased_parts_inventory").select("purchased_part_id, quantity, cost_each, purchase_date, entry_type"),
    supabase.from("fabricated_inventory").select("product_template_id, quantity, cost_per_unit, source, created_at"),
  ]);

  type TplMatRow = { product_template_id: string; feet_per_unit: number; raw_materials: { id: string; current_cost_per_foot: number } | null };
  type TplPartRow = { product_template_id: string; quantity_per_unit: number; purchased_parts: { id: string; current_cost_each: number } | null };
  type TplSubRow = { parent_template_id: string; child_template_id: string; quantity_per_unit: number };
  type TplRow = { id: string; name: string; is_stockable: boolean | null };
  type RmInvRow = { raw_material_id: string; stick_length_feet: number; quantity_sticks: number; cost_per_foot: number; purchase_date: string; entry_type: string | null };
  type PpInvRow = { purchased_part_id: string; quantity: number; cost_each: number; purchase_date: string; entry_type: string | null };
  type FabInvRow = { product_template_id: string; quantity: number; cost_per_unit: number; source: string; created_at: string };

  const tplMaterials = (matsRes.data || []) as unknown as TplMatRow[];
  const tplParts = (partsRes.data || []) as unknown as TplPartRow[];
  const tplSubs = (subLinksRes.data || []) as unknown as TplSubRow[];
  const tpls = (tplRes.data || []) as unknown as TplRow[];
  const rmInv = (rmInvRes.data || []) as unknown as RmInvRow[];
  const ppInv = (ppInvRes.data || []) as unknown as PpInvRow[];
  const fabInv = (fabInvRes.data || []) as unknown as FabInvRow[];

  const templateNames = new Map<string, string>(tpls.map((t) => [t.id, t.name]));
  const stockableIds = new Set<string>(tpls.filter((t) => t.is_stockable).map((t) => t.id));

  // Cost-rule helpers — identical to getJobCostReport's.
  function rawCost(rawMaterialId: string, fallback: number): number {
    const rows = rmInv.filter((r) => r.raw_material_id === rawMaterialId);
    if (rows.length === 0) return fallback;
    const layers: CostLayer[] = rows
      .filter((r) => (r.entry_type === "purchase" || r.entry_type === "opening") && Number(r.stick_length_feet) * Number(r.quantity_sticks) > 0)
      .map((r) => ({ date: r.purchase_date, qty: Number(r.stick_length_feet) * Number(r.quantity_sticks), cost: Number(r.cost_per_foot) }));
    const out = rows.reduce((s, r) => {
      const f = Number(r.stick_length_feet) * Number(r.quantity_sticks);
      return f < 0 ? s + -f : s;
    }, 0);
    return highestCostOnHand(layers, out, fallback);
  }
  function partCost(purchasedPartId: string, fallback: number): number {
    const rows = ppInv.filter((r) => r.purchased_part_id === purchasedPartId);
    if (rows.length === 0) return fallback;
    const layers: CostLayer[] = rows
      .filter((r) => (r.entry_type === "purchase" || r.entry_type === "opening") && Number(r.quantity) > 0)
      .map((r) => ({ date: r.purchase_date, qty: Number(r.quantity), cost: Number(r.cost_each) }));
    const out = rows.reduce((s, r) => {
      const q = Number(r.quantity);
      return q < 0 ? s + -q : s;
    }, 0);
    return highestCostOnHand(layers, out, fallback);
  }
  function fabCost(productTemplateId: string): number {
    const rows = fabInv.filter((r) => r.product_template_id === productTemplateId);
    const layers: CostLayer[] = rows
      .filter((r) => (r.source === "build" || r.source === "opening") && Number(r.quantity) > 0)
      .map((r) => ({ date: r.created_at, qty: Number(r.quantity), cost: Number(r.cost_per_unit) }));
    if (layers.length === 0) return 0;
    const out = rows.reduce((s, r) => {
      const q = Number(r.quantity);
      return q < 0 ? s + -q : s;
    }, 0);
    return highestCostOnHand(layers, out, 0);
  }

  // Estimated BOM cost for ONE unit of a template: expand its tree, stopping at a
  // stockable child (which is pulled finished from stock and valued at its fab cost).
  function bomCostPerUnit(rootTemplateId: string): number {
    const matFeet = new Map<string, number>();
    const partQty = new Map<string, number>();
    const fabQty = new Map<string, number>();
    function expand(templateId: string, multiplier: number) {
      for (const m of tplMaterials.filter((x) => x.product_template_id === templateId)) {
        if (!m.raw_materials) continue;
        matFeet.set(m.raw_materials.id, (matFeet.get(m.raw_materials.id) || 0) + Number(m.feet_per_unit) * multiplier);
      }
      for (const p of tplParts.filter((x) => x.product_template_id === templateId)) {
        if (!p.purchased_parts) continue;
        partQty.set(p.purchased_parts.id, (partQty.get(p.purchased_parts.id) || 0) + Number(p.quantity_per_unit) * multiplier);
      }
      for (const link of tplSubs.filter((s) => s.parent_template_id === templateId)) {
        const childQty = multiplier * Number(link.quantity_per_unit);
        if (stockableIds.has(link.child_template_id)) {
          fabQty.set(link.child_template_id, (fabQty.get(link.child_template_id) || 0) + childQty);
        } else {
          expand(link.child_template_id, childQty);
        }
      }
    }
    expand(rootTemplateId, 1);

    let cost = 0;
    for (const [rmId, feet] of matFeet.entries()) {
      const fallback = tplMaterials.find((x) => x.raw_materials?.id === rmId)?.raw_materials?.current_cost_per_foot || 0;
      cost += feet * rawCost(rmId, Number(fallback));
    }
    for (const [ppId, qty] of partQty.entries()) {
      const fallback = tplParts.find((x) => x.purchased_parts?.id === ppId)?.purchased_parts?.current_cost_each || 0;
      cost += qty * partCost(ppId, Number(fallback));
    }
    for (const [childId, qty] of fabQty.entries()) {
      cost += qty * fabCost(childId);
    }
    return cost;
  }

  // 3) Weight each output by estCostPerUnit * quantity, then split the actual cost.
  const report = await getJobCostReport(jobId);
  const total = report.totalActualCost;

  const enriched = outputs.map((o) => {
    const estCostPerUnit = bomCostPerUnit(o.templateId);
    return { ...o, estCostPerUnit, weight: estCostPerUnit * o.quantity };
  });
  const totalWeight = enriched.reduce((s, e) => s + e.weight, 0);
  const totalUnits = enriched.reduce((s, e) => s + e.quantity, 0);

  return enriched.map((e) => {
    let totalCost: number;
    if (totalWeight > 0) {
      totalCost = total * (e.weight / totalWeight);
    } else {
      totalCost = totalUnits > 0 ? total * (e.quantity / totalUnits) : 0;
    }
    const costPerUnit = e.quantity > 0 ? totalCost / e.quantity : 0;
    return {
      templateId: e.templateId,
      name: templateNames.get(e.templateId) || "Item",
      quantity: e.quantity,
      estCostPerUnit: e.estCostPerUnit,
      costPerUnit,
      totalCost,
    };
  });
}
