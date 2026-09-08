import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export async function POST(req: NextRequest) {
  try {
    const { employeeId } = await req.json();

    if (!employeeId || typeof employeeId !== "string") {
      return NextResponse.json({ error: "Employee ID is required." }, { status: 400 });
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
      return NextResponse.json({ error: "Only admins can remove employees." }, { status: 403 });
    }

    // Don't allow deleting yourself
    if (employeeId === user.id) {
      return NextResponse.json({ error: "You can't remove your own account." }, { status: 400 });
    }

    // Find the target's membership IN THE CALLER'S OWN SHOP. This is the check
    // that used to compare profile.company_id, which no longer means what it
    // used to: a profile's company is only whichever shop that person is
    // looking at right now, and someone who belongs to two shops could be
    // looking at the other one.
    const { data: membership } = await supabase
      .from("memberships")
      .select("id, role")
      .eq("user_id", employeeId)
      .eq("company_id", profile.company_id)
      .single();

    if (!membership) {
      return NextResponse.json({ error: "Employee not found in your company." }, { status: 404 });
    }

    // Customer portal logins are not employees. They are removed from the
    // Customers page, which also clears their link to the customer record.
    if (membership.role === "customer") {
      return NextResponse.json(
        { error: "That is a customer portal login. Remove it from the Customers page instead." },
        { status: 400 }
      );
    }

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
      .eq("user_id", employeeId)
      .neq("company_id", profile.company_id)
      .in("status", ["active", "pending"]);

    if (othersErr) {
      return NextResponse.json({ error: othersErr.message }, { status: 400 });
    }

    // They work somewhere else too: detach them from this shop and leave the
    // person alone. A database trigger moves their active shop to the one they
    // still belong to.
    if (others && others.length > 0) {
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

      return NextResponse.json({ success: true, detached: true });
    }

    // This was the only shop they belonged to, so the login itself goes.
    // Deleting the auth user cascades to their memberships and their profile.
    const { error: delErr } = await admin.auth.admin.deleteUser(employeeId);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 400 });
    }

    // Clean up the profile row in case it isn't cascade-deleted
    await admin.from("profiles").delete().eq("id", employeeId);

    return NextResponse.json({ success: true, detached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}