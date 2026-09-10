// ---------------------------------------------------------------------------
// Step one of signing up a new shop.
//
// Somebody fills in the form. This route writes ONE row - a pending signup -
// and emails them a link. That is all. No shop, no login, no password. If they
// never click the link, all that exists is a row that expires on its own.
//
// The order matters and it is the opposite of what feels natural: we do not
// create anything real until we know the email address works. That is what
// keeps junk and typo addresses from becoming shops we cannot contact.
//
// This route ALWAYS gives the same answer, whether or not that email already
// has a ShopWorks login. Anything else turns the signup form into a way of
// asking "does this person have an account here?", which is not a question a
// stranger gets to ask. When the address IS already known, we send a different
// email to that address instead - which is where it belongs.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import {
  sendSignupConfirmationEmail,
  sendSignupExistingAccountEmail,
  appBaseUrl,
} from "@/app/lib/email";

// How long the link in the email is good for.
const LINK_HOURS = 24;

// How many times one address may ask for a link in an hour before we stop
// sending. They still get the same reply - they just stop getting email.
const MAX_PER_HOUR = 3;

// The same reply in every case that is not an outright bad request.
const SAME_ANSWER = {
  success: true,
  message:
    "Check your email. If we can set up a shop for that address, there is a link waiting.",
};

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const shopName = String(body?.shopName ?? "").trim();
    const fullName = String(body?.fullName ?? "").trim();
    const rawEmail = String(body?.email ?? "").trim();
    const email = rawEmail.toLowerCase();

    if (shopName.length < 2 || shopName.length > 100) {
      return NextResponse.json(
        { error: "Please enter your shop's name." },
        { status: 400 }
      );
    }
    if (fullName.length < 2 || fullName.length > 100) {
      return NextResponse.json(
        { error: "Please enter your name." },
        { status: 400 }
      );
    }
    if (!looksLikeEmail(email) || email.length > 200) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    // Everything below runs with the service role, because none of it belongs
    // to a signed-in person - there is no signed-in person yet. Nothing from
    // the browser is ever used as a shop id or a role.
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const base = appBaseUrl(req.headers.get("origin"));

    // ------------------------------------------------------------------
    // Does this address already have a login? Same lookup the invite routes
    // use: exact match first, then a case-insensitive one with the wildcard
    // characters escaped, because an underscore in an email address is common
    // and unescaped it would match the wrong person.
    // ------------------------------------------------------------------
    let existing = false;

    const { data: exactRows } = await admin
      .from("profiles")
      .select("id")
      .eq("email", email)
      .limit(1);

    if (exactRows && exactRows.length > 0) {
      existing = true;
    } else {
      const escaped = email.replace(/([\\%_])/g, "\\$1");
      const { data: looseRows } = await admin
        .from("profiles")
        .select("id")
        .ilike("email", escaped)
        .limit(1);
      if (looseRows && looseRows.length > 0) {
        existing = true;
      }
    }

    if (existing) {
      // Point them at the door they already have a key to, and give the
      // browser the same answer as everyone else.
      await sendSignupExistingAccountEmail({ to: email, shopName, appUrl: base });
      return NextResponse.json(SAME_ANSWER);
    }

    // ------------------------------------------------------------------
    // Slow down anybody hammering the form with one address.
    // ------------------------------------------------------------------
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentCount } = await admin
      .from("shop_signups")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", anHourAgo);

    if ((recentCount ?? 0) >= MAX_PER_HOUR) {
      return NextResponse.json(SAME_ANSWER);
    }

    // Any earlier link for this address stops working now. Asking again should
    // not leave two live links in two different inboxes.
    await admin
      .from("shop_signups")
      .update({ expires_at: new Date().toISOString() })
      .eq("email", email)
      .is("confirmed_at", null);

    // ------------------------------------------------------------------
    // The token goes in the email. Only its HASH goes in the database, so a
    // copy of that table is not a set of working links.
    // ------------------------------------------------------------------
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + LINK_HOURS * 60 * 60 * 1000);

    const { data: row, error: insertError } = await admin
      .from("shop_signups")
      .insert({
        shop_name: shopName,
        full_name: fullName,
        email,
        token_hash: tokenHash,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .single();

    if (insertError || !row) {
      return NextResponse.json(
        {
          error:
            "Could not start the signup: " +
            (insertError?.message || "unknown error"),
        },
        { status: 500 }
      );
    }

    const confirmUrl = base + "/signup/confirm?token=" + encodeURIComponent(token);

    const mail = await sendSignupConfirmationEmail({
      to: email,
      shopName,
      fullName,
      confirmUrl,
    });

    if (!mail.ok) {
      // The link is the only way in, so a signup whose email never sent is a
      // dead end. Clear it out and say so plainly rather than leaving them
      // watching an inbox.
      await admin.from("shop_signups").delete().eq("id", row.id);
      return NextResponse.json(
        {
          error:
            "We could not send the confirmation email (" +
            mail.error +
            "). Nothing was created - please try again.",
        },
        { status: 502 }
      );
    }

    return NextResponse.json(SAME_ANSWER);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
