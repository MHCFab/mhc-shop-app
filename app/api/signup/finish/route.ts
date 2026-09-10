// ---------------------------------------------------------------------------
// Step two: the link in the email was clicked and a password was chosen.
//
// THIS is where a shop actually comes into existence, and the ORDER BELOW IS
// NOT NEGOTIABLE:
//
//   1. the shop
//   2. an employee_invitations row for this email
//   3. the login
//   4. promote them to admin
//
// Steps 1 and 2 have to happen before step 3 because of the hardened trigger
// on the login table: it refuses to create any account that does not already
// have a pending invitation row, and it takes the shop from that row rather
// than from anything the browser said. That is what stops a stranger signing
// themselves into somebody else's shop, and it means our own signup has to
// write its own authorising row first, exactly as the invite routes do.
//
// Step 4 is separate because the trigger has NO BRANCH that can produce an
// admin - by design, so that no signup request can ever ask to be one. The
// promotion is done here, by the server, for a shop this route just created a
// second ago and therefore knows is empty.
//
// ⚠️ THE PROMOTION WRITES TO memberships, NOT TO profiles. profiles is a
// pointer at the membership that is active now, kept honest by a trigger.
// Writing 'admin' onto profiles appears to work and then silently reverts the
// shop owner to an employee the next time anything touches their memberships.
// Proven both ways before this was written. Do not "simplify" this.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { sendOwnerAlertEmail, appBaseUrl } from "@/app/lib/email";

const TRIAL_DAYS = 14;
const MIN_PASSWORD = 8;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const token = String(body?.token ?? "").trim();
    const password = String(body?.password ?? "");

    if (!token) {
      return NextResponse.json({ error: "Missing link." }, { status: 400 });
    }
    if (password.length < MIN_PASSWORD) {
      return NextResponse.json(
        { error: "Please choose a password of at least " + MIN_PASSWORD + " characters." },
        { status: 400 }
      );
    }

    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const tokenHash = createHash("sha256").update(token).digest("hex");

    const { data: signup } = await admin
      .from("shop_signups")
      .select("id, shop_name, full_name, email, expires_at, confirmed_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (!signup || signup.confirmed_at || new Date(signup.expires_at) <= new Date()) {
      return NextResponse.json(
        {
          error:
            "That link has expired or has already been used. Start again and we'll send a new one.",
        },
        { status: 400 }
      );
    }

    const email = String(signup.email).toLowerCase().trim();

    // Between the two steps somebody could have been invited to a shop with
    // this address. Check again rather than trip over it below.
    const { data: taken } = await admin
      .from("profiles")
      .select("id")
      .eq("email", email)
      .limit(1);

    if (taken && taken.length > 0) {
      return NextResponse.json(
        {
          error:
            "That email address now has a ShopWorks login. Sign in instead - you can start a shop from inside the app.",
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------------- 1
    const trialEnds = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const { data: company, error: companyError } = await admin
      .from("companies")
      .insert({
        name: signup.shop_name,
        subscription_status: "trialing",
        trial_ends_at: trialEnds.toISOString(),
      })
      .select("id, name")
      .single();

    if (companyError || !company) {
      return NextResponse.json(
        { error: "Could not create the shop: " + (companyError?.message || "unknown error") },
        { status: 500 }
      );
    }

    // ---------------------------------------------------------------- 2
    const { data: invitation, error: inviteError } = await admin
      .from("employee_invitations")
      .insert({
        company_id: company.id,
        email,
        full_name: signup.full_name,
        status: "pending",
      })
      .select("id")
      .single();

    if (inviteError || !invitation) {
      await admin.from("companies").delete().eq("id", company.id);
      return NextResponse.json(
        { error: "Could not authorise the account: " + (inviteError?.message || "unknown error") },
        { status: 500 }
      );
    }

    // ---------------------------------------------------------------- 3
    const { data: created, error: userError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // they just proved the address by clicking the link
      user_metadata: { full_name: signup.full_name, role: "employee" },
    });

    if (userError || !created?.user) {
      await admin.from("employee_invitations").delete().eq("id", invitation.id);
      await admin.from("companies").delete().eq("id", company.id);
      return NextResponse.json(
        { error: "Could not create the login: " + (userError?.message || "unknown error") },
        { status: 500 }
      );
    }

    const userId = created.user.id;

    // ---------------------------------------------------------------- 4
    // Write the ROLE to memberships and let the sync trigger carry it onto
    // profiles. See the note at the top of this file.
    //
    // .select("id") and the length check are not decoration: a write that
    // matches no rows comes back with no error at all, which is how a broken
    // flow once hid for over a month.
    const { data: promoted, error: promoteError } = await admin
      .from("memberships")
      .update({ role: "admin" })
      .eq("user_id", userId)
      .eq("company_id", company.id)
      .select("id");

    if (promoteError || !promoted || promoted.length === 0) {
      // They would be an employee in their own brand new shop, with no admin
      // anywhere and no way to fix it themselves. Undo the whole thing.
      await admin.auth.admin.deleteUser(userId);
      await admin.from("employee_invitations").delete().eq("id", invitation.id);
      await admin.from("companies").delete().eq("id", company.id);
      return NextResponse.json(
        {
          error:
            "Could not finish setting up your account: " +
            (promoteError?.message || "the shop owner could not be set") +
            ". Nothing was left behind - please try again.",
        },
        { status: 500 }
      );
    }

    // Bookkeeping. Neither of these is worth failing the signup over - the
    // shop and the login are real and working by this point.
    await admin
      .from("employee_invitations")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", invitation.id);

    await admin
      .from("shop_signups")
      .update({ confirmed_at: new Date().toISOString(), company_id: company.id })
      .eq("id", signup.id);

    await sendOwnerAlertEmail({
      subject: "ShopWorks: new shop signed up - " + company.name,
      lines: [
        "A new shop just started a 14-day trial.",
        "",
        "Shop: " + company.name,
        "Owner: " + (signup.full_name || "(no name given)"),
        "Email: " + email,
        "Trial ends: " + trialEnds.toISOString(),
        "",
        "They came through the self-serve signup form at " +
          appBaseUrl(req.headers.get("origin")) +
          "/signup",
      ],
    });

    // The browser signs in with this and the password it already has.
    return NextResponse.json({ success: true, email, shopName: company.name });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
