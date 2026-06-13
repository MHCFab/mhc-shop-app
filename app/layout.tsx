import type { Metadata } from "next";
import "./globals.css";
import { createServerSupabaseClient } from "./lib/supabase-server";
import NavBar from "./components/NavBar";

export const metadata: Metadata = {
  title: "MHC Shop App",
  description: "Shop management software for MHC Fab",
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
  if (user) {
    const { data } = await supabase
      .from("profiles")
      .select("email, full_name, role")
      .eq("id", user.id)
      .single();
    profile = data;
  }

  return (
    <html lang="en">
      <body className="bg-gray-50 min-h-screen">
        {profile && <NavBar profile={profile} />}
        <main>{children}</main>
      </body>
    </html>
  );
}