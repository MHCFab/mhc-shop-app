// ---------------------------------------------------------------------------
// Intuit sends the browser back here after "Connect QuickBooks".
// QUICKBOOKS-CALLBACK-V1
//
// ⚠️ The address of this route must be registered EXACTLY (www, https, no
// trailing slash) under Redirect URIs in the Intuit app, and must match
// QBO_REDIRECT_URI. Intuit refuses any other.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import {
  QBO_STATE_COOKIE,
  companyName,
  exchangeCode,
  financeUser,
  qboConfig,
  saveConnection,
  seal,
  serviceClient,
  type ConnectionRow,
} from "@/app/lib/quickbooks";

function done(req: NextRequest, ok: boolean, msg?: string) {
  const url = new URL("/admin/finance", req.url);
  url.searchParams.set("qb", ok ? "connected" : "error");
  if (msg) url.searchParams.set("msg", msg);
  const res = NextResponse.redirect(url);
  res.cookies.set(QBO_STATE_COOKIE, "", { path: "/api/quickbooks", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const cfg = qboConfig();
  if (!cfg) return done(req, false, "QuickBooks isn't set up on this server yet.");

  const p = req.nextUrl.searchParams;
  if (p.get("error")) {
    return done(req, false, p.get("error") === "access_denied" ? "QuickBooks wasn't connected - access was declined." : "QuickBooks said: " + p.get("error"));
  }
  const code = p.get("code");
  const state = p.get("state");
  const realmId = p.get("realmId");
  if (!code || !state || !realmId) return done(req, false, "QuickBooks didn't send everything back. Try Connect again.");

  const who = await financeUser();
  if (!who.ok) return done(req, false, who.error);

  const cookie = req.cookies.get(QBO_STATE_COOKIE)?.value || "";
  const [cookieState, cookieUser] = cookie.split(".");
  if (!cookieState || cookieState !== state || cookieUser !== who.user.userId) {
    return done(req, false, "That sign-in link had expired or didn't start here. Click Connect QuickBooks again.");
  }

  try {
    const tokens = await exchangeCode(cfg, code);
    const admin = serviceClient();
    // Ask QuickBooks for the company's name with the fresh token, so the page
    // can say which company is connected.
    const temp: ConnectionRow = {
      company_id: who.user.companyId,
      environment: cfg.environment,
      realm_id: realmId,
      company_name: null,
      access_token_enc: seal(cfg.key, tokens.access_token),
      access_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
      refresh_token_enc: seal(cfg.key, tokens.refresh_token),
      refresh_expires_at: null,
      connected_at: new Date().toISOString(),
    };
    const name = await companyName(cfg, admin, temp);
    await saveConnection(cfg, admin, {
      companyId: who.user.companyId,
      userId: who.user.userId,
      realmId,
      tokens,
      companyName: name,
    });
  } catch (e) {
    return done(req, false, e instanceof Error ? e.message : "Could not finish connecting QuickBooks.");
  }
  return done(req, true);
}
