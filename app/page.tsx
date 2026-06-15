import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "./lib/supabase-server";

export default async function HomePage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role === "admin") {
    redirect("/admin");
  }

  // Employees will eventually land on a job board view (Phase 4/5).
  // For now, show a simple placeholder.
  return (
    <div className="max-w-3xl mx-auto px-4 py-12 text-center">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Welcome to ShopWorks</h1>
      <p className="text-gray-600">
        Your job board is coming soon. Sit tight while we finish setting things up.
      </p>
    </div>
  );
}