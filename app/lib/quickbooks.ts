// ---------------------------------------------------------------------------
// QuickBooks Online, server side only. QUICKBOOKS-LIB-V1
//
// ⚠️ NEVER import this from a "use client" file. It reads the Intuit client
// secret, the token-scrambling key and the Supabase service role key.
//
// THE SHAPE OF IT
// * Each shop connects its OWN QuickBooks company (Intuit calls it a "realm").
//   The login tokens live in quickbooks_connections, which no browser login
//   can read at all - only this server code, through the service role.
// * The tokens are scrambled (AES-256-GCM) with QBO_TOKEN_KEY before they are
//   stored, so a copy of the database on its own opens nobody's QuickBooks.
// * An access token lasts an hour. When it is nearly up we trade the refresh
//   token for a new pair and store BOTH - Intuit hands out a new refresh token
//   from time to time and the old one stops working after that.
// * Every route checks the person is signed in, is a finance person for their
//   shop, and that the shop has Finances switched on - the same rule the
//   database applies to finance_settings and finance_months.
//
// ENVIRONMENT (Vercel, and .env.local for a local test):
//   QBO_CLIENT_ID, QBO_CLIENT_SECRET  - from the app on developer.intuit.com
//   QBO_ENVIRONMENT                   - "sandbox" or "production"
//   QBO_REDIRECT_URI                  - exactly as registered with Intuit,
//                                       e.g. https://www.shopworks.app/api/quickbooks/callback
//   QBO_TOKEN_KEY                     - 32 random bytes, base64
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "./supabase-server";

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_STATE_COOKIE = "qbo_oauth_state";
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
// Intuit retired minor versions below 75 in August 2025.
const MINOR_VERSION = "75";

export type QboEnv = "sandbox" | "production";

export type QboConfig = {
  clientId: string;
  clientSecret: string;
  environment: QboEnv;
  redirectUri: string;
  key: Buffer;
};

// null when anything is missing, so the page can say "not set up yet"
// instead of throwing.
export function qboConfig(): QboConfig | null {
  const clientId = process.env.QBO_CLIENT_ID?.trim();
  const clientSecret = process.env.QBO_CLIENT_SECRET?.trim();
  const environment = (process.env.QBO_ENVIRONMENT?.trim() || "sandbox") as QboEnv;
  const redirectUri = process.env.QBO_REDIRECT_URI?.trim();
  const keyText = process.env.QBO_TOKEN_KEY?.trim();
  if (!clientId || !clientSecret || !redirectUri || !keyText) return null;
  if (environment !== "sandbox" && environment !== "production") return null;
  const key = Buffer.from(keyText, "base64");
  if (key.length !== 32) return null;
  return { clientId, clientSecret, environment, redirectUri, key };
}

function apiBase(env: QboEnv) {
  return env === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

// ---- scrambling the tokens ---------------------------------------------------

export function seal(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function unseal(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Stored QuickBooks token is not in a format this server understands.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// ---- who is asking -------------------------------------------------------------

export type FinanceUser = { userId: string; companyId: string };

// The same rule as the database: signed in, an active admin of this shop with
// finance access, and the shop has the Finances page switched on.
export async function financeUser(): Promise<{ ok: true; user: FinanceUser } | { ok: false; status: number; error: string }> {
  const supabase = await createServerSupabaseClient();
  const { data: u } = await supabase.auth.getUser();
  const userId = u.user?.id;
  if (!userId) return { ok: false, status: 401, error: "Please sign in again." };

  const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", userId).single();
  const companyId = (profile?.company_id as string | undefined) ?? null;
  if (!companyId) return { ok: false, status: 403, error: "No shop on this login." };

  const { data: allowed, error: accErr } = await supabase.rpc("has_finance_access");
  if (accErr || !allowed) return { ok: false, status: 403, error: "You don't have access to the shop's finances." };

  const { data: co } = await supabase.from("companies").select("finance_enabled").eq("id", companyId).single();
  if (!co?.finance_enabled) return { ok: false, status: 403, error: "The Finances page is switched off for this shop." };

  return { ok: true, user: { userId, companyId } };
}

export function serviceClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---- OAuth -----------------------------------------------------------------------

export function authorizeUrl(cfg: QboConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: cfg.redirectUri,
    state,
  });
  return AUTHORIZE_URL + "?" + q.toString();
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  x_refresh_token_expires_in?: number; // seconds
};

async function tokenCall(cfg: QboConfig, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(cfg.clientId + ":" + cfg.clientSecret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      reason = j.error_description || j.error || reason;
    } catch {
      // keep the raw text
    }
    const err = new Error("QuickBooks refused the sign-in (" + res.status + "): " + reason);
    (err as Error & { invalidGrant?: boolean }).invalidGrant = /invalid_grant/i.test(text);
    throw err;
  }
  return JSON.parse(text) as TokenResponse;
}

export function exchangeCode(cfg: QboConfig, code: string) {
  return tokenCall(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });
}

export async function revokeToken(cfg: QboConfig, token: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(cfg.clientId + ":" + cfg.clientSecret).toString("base64"),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
  } catch {
    // Disconnecting still removes our copy; Intuit expires an unused token anyway.
  }
}

function expiryFields(t: TokenResponse) {
  const now = Date.now();
  return {
    access_expires_at: new Date(now + (t.expires_in || 3600) * 1000).toISOString(),
    refresh_expires_at: t.x_refresh_token_expires_in ? new Date(now + t.x_refresh_token_expires_in * 1000).toISOString() : null,
  };
}

// Stores a brand-new connection (after the Connect button).
export async function saveConnection(
  cfg: QboConfig,
  admin: SupabaseClient,
  args: { companyId: string; userId: string; realmId: string; tokens: TokenResponse; companyName: string | null }
) {
  const row = {
    company_id: args.companyId,
    environment: cfg.environment,
    realm_id: args.realmId,
    company_name: args.companyName,
    access_token_enc: seal(cfg.key, args.tokens.access_token),
    refresh_token_enc: seal(cfg.key, args.tokens.refresh_token),
    ...expiryFields(args.tokens),
    connected_by: args.userId,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin.from("quickbooks_connections").upsert(row, { onConflict: "company_id" });
  if (error) throw new Error("Could not save the QuickBooks connection: " + error.message);
}

export type ConnectionRow = {
  company_id: string;
  environment: QboEnv;
  realm_id: string;
  company_name: string | null;
  access_token_enc: string;
  access_expires_at: string;
  refresh_token_enc: string;
  refresh_expires_at: string | null;
  connected_at: string;
};

export async function loadConnection(admin: SupabaseClient, companyId: string): Promise<ConnectionRow | null> {
  const { data, error } = await admin.from("quickbooks_connections").select("*").eq("company_id", companyId).maybeSingle();
  if (error) throw new Error("Could not read the QuickBooks connection: " + error.message);
  return (data as ConnectionRow | null) ?? null;
}

export class NeedsReconnect extends Error {}

// A usable access token for this shop, refreshing it first if it is within
// two minutes of running out.
async function accessToken(cfg: QboConfig, admin: SupabaseClient, conn: ConnectionRow): Promise<string> {
  if (new Date(conn.access_expires_at).getTime() - Date.now() > 120_000) {
    return unseal(cfg.key, conn.access_token_enc);
  }
  let t: TokenResponse;
  try {
    t = await tokenCall(cfg, { grant_type: "refresh_token", refresh_token: unseal(cfg.key, conn.refresh_token_enc) });
  } catch (e) {
    if ((e as { invalidGrant?: boolean }).invalidGrant) {
      throw new NeedsReconnect("QuickBooks has signed ShopWorks out. Connect it again.");
    }
    throw e;
  }
  // Only replace the row we refreshed from. If another request refreshed it a
  // moment earlier, keep theirs - both token pairs are good for now.
  await admin
    .from("quickbooks_connections")
    .update({
      access_token_enc: seal(cfg.key, t.access_token),
      refresh_token_enc: seal(cfg.key, t.refresh_token),
      ...expiryFields(t),
      updated_at: new Date().toISOString(),
    })
    .eq("company_id", conn.company_id)
    .eq("refresh_token_enc", conn.refresh_token_enc);
  return t.access_token;
}

// GET something from this shop's QuickBooks company. `path` is everything
// after /v3/company/{realm}/, e.g. "reports/ProfitAndLoss".
export async function qboGet(
  cfg: QboConfig,
  admin: SupabaseClient,
  conn: ConnectionRow,
  path: string,
  params: Record<string, string> = {}
): Promise<unknown> {
  const token = await accessToken(cfg, admin, conn);
  const q = new URLSearchParams({ ...params, minorversion: MINOR_VERSION });
  const url = apiBase(conn.environment) + "/v3/company/" + encodeURIComponent(conn.realm_id) + "/" + path + "?" + q.toString();
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  if (res.status === 401) throw new NeedsReconnect("QuickBooks has signed ShopWorks out. Connect it again.");
  if (!res.ok) {
    let reason = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      const f = j?.Fault?.Error?.[0];
      if (f) reason = [f.Message, f.Detail].filter(Boolean).join(" - ");
    } catch {
      // keep the raw text
    }
    throw new Error("QuickBooks answered " + res.status + ": " + reason);
  }
  return JSON.parse(text);
}

export async function companyName(cfg: QboConfig, admin: SupabaseClient, conn: ConnectionRow): Promise<string | null> {
  try {
    const j = (await qboGet(cfg, admin, conn, "companyinfo/" + encodeURIComponent(conn.realm_id))) as {
      CompanyInfo?: { CompanyName?: string; LegalName?: string };
    };
    return j.CompanyInfo?.CompanyName || j.CompanyInfo?.LegalName || null;
  } catch {
    return null;
  }
}
