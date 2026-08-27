import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export async function POST(req: NextRequest) {
  try {
    const { customerId, email, fullName } = await req.json();

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required." }, { status: 400 });
    }
    if (!customerId || typeof customerId !== "string") {
      return NextResponse.json({ error: "Customer is required." }, { status: 400 });
    }

    // First, verify the caller is an authenticated admin using the normal SSR client
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {
            // no-op in route handler
          },
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
      return NextResponse.json({ error: "Only admins can invite portal users." }, { status: 403 });
    }

    const companyId = profile.company_id;
    const normalizedEmail = email.toLowerCase().trim();

    // Verify the customer exists and belongs to this company (the RLS-scoped
    // read only returns customers of the caller's company)
    const { data: customer } = await supabase
      .from("customers")
      .select("id, name")
      .eq("id", customerId)
      .single();

    if (!customer) {
      return NextResponse.json({ error: "Customer not found." }, { status: 404 });
    }

    // ------------------------------------------------------------------
    // Record the invitation BEFORE sending it.
    //
    // Sending the invite is what creates the login, and creating the login
    // fires the handle_new_user trigger in the database. That trigger now
    // refuses to create an account unless a pending invitation already exists
    // for this email address, and it takes the shop and the customer from
    // that row rather than from the invite - that is what stops anyone from
    // signing themselves up into someone else's shop. So the row has to be in
    // place first, or our own invites would be refused.
    // ------------------------------------------------------------------
    const { data: invitationRow, error: trackError } = await supabase
      .from("customer_invitations")
      .insert({
        company_id: companyId,
        customer_id: customerId,
        email: normalizedEmail,
        full_name: fullName || null,
        invited_by: user.id,
        status: "pending",
      })
      .select("id")
      .single();

    if (trackError || !invitationRow) {
      return NextResponse.json(
        {
          error:
            "Could not record the invitation, so the invite was not sent: " +
            (trackError?.message || "unknown error"),
        },
        { status: 400 }
      );
    }

    // Now use the service role client to send the invite
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Determine the redirect URL for the invite link.
    const headerOrigin = req.headers.get("origin");
    const envUrl = process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "");
    let base = (headerOrigin || envUrl || "").trim();
    // Strip any trailing slash so we don't end up with a double slash
    base = base.replace(/\/+$/, "");
    const redirectTo = base + "/accept-invite";

    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(normalizedEmail, {
      data: {
        full_name: fullName || null,
        role: "customer",
        company_id: companyId,
        customer_id: customerId,
      },
      redirectTo,
    });

    if (inviteError) {
      // The email never went out, so clean up the row we just wrote rather
      // than leaving a pending invitation nobody can use.
      await supabase.from("customer_invitations").delete().eq("id", invitationRow.id);
      return NextResponse.json({ error: inviteError.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, userId: invited.user?.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
