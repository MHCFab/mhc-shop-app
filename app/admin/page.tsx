import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "../lib/supabase-server";

export default async function AdminDashboard() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || profile.role !== "admin") {
    redirect("/");
  }

  // Fabricated stockable items at or below their reorder point.
  const [stockTplsRes, fabLedgerRes] = await Promise.all([
    supabase
      .from("product_templates")
      .select("id, name, product_number, reorder_point, reorder_target")
      .eq("is_stockable", true)
      .eq("is_active", true)
      .not("reorder_point", "is", null),
    supabase.from("fabricated_inventory").select("product_template_id, quantity"),
  ]);

  type ReorderTplRow = { id: string; name: string; product_number: string | null; reorder_point: number | null; reorder_target: number | null };
  const onHandMap = new Map<string, number>();
  for (const r of (fabLedgerRes.data || []) as { product_template_id: string; quantity: number }[]) {
    onHandMap.set(r.product_template_id, (onHandMap.get(r.product_template_id) || 0) + Number(r.quantity));
  }
  const reorderItems = ((stockTplsRes.data || []) as ReorderTplRow[])
    .map((t) => {
      const onHand = onHandMap.get(t.id) || 0;
      const point = t.reorder_point != null ? Number(t.reorder_point) : null;
      const target = t.reorder_target != null ? Number(t.reorder_target) : null;
      const buildTo = target != null ? target : point;
      const suggested = point != null && buildTo != null ? Math.max(0, buildTo - onHand) : 0;
      return { id: t.id, name: t.name, product_number: t.product_number, onHand, point: point ?? 0, suggested };
    })
    .filter((x) => x.onHand <= x.point)
    .sort((a, b) => (a.onHand - a.point) - (b.onHand - b.point));

  const cards = [
    {
      title: "Jobs",
      description: "Customer work orders. Create and track jobs from quote through shipping.",
      href: "/admin/jobs",
    },
    {
      title: "Inventory",
      description: "Available stock on hand for raw materials and purchased parts.",
      href: "/admin/inventory",
    },
    {
      title: "Suppliers",
      description: "Manage the vendors you buy raw materials and parts from.",
      href: "/admin/suppliers",
    },
    {
      title: "Customers",
      description: "Manage the companies and contacts you build jobs for.",
      href: "/admin/customers",
    },
    {
      title: "Product Templates",
      description: "Define product recipes with materials, parts, tasks, SOPs, photos, and notes.",
      href: "/admin/product-templates",
    },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-600 mt-1">
          Manage shop data, inventory, and configuration.
        </p>
      </div>

      {reorderItems.length > 0 && (
        <div className="bg-white border border-amber-200 rounded-lg p-5 mb-6">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <h2 className="text-lg font-semibold text-gray-900">
              Fabricated items to reorder
              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">{reorderItems.length}</span>
            </h2>
            <Link href="/admin/inventory" className="text-sm text-blue-600 hover:text-blue-800 font-medium">View inventory &rarr;</Link>
          </div>
          <ul className="divide-y divide-gray-100">
            {reorderItems.map((it) => (
              <li key={it.id} className="py-2 flex items-center justify-between gap-3 flex-wrap">
                <Link href={"/admin/inventory/fabricated/" + it.id} className="text-sm font-medium text-gray-900 hover:text-blue-700">
                  {it.name}{it.product_number ? " (" + it.product_number + ")" : ""}
                </Link>
                <span className="text-sm text-gray-600">
                  <span className="font-mono">{it.onHand.toFixed(0)}</span> on hand &middot; reorder at <span className="font-mono">{it.point.toFixed(0)}</span>
                  {it.suggested > 0 && <> &middot; <span className="text-amber-700 font-medium">build {it.suggested.toFixed(0)}</span></>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="block bg-white rounded-lg border border-gray-200 p-6 hover:border-blue-400 hover:shadow-md transition-all"
          >
            <h2 className="text-lg font-semibold text-gray-900 mb-2">
              {card.title}
            </h2>
            <p className="text-sm text-gray-600">{card.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}