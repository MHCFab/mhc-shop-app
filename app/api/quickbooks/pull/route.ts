// ---------------------------------------------------------------------------
// Read the Profit and Loss and the Statement of Cash Flows from this shop's
// QuickBooks for a date range. QUICKBOOKS-PULL-V1
//
// Body: { start: "YYYY-MM-DD", end: "YYYY-MM-DD", save?: boolean }
// Returns the two reports, parsed into a small tree (quickbooks-report.ts).
//
// save: true is the Budget tab's "Pull month to date". The result is stored
// in finance_settings.qb_snapshot through the SIGNED-IN person's own database
// session, so the same finance-only rule applies as for every other finance
// write. The month form's "Fill from QuickBooks" does NOT save - it only fills
// the boxes, and nothing is kept until the person presses Save month.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { NeedsReconnect, financeUser, loadConnection, qboConfig, qboGet, serviceClient } from "@/app/lib/quickbooks";
import { parseReport, type QbSnapshot } from "@/app/lib/quickbooks-report";
import { createServerSupabaseClient } from "@/app/lib/supabase-server";

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export async function POST(req: NextRequest) {
  const who = await financeUser();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const cfg = qboConfig();
  if (!cfg) return NextResponse.json({ error: "QuickBooks isn't set up on this server yet." }, { status: 503 });

  let body: { start?: string; end?: string; save?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const start = String(body.start || "");
  const end = String(body.end || "");
  if (!DATE.test(start) || !DATE.test(end) || start > end) {
    return NextResponse.json({ error: "Those dates don't make sense." }, { status: 400 });
  }
  if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > 366) {
    return NextResponse.json({ error: "Pick a year or less." }, { status: 400 });
  }

  const admin = serviceClient();
  try {
    const conn = await loadConnection(admin, who.user.companyId);
    if (!conn || conn.environment !== cfg.environment) {
      return NextResponse.json({ error: "QuickBooks isn't connected for this shop.", reconnect: true }, { status: 409 });
    }
    const params = { start_date: start, end_date: end };
    // One after the other, not together: the first call may refresh the
    // token, and the second should use the refreshed one.
    const plRaw = await qboGet(cfg, admin, conn, "reports/ProfitAndLoss", params);
    const fresh = (await loadConnection(admin, who.user.companyId)) || conn;
    const cfRaw = await qboGet(cfg, admin, fresh, "reports/CashFlow", params);

    const snapshot: QbSnapshot = {
      at: new Date().toISOString(),
      start,
      end,
      realm: conn.realm_id,
      companyName: conn.company_name,
      pl: parseReport(plRaw),
      cf: parseReport(cfRaw),
    };

    if (body.save) {
      const supabase = await createServerSupabaseClient();
      const { data, error } = await supabase
        .from("finance_settings")
        .upsert({ company_id: who.user.companyId, qb_snapshot: snapshot }, { onConflict: "company_id" })
        .select("company_id");
      if (error || !data || data.length === 0) {
        return NextResponse.json(
          { snapshot, warning: "Pulled, but couldn't keep it for next time" + (error ? ": " + error.message : ".") },
          { status: 200 }
        );
      }
    }
    return NextResponse.json({ snapshot });
  } catch (e) {
    if (e instanceof NeedsReconnect) {
      return NextResponse.json({ error: e.message, reconnect: true }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "QuickBooks couldn't return the reports." }, { status: 502 });
  }
}
