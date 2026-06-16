import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "../lib/supabase-server";
import NavBar from "../components/NavBar";

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

  return (
    <>
      {profile && <NavBar profile={profile} company={company} />}
      <main>{children}</main>
    </>
  );
}