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

    // Verify the target is a CUSTOMER login IN THE CALLER'S OWN SHOP.
    // This route can never delete an admin or employee account.
    //
    // The role now comes from their membership here rather than from their
    // profile, because a profile's role is only their role in whichever shop
    // they are looking at right now - and someone who belongs to two shops
    // could be a portal customer here and an admin somewhere else.
    const { data: membership } = await supabase
      .from("memberships")
      .select("id, role")
      .eq("user_id", profileId)
      .eq("company_id", profile.company_id)
      .single();

    if (!membership) {
      return NextResponse.json({ error: "Portal user not found in your company." }, { status: 404 });
    }
    if (membership.role !== "customer") {
      return NextResponse.json({ error: "That account is not a customer portal login." }, { status: 400 });
    }

    // Their email address, for cancelling any invitation still hanging around.
    const { data: target } = await supabase
      .from("profiles")
      .select("id, email")
      .eq("id", profileId)
      .single();

    // The service role client, because the next question - does this person
    // belong to any OTHER shop? - is one the caller is deliberately not allowed
    // to see the answer to through the normal rules.
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: others, error: othersErr } = await admin
      .from("memberships")
      .select("id")
      .eq("user_id", profileId)
      .neq("company_id", profile.company_id)
      .in("status", ["active", "pending"]);

    if (othersErr) {
      return NextResponse.json({ error: othersErr.message }, { status: 400 });
    }

    let detached = false;

    if (others && others.length > 0) {
      // They belong to another shop as well. Take away their portal access
      // here and leave the person's login alone.
      const { data: gone, error: detachErr } = await admin
        .from("memberships")
        .delete()
        .eq("id", membership.id)
        .select("id");

      if (detachErr) {
        return NextResponse.json({ error: detachErr.message }, { status: 400 });
      }
      if (!gone || gone.length === 0) {
        return NextResponse.json({ error: "Nothing was removed. Please try again." }, { status: 400 });
      }
      detached = true;
    } else {
      // This was the only shop they belonged to, so the login itself goes.
      const { error: delErr } = await admin.auth.admin.deleteUser(profileId);
      if (delErr) {
        return NextResponse.json({ error: delErr.message }, { status: 400 });
      }

      // Clean up the profile row in case it isn't cascade-deleted
      await admin.from("profiles").delete().eq("id", profileId);
    }

    // Mark any still-pending invitation for this email as cancelled,
    // so the list doesn't show a ghost "awaiting password" entry.
    if (target?.email) {
      await supabase
        .from("customer_invitations")
        .update({ status: "cancelled" })
        .eq("email", target.email.toLowerCase())
        .eq("status", "pending");
    }

    return NextResponse.json({ success: true, detached });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
