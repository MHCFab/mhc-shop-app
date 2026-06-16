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