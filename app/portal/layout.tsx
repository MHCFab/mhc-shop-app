import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerSupabaseClient } from "../lib/supabase-server";
import PortalSignOut from "./PortalSignOut";
import UnreadNavBadge from "../components/UnreadNavBadge";
import ShopSwitcher, { type Membership } from "../components/ShopSwitcher";
import ShopLockedScreen from "../components/ShopLockedScreen";
import { checkShopAccess } from "../lib/shop-access";

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

  // Which shops this person belongs to. Renders nothing at all unless they
  // belong to more than one, or another shop has asked to add them.
  const { data: membershipRows } = await supabase.rpc("my_memberships");
  const memberships = (membershipRows || []) as unknown as Membership[];

  // If the shop has lapsed, its customers get the neutral screen and NOTHING
  // about money. They are not our customer and they are not the ones who owe
  // anything - all they need to know is that it is not available and their
  // supplier can tell them more. The switcher stays, for the same reason it
  // is on the disabled screen below.
  const access = await checkShopAccess(supabase);

  if (access?.state === "locked") {
    return (
      <>
        <ShopSwitcher memberships={memberships} />
        <ShopLockedScreen isOwner={false} />
      </>
    );
  }

  // Disabled portal accounts get a clear message instead of empty pages.
  // The switcher goes here too: somebody switched off by this shop, but invited
  // by another one, would otherwise be stuck on this screen with no way to
  // accept and get out.
  if (!profile?.is_active) {
    return (
      <>
      <ShopSwitcher memberships={memberships} />
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
      </>
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
      <ShopSwitcher memberships={memberships} />
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <Link href="/portal" className="text-xl font-bold text-gray-900">ShopWorks</Link>
            {customerName && <p className="text-xs text-gray-500">{customerName}</p>}
          </div>
          <div className="flex items-center gap-4">
            <Link href="/portal" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium">Jobs<UnreadNavBadge side="customer" /></Link>
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
