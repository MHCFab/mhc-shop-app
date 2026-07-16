import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerSupabaseClient } from "../lib/supabase-server";
import PortalSignOut from "./PortalSignOut";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, customer_id, is_active")
    .eq("id", user.id)
    .single();

  // Only customer logins belong here (middleware also enforces this)
  if (profile?.role !== "customer") {
    redirect("/");
  }

  // Disabled portal accounts get a clear message instead of empty pages
  if (!profile?.is_active) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm max-w-md w-full p-8 text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Portal access disabled</h1>
          <p className="text-gray-600 mb-6">
            This account&apos;s portal access has been turned off. If you think this is a
            mistake, contact us and we can turn it back on.
          </p>
          <PortalSignOut />
        </div>
      </div>
    );
  }

  let customerName = "";
  if (profile?.customer_id) {
    const { data: customer } = await supabase
      .from("customers")
      .select("name")
      .eq("id", profile.customer_id)
      .single();
    customerName = customer?.name || "";
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <Link href="/portal" className="text-xl font-bold text-gray-900">ShopWorks</Link>
            {customerName && <p className="text-xs text-gray-500">{customerName}</p>}
          </div>
          <div className="flex items-center gap-4">
            <Link href="/portal" className="text-sm text-blue-600 hover:text-blue-800 font-medium">Jobs</Link>
            <Link href="/portal/products" className="text-sm text-blue-600 hover:text-blue-800 font-medium">Products</Link>
            <span className="hidden sm:inline text-sm text-gray-700">{profile?.full_name || ""}</span>
            <PortalSignOut />
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
