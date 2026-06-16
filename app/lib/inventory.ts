import { createClient } from "./supabase";

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