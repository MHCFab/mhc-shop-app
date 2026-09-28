// ---------------------------------------------------------------------------
// "Connect QuickBooks" - sends the browser to Intuit's sign-in page.
// QUICKBOOKS-CONNECT-V1
//
// A random `state` goes to Intuit and into a short-lived cookie, tied to the
// person who clicked. The callback refuses anything that does not come back
// with the same state for the same person - that is what stops somebody else
// from attaching THEIR QuickBooks to your shop with a crafted link.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { QBO_STATE_COOKIE, authorizeUrl, financeUser, qboConfig } from "@/app/lib/quickbooks";

function back(req: NextRequest, msg: string) {
  const url = new URL("/admin/finance", req.url);
  url.searchParams.set("qb", "error");
  url.searchParams.set("msg", msg);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const cfg = qboConfig();
  if (!cfg) return back(req, "QuickBooks isn't set up on this server yet.");

  const who = await financeUser();
  if (!who.ok) return back(req, who.error);

  const state = crypto.randomBytes(24).toString("hex");
  const res = NextResponse.redirect(authorizeUrl(cfg, state));
  res.cookies.set(QBO_STATE_COOKIE, state + "." + who.user.userId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/quickbooks",
    maxAge: 600,
  });
  return res;
}
