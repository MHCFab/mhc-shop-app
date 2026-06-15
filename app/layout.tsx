import type { Metadata } from "next";
import "./globals.css";
import { createServerSupabaseClient } from "./lib/supabase-server";
import NavBar from "./components/NavBar";

export const metadata: Metadata = {
  title: "ShopWorks",
  description: "Shop management software for manufacturers",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let profile = null;
  let company = null;
  if (user) {
    const { data: profileData } = await supabase
      .from("profiles")
      .select("email, full_name, role, company_id")
      .eq("id", user.id)
      .single();
    profile = profileData;

    if (profileData?.company_id) {
      const { data: companyData } = await supabase
        .from("companies")
        .select("name")
        .eq("id", profileData.company_id)
        .single();
      company = companyData;
    }
  }

  return (
    <html lang="en">
      <body className="bg-gray-50 min-h-screen">
        {profile && <NavBar profile={profile} company={company} />}
        <main>{children}</main>
      </body>
    </html>
  );
}