// ---------------------------------------------------------------------------
// "Is this shop connected to QuickBooks, and to which company?"
// QUICKBOOKS-STATUS-V1
// The browser cannot read quickbooks_connections (on purpose), so it asks
// here. Never returns a token.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { financeUser, loadConnection, qboConfig, serviceClient } from "@/app/lib/quickbooks";

export async function GET() {
  const who = await financeUser();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const cfg = qboConfig();
  if (!cfg) return NextResponse.json({ configured: false, connected: false });

  try {
    const conn = await loadConnection(serviceClient(), who.user.companyId);
    // A connection made against the sandbox is no good once the server is on
    // production keys (and the other way round).
    const connected = !!conn && conn.environment === cfg.environment;
    return NextResponse.json({
      configured: true,
      environment: cfg.environment,
      connected,
      companyName: connected ? conn!.company_name : null,
      connectedAt: connected ? conn!.connected_at : null,
      refreshExpiresAt: connected ? conn!.refresh_expires_at : null,
      staleEnvironment: !!conn && !connected ? conn.environment : null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check QuickBooks." }, { status: 500 });
  }
}
