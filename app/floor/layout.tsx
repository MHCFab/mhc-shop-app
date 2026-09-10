import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerSupabaseClient } from "../lib/supabase-server";
import FloorSignOut from "./FloorSignOut";
import ShopSwitcher, { type Membership } from "../components/ShopSwitcher";
import ShopLockedScreen from "../components/ShopLockedScreen";
import { checkShopAccess } from "../lib/shop-access";

export default async function FloorLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, company_id")
    .eq("id", user.id)
    .single();

  let companyName = "";
  if (profile?.company_id) {
    const { data: company } = await supabase.from("companies").select("name").eq("id", profile.company_id).single();
    companyName = company?.name || "";
  }

  const isAdmin = profile?.role === "admin";

  // Which shops this person belongs to. Renders nothing at all unless they
  // belong to more than one, or another shop has asked to add them.
  const { data: membershipRows } = await supabase.rpc("my_memberships");

  // Same check the admin area does. An admin standing at a tablet gets the
  // owner wording; the crew get the plain one, with nothing about billing in
  // it - that is a conversation for them and their boss, not for us.
  const access = await checkShopAccess(supabase);

  if (access?.state === "locked") {
    return (
      <>
        <ShopSwitcher memberships={(membershipRows || []) as unknown as Membership[]} />
        <ShopLockedScreen isOwner={isAdmin} shopName={access.shopName} />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <ShopSwitcher memberships={(membershipRows || []) as unknown as Membership[]} />
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <Link href="/floor" className="text-xl font-bold text-gray-900">ShopWorks</Link>
            {companyName && <p className="text-xs text-gray-500">{companyName}</p>}
          </div>
          <div className="flex items-center gap-3">
            {isAdmin && (
              <Link href="/admin" className="text-sm text-blue-600 hover:text-blue-800 font-medium">Admin</Link>
            )}
            <span className="text-sm text-gray-700">{profile?.full_name || "Crew"}</span>
            <FloorSignOut />
          </div>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}