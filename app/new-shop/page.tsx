// ---------------------------------------------------------------------------
// "Start a new shop" for somebody who already has a ShopWorks login.
//
// This page is reachable by a customer portal login as well as by shop staff,
// which is why it sits at the top level rather than under /admin - the whole
// point is that somebody like a purchaser at a customer's shop, who only has a
// portal account today, can start their own shop without a second email
// address.
//
// It checks for a signed-in person itself rather than relying on the
// middleware, because it is listed as a public path there for exactly the
// reason above.
// ---------------------------------------------------------------------------

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "../lib/supabase-server";
import NewShopForm from "./NewShopForm";

export default async function NewShopPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .single();

  return <NewShopForm name={(profile?.full_name as string) || ""} />;
}
