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
    // Does this email already have a ShopWorks login?
    //
    // Supabase refuses to "invite" an address that already has an account, so
    // before memberships this simply failed. Now it means something different:
    // the person exists, and what we are really asking is for them to join a
    // second shop. That is a request they have to accept, not something this
    // shop can do to them - so we write a PENDING membership, which grants
    // nothing until they say yes.
    //
    // The lookup uses the service role because a person who belongs to another
    // shop is deliberately invisible to this one under the normal rules. The
    // WRITE below goes back through the caller's own permissions, so it can
    // still only ever touch this shop.
    //
    // ilike, with the wildcard characters escaped, so this is an exact
    // case-insensitive match rather than a pattern. An underscore in an email
    // address is common and would otherwise match the wrong person.
    // ------------------------------------------------------------------
    const lookup = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Exact match first. Logins are stored lowercased, so this is the answer
    // almost every time, and it has no pattern semantics to get wrong.
    let existingUserId: string | null = null;

    const { data: exactRows } = await lookup
      .from("profiles")
      .select("id")
      .eq("email", normalizedEmail)
      .limit(1);

    if (exactRows && exactRows.length > 0) {
      existingUserId = exactRows[0].id as string;
    }

    // Only if that missed, try again ignoring case. The wildcard characters are
    // escaped so this stays an exact match rather than becoming a pattern - an
    // underscore in an email address is common, and unescaped it would happily
    // match a completely different person.
    if (!existingUserId) {
      const escapedEmail = normalizedEmail.replace(/([\\%_])/g, "\\$1");
      const { data: looseRows } = await lookup
        .from("profiles")
        .select("id")
        .ilike("email", escapedEmail)
        .limit(1);
      if (looseRows && looseRows.length > 0) {
        existingUserId = looseRows[0].id as string;
      }
    }

    if (existingUserId) {
      // Where do they stand with THIS shop already?
      const { data: already } = await supabase
        .from("memberships")
        .select("id, status")
        .eq("user_id", existingUserId)
        .eq("company_id", companyId)
        .maybeSingle();

      // One more question, and it matters: is this somebody we invited to THIS
      // shop who simply has not set their password yet? Sending an invite
      // creates the login immediately, so those people already have an account
      // and an active membership here - and the Resend button has to keep
      // working for them rather than being told they are already on the team.
      const { data: openInvite } = await supabase
        .from("customer_invitations")
        .select("id")
        .eq("email", normalizedEmail)
        .eq("status", "pending")
        .limit(1);

      const stillSettingUp = !!(openInvite && openInvite.length > 0);

      if (already?.status === "active" && stillSettingUp) {
        // They belong here already and are just waiting to set a password.
        // Fall through to the ordinary invite path so the email goes again.
      } else if (already?.status === "active") {
        return NextResponse.json(
          { error: "That person already has portal access here." },
          { status: 400 }
        );
      } else if (already?.status === "pending") {
        return NextResponse.json({
          success: true,
          pendingMembership: true,
          alreadyAsked: true,
        });
      } else if (already) {
        // An old membership that was switched off or declined: ask again.
        const { data: revived, error: reviveError } = await supabase
          .from("memberships")
          .update({ status: "pending", role: "customer", customer_id: customerId, invited_by: user.id })
          .eq("id", already.id)
          .select("id");
        if (reviveError) {
          return NextResponse.json({ error: reviveError.message }, { status: 400 });
        }
        if (!revived || revived.length === 0) {
          return NextResponse.json({ error: "Could not record the request. Please try again." }, { status: 400 });
        }
      } else {
        const { data: created, error: createError } = await supabase
          .from("memberships")
          .insert({
            user_id: existingUserId,
            company_id: companyId,
            role: "customer",
            customer_id: customerId,
            status: "pending",
            invited_by: user.id,
          })
          .select("id");
        if (createError) {
          return NextResponse.json({ error: createError.message }, { status: 400 });
        }
        if (!created || created.length === 0) {
          return NextResponse.json({ error: "Could not record the request. Please try again." }, { status: 400 });
        }
      }

      // No email goes out. Supabase will not mail an address that already has
      // an account, and ShopWorks has no mail of its own yet - so they will see
      // the request in the app the next time they sign in, and the person
      // inviting them is told to say so.
      if (!(already?.status === "active" && stillSettingUp)) {
        return NextResponse.json({ success: true, pendingMembership: true });
      }
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
