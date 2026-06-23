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
  lifoCostPerFoot: number;
};

export type AvailablePurchasedPart = {
  id: string;
  name: string;
  part_number: string | null;
  category: string;
  current_cost_each: number;
  is_active: boolean;
  totalInStock: number;
  allocated: number;
  available: number;
  lifoCostEach: number;
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
      .select("raw_material_id, stick_length_feet, quantity_sticks, cost_per_foot, purchase_date"),
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

    // LIFO: cost from the most recent purchase batch
    const sortedBatches = [...batches].sort(
      (a, b) => new Date(b.purchase_date).getTime() - new Date(a.purchase_date).getTime()
    );
    const lifoCostPerFoot = sortedBatches.length > 0
      ? Number(sortedBatches[0].cost_per_foot)
      : Number(m.current_cost_per_foot);

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
      lifoCostPerFoot,
    };
  });
}

export async function getAvailablePurchasedParts(): Promise<AvailablePurchasedPart[]> {
  const supabase = createClient();

  const [partsRes, invRes, allocRes] = await Promise.all([
    supabase
      .from("purchased_parts")
      .select("id, name, part_number, category, current_cost_each, is_active")
      .order("name"),
    supabase
      .from("purchased_parts_inventory")
      .select("purchased_part_id, quantity, cost_each, purchase_date"),
    supabase
      .from("inventory_allocations")
      .select("purchased_part_id, allocated_quantity")
      .eq("item_type", "purchased_part"),
  ]);

  const parts = partsRes.data || [];
  const inv = invRes.data || [];
  const allocs = allocRes.data || [];

  return parts.map((p) => {
    const batches = inv.filter((b) => b.purchased_part_id === p.id);
    const totalInStock = batches.reduce((sum, b) => sum + Number(b.quantity), 0);
    const allocated = allocs
      .filter((a) => a.purchased_part_id === p.id)
      .reduce((sum, a) => sum + Number(a.allocated_quantity), 0);

    const sortedBatches = [...batches].sort(
      (a, b) => new Date(b.purchase_date).getTime() - new Date(a.purchase_date).getTime()
    );
    const lifoCostEach = sortedBatches.length > 0
      ? Number(sortedBatches[0].cost_each)
      : Number(p.current_cost_each);

    return {
      id: p.id,
      name: p.name,
      part_number: p.part_number,
      category: p.category,
      current_cost_each: Number(p.current_cost_each),
      is_active: p.is_active,
      totalInStock,
      allocated,
      available: totalInStock - allocated,
      lifoCostEach,
    };
  });
}

// ============================================
// Job stock shortfall (stockout alert)
// ============================================

export type JobStockShortfallItem = {
  itemType: "raw_material" | "purchased_part";
  id: string;        // raw_material_id or purchased_part_id
  label: string;     // human-readable description
  unit: string;      // "ft" for materials, "ea" for parts
  required: number;  // how much this job needs (from its pick list)
  available: number; // stock on hand minus what OTHER jobs have claimed
  short: number;     // how much you still need to acquire (required - available, min 0)
};

// Compare a job's pick list against what's actually free in inventory and return
// only the items that are short. "Available" excludes this job's own allocations,
// so the number stays correct whether the job is still 'ordered' or already 'ready'.
export async function getJobStockShortfall(jobId: string): Promise<JobStockShortfallItem[]> {
  const supabase = createClient();

  const [pickRes, rmInvRes, ppInvRes, allocRes] = await Promise.all([
    supabase
      .from("job_pick_list_items")
      .select("item_type, raw_material_id, purchased_part_id, planned_quantity, unit, raw_materials(shape, size, wall_thickness, grade), purchased_parts(name, part_number)")
      .eq("job_id", jobId),
    supabase
      .from("raw_material_inventory")
      .select("raw_material_id, stick_length_feet, quantity_sticks"),
    supabase
      .from("purchased_parts_inventory")
      .select("purchased_part_id, quantity"),
    // All allocations EXCEPT this job's own, so we don't count the job against itself
    supabase
      .from("inventory_allocations")
      .select("item_type, raw_material_id, purchased_part_id, allocated_quantity")
      .neq("job_id", jobId),
  ]);

  type PickRow = {
    item_type: string;
    raw_material_id: string | null;
    purchased_part_id: string | null;
    planned_quantity: number;
    unit: string;
    raw_materials: { shape: string; size: string; wall_thickness: string | null; grade: string } | null;
    purchased_parts: { name: string; part_number: string | null } | null;
  };
  type RmInvRow = { raw_material_id: string; stick_length_feet: number; quantity_sticks: number };
  type PpInvRow = { purchased_part_id: string; quantity: number };
  type AllocRow = { item_type: string; raw_material_id: string | null; purchased_part_id: string | null; allocated_quantity: number };

  const pick = (pickRes.data || []) as unknown as PickRow[];
  const rmInv = (rmInvRes.data || []) as unknown as RmInvRow[];
  const ppInv = (ppInvRes.data || []) as unknown as PpInvRow[];
  const allocs = (allocRes.data || []) as unknown as AllocRow[];

  // Total stock on hand per material / part
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

  // What OTHER jobs have already claimed
  const rmAlloc = new Map<string, number>();
  const ppAlloc = new Map<string, number>();
  for (const a of allocs) {
    if (a.item_type === "raw_material" && a.raw_material_id) {
      rmAlloc.set(a.raw_material_id, (rmAlloc.get(a.raw_material_id) || 0) + Number(a.allocated_quantity));
    } else if (a.item_type === "purchased_part" && a.purchased_part_id) {
      ppAlloc.set(a.purchased_part_id, (ppAlloc.get(a.purchased_part_id) || 0) + Number(a.allocated_quantity));
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
    }
  }

  const result: JobStockShortfallItem[] = [];
  for (const item of reqMap.values()) {
    const stock = item.itemType === "raw_material" ? (rmStock.get(item.id) || 0) : (ppStock.get(item.id) || 0);
    const claimedByOthers = item.itemType === "raw_material" ? (rmAlloc.get(item.id) || 0) : (ppAlloc.get(item.id) || 0);
    const available = stock - claimedByOthers;
    const short = item.required - available;

    item.available = available;
    item.short = short;

    // Ignore floating-point dust (a thousandth of a foot is meaningless)
    if (short > 0.001) result.push(item);
  }

  // Materials first, then parts, each alphabetical by label
  result.sort((a, b) => {
    if (a.itemType !== b.itemType) return a.itemType === "raw_material" ? -1 : 1;
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
    .select("item_type, raw_material_id, purchased_part_id, planned_quantity, unit")
    .eq("job_id", jobId);

  if (!pickList || pickList.length === 0) return;

  const rows = pickList
    .filter((item) => Number(item.planned_quantity) > 0)
    .map((item) => ({
      company_id: companyId,
      job_id: jobId,
      item_type: item.item_type,
      raw_material_id: item.raw_material_id,
      purchased_part_id: item.purchased_part_id,
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
  scrapCost: number;
  totalActualCost: number;
  costPerUnit: number;
  // Estimate
  estimateMaterialCost: number;
  estimatePartsCost: number;
  estimateLaborCost: number;
  totalEstimate: number;
  // Suggested retail
  suggestedMaterial: number;
  suggestedParts: number;
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

  const [liRes, pickRes, timeRes, varRes, tasksRes] = await Promise.all([
    supabase.from("job_line_items").select("quantity, product_template_id, product_templates(retail_price_per_unit)").eq("job_id", jobId),
    supabase
      .from("job_pick_list_items")
      .select("item_type, planned_quantity, actual_quantity, raw_materials(current_cost_per_foot), purchased_parts(current_cost_each)")
      .eq("job_id", jobId),
    supabase.from("time_entries").select("started_at, ended_at").eq("job_id", jobId),
    supabase
      .from("job_material_variances")
      .select("item_type, extra_quantity, raw_materials(current_cost_per_foot), purchased_parts(current_cost_each)")
      .eq("job_id", jobId),
    supabase.from("job_tasks").select("estimated_minutes_total").eq("job_id", jobId),
  ]);

  type LiRow = { quantity: number; product_template_id: string; product_templates: { retail_price_per_unit: number } | null };
  type PickRow = {
    item_type: string;
    planned_quantity: number;
    actual_quantity: number;
    raw_materials: { current_cost_per_foot: number } | null;
    purchased_parts: { current_cost_each: number } | null;
  };
  type TimeRow = { started_at: string; ended_at: string | null };
  type VarRow = {
    item_type: string;
    extra_quantity: number;
    raw_materials: { current_cost_per_foot: number } | null;
    purchased_parts: { current_cost_each: number } | null;
  };
  type TaskRow = { estimated_minutes_total: number };

  const lineItems = (liRes.data || []) as unknown as LiRow[];
  const pick = (pickRes.data || []) as unknown as PickRow[];
  const times = (timeRes.data || []) as unknown as TimeRow[];
  const variances = (varRes.data || []) as unknown as VarRow[];
  const tasks = (tasksRes.data || []) as unknown as TaskRow[];

  const units = lineItems.reduce((s, li) => s + Number(li.quantity), 0);

  // Labor: sum completed time entries (open ones counted to now)
  const nowMs = Date.now();
  const laborMinutes = times.reduce((sum, t) => {
    const end = t.ended_at ? new Date(t.ended_at).getTime() : nowMs;
    return sum + Math.max(0, (end - new Date(t.started_at).getTime()) / 60000);
  }, 0);
  const laborHours = laborMinutes / 60;
  const laborCost = laborHours * burdenRate;

  // Material & parts actual cost
  let materialActualCost = 0;
  let partsActualCost = 0;
  let estimateMaterialCost = 0;
  let estimatePartsCost = 0;
  for (const p of pick) {
    if (p.item_type === "raw_material") {
      const cost = Number(p.raw_materials?.current_cost_per_foot || 0);
      materialActualCost += Number(p.actual_quantity) * cost;
      estimateMaterialCost += Number(p.planned_quantity) * cost;
    } else {
      const cost = Number(p.purchased_parts?.current_cost_each || 0);
      partsActualCost += Number(p.actual_quantity) * cost;
      estimatePartsCost += Number(p.planned_quantity) * cost;
    }
  }

  // Scrap cost (informational; already inside actuals)
  let scrapCost = 0;
  for (const v of variances) {
    if (v.item_type === "raw_material") {
      scrapCost += Number(v.extra_quantity) * Number(v.raw_materials?.current_cost_per_foot || 0);
    } else {
      scrapCost += Number(v.extra_quantity) * Number(v.purchased_parts?.current_cost_each || 0);
    }
  }

  const totalActualCost = laborCost + materialActualCost + partsActualCost;
  const costPerUnit = units > 0 ? totalActualCost / units : 0;

  // Estimate labor from template task estimates
  const estimateLaborMinutes = tasks.reduce((s, t) => s + Number(t.estimated_minutes_total), 0);
  const estimateLaborCost = (estimateLaborMinutes / 60) * burdenRate;
  const totalEstimate = estimateMaterialCost + estimatePartsCost + estimateLaborCost;

  // Suggested retail: estimated material/parts with markup + actual labor at shop rate (no scrap)
  const markupMult = 1 + markupPercent / 100;
  const suggestedMaterial = estimateMaterialCost * markupMult;
  const suggestedParts = estimatePartsCost * markupMult;
  const suggestedLabor = laborHours * shopLaborRate;
  const suggestedRetailTotal = suggestedMaterial + suggestedParts + suggestedLabor;
  const suggestedRetailPerUnit = units > 0 ? suggestedRetailTotal / units : 0;

  // Your retail (from product template, summed across line items)
  const retailTotal = lineItems.reduce((s, li) => s + Number(li.product_templates?.retail_price_per_unit || 0) * Number(li.quantity), 0);
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
    scrapCost,
    totalActualCost,
    costPerUnit,
    estimateMaterialCost,
    estimatePartsCost,
    estimateLaborCost,
    totalEstimate,
    suggestedMaterial,
    suggestedParts,
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