import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export async function POST(req: NextRequest) {
  try {
    const { profileId } = await req.json();

    if (!profileId || typeof profileId !== "string") {
      return NextResponse.json({ error: "Portal user ID is required." }, { status: 400 });
    }

    // Verify the caller is an authenticated admin
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {},
        },
      }
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role, company_id")
      .eq("id", user.id)
      .single();

    if (!profile || profile.role !== "admin") {
      return NextResponse.json({ error: "Only admins can remove portal users." }, { status: 403 });
    }

    // Verify the target is a CUSTOMER login in the same company.
    // This route can never delete an admin or employee account.
    const { data: target } = await supabase
      .from("profiles")
      .select("id, email, company_id, role, customer_id")
      .eq("id", profileId)
      .single();

    if (!target || target.company_id !== profile.company_id) {
      return NextResponse.json({ error: "Portal user not found in your company." }, { status: 404 });
    }
    if (target.role !== "customer") {
      return NextResponse.json({ error: "That account is not a customer portal login." }, { status: 400 });
    }

    // Use the service role client to delete the auth user.
    // Their profile row is removed via the auth user deletion cascade (or we clean it up after).
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { error: delErr } = await admin.auth.admin.deleteUser(profileId);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 400 });
    }

    // Clean up the profile row in case it isn't cascade-deleted
    await admin.from("profiles").delete().eq("id", profileId);

    // Mark any still-pending invitation for this email as cancelled,
    // so the list doesn't show a ghost "awaiting password" entry.
    if (target.email) {
      await supabase
        .from("customer_invitations")
        .update({ status: "cancelled" })
        .eq("email", target.email.toLowerCase())
        .eq("status", "pending");
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
