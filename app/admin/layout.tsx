import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "../lib/supabase-server";
import NavBar from "../components/NavBar";
import ShopSwitcher, { type Membership } from "../components/ShopSwitcher";
import ShopLockedScreen from "../components/ShopLockedScreen";
import TrialBanner from "../components/TrialBanner";
import { checkShopAccess } from "../lib/shop-access";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  let profile = null;
  let company = null;

  const { data: profileData } = await supabase
    .from("profiles")
    .select("email, full_name, role, company_id")
    .eq("id", user.id)
    .single();
  profile = profileData;

  // Employees can't access admin
  if (profile?.role !== "admin") {
    redirect("/floor");
  }

  if (profileData?.company_id) {
    const { data: companyData } = await supabase
      .from("companies")
      .select("name")
      .eq("id", profileData.company_id)
      .single();
    company = companyData;
  }

  // Which shops this person belongs to. Renders nothing at all unless they
  // belong to more than one, or another shop has asked to add them.
  const { data: membershipRows } = await supabase.rpc("my_memberships");

  // Is this shop paid up? Asked once, here, so that no individual admin
  // screen has to think about it. A shop we cannot get an answer about is
  // treated as fine - see app/lib/shop-access.ts for why.
  const access = await checkShopAccess(supabase);

  if (access?.state === "locked") {
    // The switcher stays above the locked screen on purpose: somebody whose
    // OTHER shop is perfectly fine must not be stranded here with no way out.
    return (
      <>
        <ShopSwitcher memberships={(membershipRows || []) as unknown as Membership[]} />
        <ShopLockedScreen isOwner shopName={access.shopName} />
      </>
    );
  }

  return (
    <>
      <ShopSwitcher memberships={(membershipRows || []) as unknown as Membership[]} />
      {access?.state === "trial" && <TrialBanner daysLeft={access.daysLeft} />}
      {profile && <NavBar profile={profile} company={company} />}
      <main>{children}</main>
    </>
  );
}