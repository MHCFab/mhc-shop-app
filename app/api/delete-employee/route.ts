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

    // Verify the target employee is in the same company
    const { data: target } = await supabase
      .from("profiles")
      .select("id, company_id, role")
      .eq("id", employeeId)
      .single();

    if (!target || target.company_id !== profile.company_id) {
      return NextResponse.json({ error: "Employee not found in your company." }, { status: 404 });
    }

    // Use the service role client to delete the auth user.
    // Their profile row is removed via the auth user deletion cascade (or we clean it up after).
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { error: delErr } = await admin.auth.admin.deleteUser(employeeId);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 400 });
    }

    // Clean up the profile row in case it isn't cascade-deleted
    await admin.from("profiles").delete().eq("id", employeeId);

    return NextResponse.json({ success: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}