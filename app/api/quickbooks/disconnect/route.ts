// ---------------------------------------------------------------------------
// "Disconnect QuickBooks". QUICKBOOKS-DISCONNECT-V1
// Tells Intuit to cancel the tokens, then deletes our (scrambled) copy and
// the last month-to-date pull. Nothing in QuickBooks itself changes.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { financeUser, loadConnection, qboConfig, revokeToken, serviceClient, unseal } from "@/app/lib/quickbooks";
import { createServerSupabaseClient } from "@/app/lib/supabase-server";

export async function POST() {
  const who = await financeUser();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const admin = serviceClient();
  const cfg = qboConfig();
  try {
    const conn = await loadConnection(admin, who.user.companyId);
    if (conn && cfg && conn.environment === cfg.environment) {
      try {
        await revokeToken(cfg, unseal(cfg.key, conn.refresh_token_enc));
      } catch {
        // A token we can't unscramble is useless anyway - carry on deleting it.
      }
    }
    const { error } = await admin.from("quickbooks_connections").delete().eq("company_id", who.user.companyId);
    if (error) throw new Error(error.message);

    const supabase = await createServerSupabaseClient();
    await supabase.from("finance_settings").update({ qb_snapshot: null }).eq("company_id", who.user.companyId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not disconnect." }, { status: 500 });
  }
}
