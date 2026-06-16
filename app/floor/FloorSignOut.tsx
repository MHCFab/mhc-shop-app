"use client";

import { useRouter } from "next/navigation";
import { createClient } from "../lib/supabase";

export default function FloorSignOut() {
  const router = useRouter();
  const supabase = createClient();

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <button onClick={signOut} className="text-sm text-gray-600 hover:text-gray-900 font-medium">
      Sign out
    </button>
  );
}