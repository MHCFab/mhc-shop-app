"use client";

// ---------------------------------------------------------------------------
// Finances: what an hour of shop time really costs, what it brings in, and
// how each month closed. Moved into ShopWorks from the Claude tracker
// artifact on 2026-09-28. FINANCE-PAGE-V2 (QuickBooks added 2026-09-28)
//
// WHO SEES IT: only an active admin whose membership has can_see_finances on,
// and only when the shop has the page switched on in Settings. The database
// enforces that (finance-schema.sql) - this screen just explains it nicely.
// Everything here can show a crew member's wage and the owner's draw, so it
// must never lean on "they're an admin" alone.
//
// QUICKBOOKS: each shop connects its own QuickBooks company (the Budget tab).
// The login tokens never reach the browser - the page talks to
// /api/quickbooks/* and the server reads Intuit. Two uses:
//   * Budget tab, "Pull month to date": P&L + cash flow for the 1st..today,
//     kept in finance_settings.qb_snapshot, drives spent / left / on track.
//   * Month form, "Fill from QuickBooks": fills the boxes for that month for
//     the person to check. NOTHING is saved until they press Save month, and
//     the button is not offered on a month already marked final.
// The account-name matching lives in app/lib/quickbooks-report.ts.
//
// TARGET CARD (FINANCE-TARGET-V1, 2026-09-28): revenue needed for a monthly
// profit target. Erik's decisions: fixed costs come from the SAVED shop rate
// (plan, not actuals); the target is profit kept AFTER his draw and loans;
// one saved target, stored as rate.targetProfit (no schema change). It also
// shows the margin before draws at that target, next to what the last 3 final
// months actually achieved. Math is targetPlan() in finance-math.ts.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabase";
import {
  type BudgetCategory,
  type BudgetConfig,
  type MonthField,
  type MonthRow,
  type RateConfig,
  MONTH_FIELDS,
  burden,
  calcMonth,
  crewMonthlyPay,
  hrs,
  money,
  monthId,
  monthLabel,
  nextMonthId,
  normaliseBudget,
  normaliseMonth,
  normaliseRate,
  parseNum,
  pct,
  steelShare,
  sumMonths,
  targetPlan,
} from "../../lib/finance-math";
import { budgetLine, monthFromReports, monthShare, unmatchedAccounts, type QbSnapshot } from "../../lib/quickbooks-report";

type Tab = "months" | "rate" | "budget" | "how";
type Access = "checking" | "yes" | "no" | "off" | "missing";

type QbStatus = {
  configured: boolean;
  connected: boolean;
  environment?: "sandbox" | "production";
  companyName?: string | null;
  connectedAt?: string | null;
  staleEnvironment?: string | null;
  error?: string;
};

function isoDate(d: Date) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// The first and last day of a 'YYYY-MM' month, with the last day capped at
// today so a month still under way reads "to date".
function monthRange(id: string, today: Date): { start: string; end: string } {
  const [y, m] = id.split("-").map(Number);
  const last = new Date(y, m, 0);
  const end = last > today ? today : last;
  return { start: id + "-01", end: isoDate(end) };
}

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j: Record<string, unknown> = {};
  try {
    j = await res.json();
  } catch {
    // leave empty
  }
  return { ok: res.ok, status: res.status, j };
}

// ---- the month form --------------------------------------------------------

const MONTH_INPUTS: { key: MonthField; label: string; hint?: string }[] = [
  { key: "revenue", label: "Revenue" },
  { key: "materials", label: "Materials (steel COGS)" },
  { key: "supplies", label: "Shop supplies" },
  { key: "payroll", label: "Payroll all-in", hint: "Wages + taxes + retirement + fees" },
  { key: "overhead", label: "Other overhead" },
  { key: "debt_payments", label: "Loan payments" },
  { key: "owner_draws", label: "Owner draws" },
  { key: "equipment", label: "Equipment / vehicle buys" },
  { key: "new_borrowing", label: "New borrowing" },
  { key: "crew_hours", label: "Crew hours worked", hint: "Regular + overtime, hourly crew only" },
];

type MonthDraft = Record<MonthField, string> & { is_final: boolean };

function monthToDraft(m: MonthRow | undefined): MonthDraft {
  const d = { is_final: !!m?.is_final } as MonthDraft;
  for (const f of MONTH_FIELDS) {
    const v = m ? m[f] : 0;
    d[f] = v ? (f === "crew_hours" ? String(v) : v.toLocaleString("en-US", { maximumFractionDigits: 2 })) : "";
  }
  return d;
}

// ---- the shop rate form ----------------------------------------------------

const SCALARS: { key: keyof RateConfig; label: string; kind: "$" | "%" }[] = [
  { key: "taxPct", label: "Employer payroll tax rate", kind: "%" },
  { key: "match", label: "Retirement match / month", kind: "$" },
  { key: "fees", label: "Payroll service fees / month", kind: "$" },
  { key: "workedPct", label: "Share of paid hours actually worked", kind: "%" },
  { key: "overhead", label: "Overhead, all other expenses / month", kind: "$" },
  { key: "supplies", label: "Shop supplies / month", kind: "$" },
  { key: "drawTarget", label: "Owner draw target / month", kind: "$" },
  { key: "drawActual", label: "Owner draw actual average / month", kind: "$" },
  { key: "quoted", label: "Quoted shop rate / hr", kind: "$" },
  { key: "taxReserve", label: "Tax reserve, share of operating profit", kind: "%" },
  { key: "equipFund", label: "Equipment fund / month", kind: "$" },
];

type RateDraft = {
  crew: { name: string; rate: string; hours: string; shop: boolean }[];
  debts: { name: string; amount: string; outsideQb: boolean }[];
  fields: Record<string, string>;
};

function rateToDraft(r: RateConfig): RateDraft {
  const fields: Record<string, string> = {};
  for (const s of SCALARS) {
    const v = r[s.key] as number;
    fields[s.key] = s.kind === "%" ? +(v * 100).toFixed(2) + "%" : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return {
    crew: r.crew.map((p) => ({ name: p.name, rate: String(p.rate), hours: String(p.hours), shop: p.shop })),
    debts: r.debts.map((d) => ({ name: d.name, amount: d.amount.toLocaleString("en-US", { maximumFractionDigits: 2 }), outsideQb: !!d.outsideQb })),
    fields,
  };
}

function draftToRate(d: RateDraft): RateConfig {
  const r = normaliseRate({});
  r.crew = d.crew.map((p) => ({ name: p.name.trim(), rate: parseNum(p.rate), hours: parseNum(p.hours), shop: p.shop }));
  r.debts = d.debts.map((x) => (x.outsideQb ? { name: x.name.trim(), amount: parseNum(x.amount), outsideQb: true } : { name: x.name.trim(), amount: parseNum(x.amount) }));
  for (const s of SCALARS) {
    const v = parseNum(d.fields[s.key]);
    (r as unknown as Record<string, number>)[s.key] = s.kind === "%" ? v / 100 : v;
  }
  return r;
}

// ---- the budget form -------------------------------------------------------

type BudgetDraft = (BudgetCategory & { limitText: string; pctText: string; matchText: string })[];

function budgetToDraft(b: BudgetConfig): BudgetDraft {
  return b.categories.map((c) => ({
    ...c,
    limitText: c.untracked ? "" : c.limit.toLocaleString("en-US"),
    pctText: c.pctOfRevenue ? +(c.pctOfRevenue * 100).toFixed(2) + "%" : "",
    matchText: c.match.join(", "),
  }));
}

function draftToBudget(d: BudgetDraft): BudgetConfig {
  return {
    categories: d.map((c) => {
      const match = c.matchText
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const out: BudgetCategory = { name: c.name.trim(), limit: c.untracked ? 0 : parseNum(c.limitText), match };
      if (c.fixed) out.fixed = true;
      if (c.fromCashFlow) out.fromCashFlow = true;
      if (c.untracked) out.untracked = true;
      if (c.pctOfRevenue !== undefined) out.pctOfRevenue = parseNum(c.pctText) / 100;
      return out;
    }),
  };
}

// ---- small pieces ----------------------------------------------------------

const inputCls =
  "w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500";

function Msg({ m }: { m: { ok: boolean; text: string } | null }) {
  if (!m) return null;
  return <span className={"text-sm " + (m.ok ? "text-green-700" : "text-red-600")}>{m.text}</span>;
}

function signCls(v: number) {
  if (!Number.isFinite(v)) return "";
  return v < 0 ? "text-red-600" : "text-green-700";
}

// The ruler across the top: where each rate lands on a $0-$200+ scale.
function RateRuler({ marks, band }: { marks: { v: number; color: string; label: string; tall: boolean }[]; band: { a: number; b: number; good: boolean } | null }) {
  const top = Math.max(200, ...marks.map((m) => (Number.isFinite(m.v) ? Math.ceil((m.v + 10) / 50) * 50 : 0)));
  const W = 1000;
  const x = (v: number) => (Math.max(0, Math.min(top, v)) / top) * W;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += 5) ticks.push(v);
  return (
    <div>
      <svg viewBox="0 0 1000 118" preserveAspectRatio="none" className="w-full h-28 overflow-visible" aria-hidden="true">
        <rect x="0" y="54" width={W} height="30" fill="#f3f4f6" stroke="#1f2937" strokeWidth="1.5" />
        {band && (
          <rect x={x(band.a)} y="58" width={Math.max(0, x(band.b) - x(band.a))} height="22" fill={band.good ? "#15803d" : "#b91c1c"} opacity="0.22" />
        )}
        {ticks.map((v) => {
          const len = v % 50 === 0 ? 30 : v % 25 === 0 ? 20 : v % 10 === 0 ? 13 : 8;
          return (
            <g key={v}>
              <line x1={x(v)} x2={x(v)} y1="54" y2={54 + len} stroke="#1f2937" strokeWidth={v % 50 === 0 ? 2 : 1} />
              {v % 25 === 0 && (
                <text x={x(v)} y="104" textAnchor={v === 0 ? "start" : v === top ? "end" : "middle"} fontSize="15" fill="#6b7280">
                  ${v}
                </text>
              )}
            </g>
          );
        })}
        {marks
          .filter((m) => Number.isFinite(m.v))
          .map((m) => {
            const h = m.tall ? 46 : 14;
            return (
              <g key={m.label}>
                <rect x={x(m.v) - 2} y={54 - h + 6} width="4" height={h + 24} fill={m.color} />
                <circle cx={x(m.v)} cy={54 - h + 6} r="5" fill={m.color} />
              </g>
            );
          })}
      </svg>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-600 mt-1">
        {marks
          .filter((m) => Number.isFinite(m.v))
          .map((m) => (
            <span key={m.label} className="inline-flex items-center gap-1.5">
              <i className="inline-block w-2.5 h-2.5" style={{ background: m.color }} />
              {m.label} <span className="tabular-nums text-gray-900">{money(m.v)}</span>
            </span>
          ))}
      </div>
    </div>
  );
}

// ===========================================================================

export default function FinancePage() {
  const supabase = useMemo(() => createClient(), []);
  const [today] = useState(() => new Date());

  const [access, setAccess] = useState<Access>("checking");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("months");
  const [rate, setRate] = useState<RateConfig | null>(null);
  const [rateDraft, setRateDraft] = useState<RateDraft | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft>([]);
  const [months, setMonths] = useState<Record<string, MonthRow>>({});
  const [settingsBurden, setSettingsBurden] = useState<number | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [monthDraft, setMonthDraft] = useState<MonthDraft | null>(null);

  const [busy, setBusy] = useState(false);
  const [monthMsg, setMonthMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rateMsg, setRateMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [budgetMsg, setBudgetMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [targetText, setTargetText] = useState("0");
  const [targetMsg, setTargetMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [qb, setQb] = useState<QbStatus | null>(null);
  const [qbSnap, setQbSnap] = useState<QbSnapshot | null>(null);
  const [qbBusy, setQbBusy] = useState(false);
  const [qbMsg, setQbMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fillNotes, setFillNotes] = useState<string[]>([]);

  const load = useCallback(async () => {
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;
    if (!uid) {
      setAccess("no");
      return;
    }
    setUserId(uid);
    const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", uid).single();
    const cid = (profile?.company_id as string | undefined) ?? null;
    setCompanyId(cid);
    if (!cid) {
      setAccess("no");
      return;
    }

    const { data: co, error: coErr } = await supabase
      .from("companies")
      .select("finance_enabled, burden_rate_per_hour")
      .eq("id", cid)
      .single();
    if (coErr) {
      // Almost always: finance-schema.sql has not been run yet.
      setAccess("missing");
      setLoadError(coErr.message);
      return;
    }
    setSettingsBurden(Number(co?.burden_rate_per_hour ?? 0));

    const { data: allowed, error: accErr } = await supabase.rpc("has_finance_access");
    if (accErr) {
      setAccess("missing");
      setLoadError(accErr.message);
      return;
    }
    if (!allowed) {
      setAccess("no");
      return;
    }
    if (!co?.finance_enabled) {
      setAccess("off");
      return;
    }

    const [setRes, monRes] = await Promise.all([
      supabase.from("finance_settings").select("rate, budget").eq("company_id", cid).maybeSingle(),
      supabase.from("finance_months").select("*").eq("company_id", cid).order("month"),
    ]);
    if (setRes.error || monRes.error) {
      setLoadError((setRes.error || monRes.error)?.message || "Could not load.");
    }
    const r = normaliseRate(setRes.data?.rate);
    setRate(r);
    setRateDraft(rateToDraft(r));
    setTargetText(r.targetProfit.toLocaleString("en-US", { maximumFractionDigits: 2 }));
    setBudgetDraft(budgetToDraft(normaliseBudget(setRes.data?.budget)));
    const map: Record<string, MonthRow> = {};
    for (const row of (monRes.data || []) as unknown as Record<string, unknown>[]) {
      const m = normaliseMonth(row);
      map[m.month] = m;
    }
    setMonths(map);
    setAccess("yes");

    // QuickBooks: the last month-to-date pull, then whether we are connected.
    // Both are allowed to fail quietly - the rest of the page still works.
    const snapRes = await supabase.from("finance_settings").select("qb_snapshot").eq("company_id", cid).maybeSingle();
    if (!snapRes.error) setQbSnap((snapRes.data?.qb_snapshot as QbSnapshot | null) ?? null);
    try {
      const r = await fetch("/api/quickbooks/status", { cache: "no-store" });
      const j = await r.json();
      setQb(r.ok ? (j as QbStatus) : { configured: false, connected: false, error: String(j?.error || "") });
    } catch {
      setQb({ configured: false, connected: false, error: "Couldn't reach the server." });
    }
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  // Coming back from Intuit's sign-in page: /admin/finance?qb=connected|error
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const flag = p.get("qb");
    if (!flag) return;
    const text = flag === "connected" ? "QuickBooks is connected. Pull month to date to fill the Budget." : p.get("msg") || "QuickBooks wasn't connected.";
    window.history.replaceState(null, "", window.location.pathname);
    // Deferred so it isn't a state change straight inside the effect.
    const t = setTimeout(() => {
      setTab("budget");
      setQbMsg({ ok: flag === "connected", text });
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // ---- derived numbers -----------------------------------------------------

  const liveRate = useMemo(() => (rateDraft ? draftToRate(rateDraft) : rate), [rateDraft, rate]);
  const savedBurden = useMemo(() => (rate ? burden(rate) : null), [rate]);
  const liveBurden = useMemo(() => (liveRate ? burden(liveRate) : null), [liveRate]);

  const ids = useMemo(() => Object.keys(months).sort(), [months]);
  const finalIds = ids.filter((id) => months[id].is_final);
  const last3 = finalIds.slice(-3).map((id) => months[id]);
  const last3Calc = last3.length ? calcMonth(sumMonths(last3), rate) : null;

  const prevId = monthId(new Date(today.getFullYear(), today.getMonth() - 1, 1));
  const prevDone = !!months[prevId]?.is_final;

  const liveBudget = useMemo(() => draftToBudget(budgetDraft.filter((c) => c.name.trim())), [budgetDraft]);
  const unmatched = useMemo(() => (qbSnap ? unmatchedAccounts(qbSnap, liveBudget) : []), [qbSnap, liveBudget]);

  // ---- actions -------------------------------------------------------------

  function openMonth(id: string) {
    setEditing(id);
    setMonthDraft(monthToDraft(months[id]));
    setMonthMsg(null);
    setFillNotes([]);
    setTab("months");
  }

  // ---- QuickBooks ----------------------------------------------------------

  function connectQb() {
    window.location.assign("/api/quickbooks/connect");
  }

  async function pullMonthToDate() {
    setQbBusy(true);
    setQbMsg({ ok: true, text: "Asking QuickBooks..." });
    const { start } = monthRange(monthId(today), today);
    const { ok, j } = await postJson("/api/quickbooks/pull", { start, end: isoDate(today), save: true });
    setQbBusy(false);
    if (!ok) {
      setQbMsg({ ok: false, text: String(j.error || "QuickBooks couldn't return the reports.") });
      if (j.reconnect) setQb((q) => (q ? { ...q, connected: false } : q));
      return;
    }
    setQbSnap(j.snapshot as QbSnapshot);
    setQbMsg(j.warning ? { ok: false, text: String(j.warning) } : { ok: true, text: "Updated." });
  }

  async function disconnectQb() {
    if (!confirm("Disconnect QuickBooks from ShopWorks? Nothing in QuickBooks changes. You can connect it again any time.")) return;
    setQbBusy(true);
    const { ok, j } = await postJson("/api/quickbooks/disconnect");
    setQbBusy(false);
    if (!ok) {
      setQbMsg({ ok: false, text: String(j.error || "Couldn't disconnect.") });
      return;
    }
    setQb((q) => (q ? { ...q, connected: false, companyName: null } : q));
    setQbSnap(null);
    setQbMsg({ ok: true, text: "QuickBooks disconnected." });
  }

  async function fillMonthFromQb() {
    if (!editing || !monthDraft) return;
    const { start, end } = monthRange(editing, today);
    if (start > isoDate(today)) {
      setMonthMsg({ ok: false, text: "That month hasn't started yet." });
      return;
    }
    setBusy(true);
    setMonthMsg({ ok: true, text: "Asking QuickBooks..." });
    const { ok, j } = await postJson("/api/quickbooks/pull", { start, end });
    setBusy(false);
    if (!ok) {
      setMonthMsg({ ok: false, text: String(j.error || "QuickBooks couldn't return the reports.") });
      if (j.reconnect) setQb((q) => (q ? { ...q, connected: false } : q));
      return;
    }
    const snap = j.snapshot as QbSnapshot;
    // Loans ticked "paid outside QuickBooks" on the SAVED shop rate.
    const outside = (rate?.debts || []).filter((d) => d.outsideQb && d.amount);
    const fill = monthFromReports(snap.pl, snap.cf, liveBudget, outside);
    const next = { ...monthDraft };
    for (const [k, v] of Object.entries(fill.values)) {
      next[k as MonthField] = (v as number).toLocaleString("en-US", { maximumFractionDigits: 2 });
    }
    setMonthDraft(next);
    setFillNotes(fill.notes);
    setMonthMsg({
      ok: true,
      text: "Filled from QuickBooks (" + start + " to " + end + "). Check the numbers, add crew hours, then Save month.",
    });
  }

  function addNextMonth() {
    const id = ids.length ? nextMonthId(ids[ids.length - 1]) : prevId;
    openMonth(id);
  }

  async function saveMonth(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId || !editing || !monthDraft) return;
    setBusy(true);
    setMonthMsg(null);
    const row: Record<string, unknown> = {
      company_id: companyId,
      month: editing,
      is_final: monthDraft.is_final,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    };
    for (const f of MONTH_FIELDS) row[f] = parseNum(monthDraft[f]);
    const { data, error } = await supabase.from("finance_months").upsert(row, { onConflict: "company_id,month" }).select();
    setBusy(false);
    // A refused write can come back with no error and no rows, so check both.
    if (error || !data || data.length === 0) {
      setMonthMsg({ ok: false, text: "Didn't save" + (error ? ": " + error.message : " - the database refused it.") });
      return;
    }
    const saved = normaliseMonth(data[0] as unknown as Record<string, unknown>);
    setMonths((prev) => ({ ...prev, [saved.month]: saved }));
    setMonthMsg({ ok: true, text: "Saved " + monthLabel(saved.month) + "." });
  }

  async function saveRate() {
    if (!companyId || !rateDraft) return;
    // The shop rate form doesn't hold the target, so carry the saved one over.
    const r = { ...draftToRate(rateDraft), targetProfit: rate?.targetProfit ?? 0 };
    setBusy(true);
    setRateMsg(null);
    const { data, error } = await supabase
      .from("finance_settings")
      .upsert({ company_id: companyId, rate: r, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: "company_id" })
      .select("company_id");
    setBusy(false);
    if (error || !data || data.length === 0) {
      setRateMsg({ ok: false, text: "Didn't save" + (error ? ": " + error.message : " - the database refused it.") });
      return;
    }
    setRate(r);
    setRateDraft(rateToDraft(r));
    setRateMsg({ ok: true, text: "Saved. Fully loaded rate is " + money(burden(r).full, 2) + " / hr." });
  }

  // The Target card's Save: the SAVED shop rate with the new target. Unsaved
  // edits on the Shop rate tab are left alone (they stay a draft).
  async function saveTarget() {
    if (!companyId || !rate) return;
    const r = { ...rate, targetProfit: parseNum(targetText) };
    setBusy(true);
    setTargetMsg(null);
    const { data, error } = await supabase
      .from("finance_settings")
      .upsert({ company_id: companyId, rate: r, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: "company_id" })
      .select("company_id");
    setBusy(false);
    if (error || !data || data.length === 0) {
      setTargetMsg({ ok: false, text: "Didn't save" + (error ? ": " + error.message : " - the database refused it.") });
      return;
    }
    setRate(r);
    setTargetText(r.targetProfit.toLocaleString("en-US", { maximumFractionDigits: 2 }));
    setTargetMsg({ ok: true, text: "Target saved." });
  }

  // "Fill from actuals": the Shop rate's cost boxes from the average of the
  // last 6 FINAL months in the tracker (which come from QuickBooks, plus
  // anything corrected by hand). Crew, loans, draw target and quoted rate stay
  // as typed. Nothing is saved until Save shop rate. (Erik, 2026-09-28)
  function fillRateFromActuals() {
    if (!rateDraft) return;
    const list = finalIds.slice(-6).map((id) => months[id]);
    if (!list.length) {
      setRateMsg({ ok: false, text: "No months are marked final yet, so there is nothing to average." });
      return;
    }
    const avg = (f: MonthField) => list.reduce((a, m) => a + m[f], 0) / list.length;
    const fmt = (v: number) => (Math.round(v * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
    const overhead = avg("overhead");
    const supplies = avg("supplies");
    const draws = avg("owner_draws");
    const loans = avg("debt_payments");
    const payroll = avg("payroll");
    setRateDraft({ ...rateDraft, fields: { ...rateDraft.fields, overhead: fmt(overhead), supplies: fmt(supplies), drawActual: fmt(draws) } });
    const span = list.length === 1 ? monthLabel(finalIds[finalIds.length - 1]) : monthLabel(finalIds[finalIds.length - list.length]) + " to " + monthLabel(finalIds[finalIds.length - 1]);
    const planLoans = rateDraft.debts.reduce((a, d) => a + parseNum(d.amount), 0);
    setRateMsg({
      ok: true,
      text:
        "Filled from the average of " + list.length + " final month" + (list.length === 1 ? "" : "s") + " (" + span + "): overhead " + money(overhead) +
        ", shop supplies " + money(supplies) + ", actual draw " + money(draws) + ". To compare, not changed: loan payments averaged " + money(loans) +
        " against " + money(planLoans) + " on your loan list, and payroll averaged " + money(payroll) + " against " + money(liveBurden?.payroll) +
        " from your crew list. Check it, then Save shop rate.",
    });
  }

  async function applyBurden() {
    if (!companyId || !savedBurden || !Number.isFinite(savedBurden.full)) return;
    const value = Math.round(savedBurden.full * 100) / 100;
    if (
      !confirm(
        "Set the ShopWorks burden rate to " +
          money(value, 2) +
          " / hr? Job costing and suggested retail use it from now on. (It is " +
          money(settingsBurden, 2) +
          " today.)"
      )
    )
      return;
    setBusy(true);
    const { data, error } = await supabase
      .from("companies")
      .update({ burden_rate_per_hour: value })
      .eq("id", companyId)
      .select("burden_rate_per_hour");
    setBusy(false);
    if (error || !data || data.length === 0) {
      setRateMsg({ ok: false, text: "Burden rate not changed" + (error ? ": " + error.message : ".") });
      return;
    }
    setSettingsBurden(Number(data[0].burden_rate_per_hour));
    setRateMsg({ ok: true, text: "ShopWorks burden rate is now " + money(value, 2) + " / hr." });
  }

  async function saveBudget() {
    if (!companyId) return;
    const b = draftToBudget(budgetDraft.filter((c) => c.name.trim()));
    setBusy(true);
    setBudgetMsg(null);
    const { data, error } = await supabase
      .from("finance_settings")
      .upsert({ company_id: companyId, budget: b, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: "company_id" })
      .select("company_id");
    setBusy(false);
    if (error || !data || data.length === 0) {
      setBudgetMsg({ ok: false, text: "Didn't save" + (error ? ": " + error.message : " - the database refused it.") });
      return;
    }
    setBudgetDraft(budgetToDraft(b));
    setBudgetMsg({ ok: true, text: "Ceilings saved." });
  }

  function downloadCsv() {
    const head = [
      "Month", "Revenue", "Materials", "Shop supplies", "Payroll all-in", "Other overhead", "Loan payments",
      "Owner draws", "Equipment buys", "New borrowing", "Crew hours", "Final", "Revenue after steel",
      "Out not materials", "Cost per hr", "Recovered per hr", "Margin per hr", "Profit before draws",
      "Margin before draws", "Profit after everything", "Margin after", "Draw it supports",
    ];
    const num = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "");
    const lines = [head.join(",")];
    for (const id of ids) {
      const m = months[id];
      const c = calcMonth(m, rate);
      lines.push(
        [
          monthLabel(id), ...MONTH_FIELDS.map((f) => num(m[f])), m.is_final ? "Y" : "N",
          num(c.after), num(c.out), num(c.cost), num(c.rec), num(c.margin), num(c.pre), num(c.prePct),
          num(c.profit), num(c.pct), num(c.supports),
        ].join(",")
      );
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "monthly-tracker.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- gates ---------------------------------------------------------------

  if (access === "checking") {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }
  if (access !== "yes") {
    const text =
      access === "off"
        ? "The Finances page is switched off for this shop. Turn it on under Settings."
        : access === "missing"
          ? "The Finances page isn't set up in the database yet (" + (loadError || "unknown") + ")."
          : "You don't have access to the shop's finances. Someone who already has it can switch it on for you on the Employees page.";
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-3">Finances</h1>
        <div className="bg-white border border-gray-200 rounded-lg p-5 text-gray-700">
          {text}{" "}
          {access === "off" && (
            <Link href="/admin/settings" className="text-blue-600 hover:text-blue-800 font-medium">
              Go to Settings
            </Link>
          )}
        </div>
      </div>
    );
  }

  const marks = [
    { v: liveBurden?.op ?? NaN, color: "#3D5667", label: "Operating burden", tall: false },
    { v: liveBurden?.withDebt ?? NaN, color: "#9ca3af", label: "+ loan payments", tall: false },
    { v: liveBurden?.full ?? NaN, color: "#b91c1c", label: "Fully loaded", tall: true },
    { v: last3Calc?.rec ?? NaN, color: "#1A7FA6", label: "Recovered", tall: true },
    { v: liveRate?.quoted || NaN, color: "#15803d", label: "Quoted", tall: true },
  ];
  const band =
    liveBurden && Number.isFinite(liveBurden.full) && liveRate?.quoted
      ? {
          a: Math.min(liveBurden.full, liveRate.quoted),
          b: Math.max(liveBurden.full, liveRate.quoted),
          good: liveRate.quoted >= liveBurden.full,
        }
      : null;

  const tabs: { id: Tab; label: string }[] = [
    { id: "months", label: "Monthly tracker" },
    { id: "rate", label: "Shop rate" },
    { id: "budget", label: "Budget" },
    { id: "how", label: "How to fill it in" },
  ];

  const nextFirst = new Date(today.getFullYear(), today.getMonth() + 1, 1);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-1">Finances</h1>
      <p className="text-gray-600 mb-5">
        What an hour of shop time really costs, what it brings in, and how each month closed. Fill in last month on the 1st.
      </p>

      {loadError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{loadError}</div>}

      <div
        className={
          "flex flex-wrap items-center gap-3 bg-white border border-gray-200 border-l-4 rounded-md px-4 py-3 mb-5 " +
          (prevDone ? "border-l-green-600" : "border-l-yellow-400")
        }
        role="status"
      >
        {prevDone ? (
          <span className="text-gray-800">
            Up to date. Next entry due {nextFirst.toLocaleDateString("en-US", { month: "long", day: "numeric" })}.
          </span>
        ) : (
          <>
            <span className="text-gray-800">Update due: enter {monthLabel(prevId)} and mark it final.</span>
            <button onClick={() => openMonth(prevId)} className="ml-auto px-3 py-1.5 border border-gray-800 rounded-md text-sm font-medium text-gray-900 hover:bg-gray-100">
              Enter {monthLabel(prevId).split(" ")[0]}
            </button>
          </>
        )}
      </div>

      <section className="bg-white border border-gray-200 rounded-lg p-5 mb-5" aria-label="Rate per shop hour">
        <div className="flex flex-wrap gap-x-10 gap-y-3 mb-2">
          <div>
            <div className="text-5xl font-semibold tabular-nums text-gray-900">
              {money(liveBurden?.full)}
              <span className="text-lg font-normal text-gray-500"> /hr</span>
            </div>
            <div className="text-sm text-gray-600">Fully loaded rate</div>
          </div>
          <div>
            <div className="text-5xl font-semibold tabular-nums" style={{ color: "#1A7FA6" }}>
              {money(last3Calc?.rec)}
              <span className="text-lg font-normal text-gray-500"> /hr</span>
            </div>
            <div className="text-sm text-gray-600">Recovered after steel, last 3 final months</div>
          </div>
          <div>
            <div className="text-5xl font-semibold tabular-nums text-gray-900">
              {money(liveRate?.quoted || NaN)}
              <span className="text-lg font-normal text-gray-500"> /hr</span>
            </div>
            <div className="text-sm text-gray-600">Your quoted rate</div>
          </div>
        </div>
        <RateRuler marks={marks} band={band} />
      </section>

      {rate && (() => {
        const steel = steelShare(finalIds.map((id) => months[id]));
        const target = parseNum(targetText);
        const plan = targetPlan(rate, steel.pct, target);
        const be = targetPlan(rate, steel.pct, 0);
        // Over = the target needs more per shop hour than the quoted rate.
        const over = Number.isFinite(plan.rateNeeded) && rate.quoted > 0 && plan.rateNeeded > rate.quoted + 0.005;
        const snapNow = qbSnap && qbSnap.start.slice(0, 7) === monthId(today) ? qbSnap : null;
        const income = snapNow ? snapNow.pl.groups["Income"]?.amount ?? 0 : 0;
        const share = snapNow ? monthShare(snapNow.end) : 0;
        const due = plan.revenue * share;
        const onPace = income >= due;
        const endDay = snapNow ? new Date(snapNow.end + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
        const saved = Math.abs(target - rate.targetProfit) < 0.005;
        return (
          <section className="bg-white border border-gray-200 rounded-lg p-5 mb-5" aria-label="Target">
            <div className="flex flex-wrap items-end gap-3 mb-4">
              <h2 className="text-xl font-bold text-gray-900 mr-4">Target</h2>
              <div>
                <label htmlFor="target-profit" className="block text-sm font-medium text-gray-700 mb-1">
                  Profit to keep each month, after your draw and loans
                </label>
                <input
                  id="target-profit"
                  inputMode="decimal"
                  value={targetText}
                  onChange={(e) => setTargetText(e.target.value)}
                  className={inputCls + " max-w-[10rem]"}
                />
              </div>
              <button
                onClick={saveTarget}
                disabled={busy || saved}
                className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                Save target
              </button>
              <Msg m={targetMsg} />
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-4 mb-4">
              <div>
                <div className="text-3xl font-semibold tabular-nums text-gray-900">{money(plan.revenue)}</div>
                <div className="text-sm text-gray-600">Revenue needed / month</div>
              </div>
              <div>
                <div className="text-3xl font-semibold tabular-nums text-gray-900">{money(plan.afterSteel)}</div>
                <div className="text-sm text-gray-600">Revenue after steel needed</div>
              </div>
              <div>
                <div className={"text-3xl font-semibold tabular-nums " + (over ? "text-red-600" : "text-gray-900")}>
                  {money(plan.rateNeeded, 2)}
                  <span className="text-lg font-normal text-gray-500"> /hr</span>
                </div>
                <div className="text-sm text-gray-600">
                  To recover per shop hour, after steel ({hrs(plan.capacity)} hrs / month)
                  {last3Calc && Number.isFinite(last3Calc.rec) && (
                    <span className="block">
                      Last 3 final months recovered{" "}
                      <span className={last3Calc.rec >= plan.rateNeeded ? "text-green-700" : "text-red-600"}>{money(last3Calc.rec, 2)}</span>
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-3xl font-semibold tabular-nums text-gray-900">{money(be.revenue)}</div>
                <div className="text-sm text-gray-600">Break-even revenue (draw paid, nothing kept)</div>
              </div>
            </div>

            <div className="grid grid-cols-[auto_auto] sm:grid-cols-[auto_auto_auto] justify-start gap-x-8 gap-y-1 text-sm tabular-nums text-gray-800 border-t border-gray-200 pt-3">
              <div>Margin after everything, at target</div>
              <div className="text-right">{pct(plan.marginAfter)}</div>
              <div className="text-gray-500 hidden sm:block">{money(target)} kept</div>
              <div>Margin before draws, at target</div>
              <div className="text-right">{pct(plan.marginPre)}</div>
              <div className="text-gray-500 hidden sm:block">{money(plan.preDraw)} with your {money(rate.drawTarget)} draw</div>
              <div>Margin before draws, achieved (last 3 final months)</div>
              <div className={"text-right " + (last3Calc && Number.isFinite(plan.marginPre) ? (last3Calc.prePct >= plan.marginPre ? "text-green-700" : "text-red-600") : "")}>
                {pct(last3Calc?.prePct)}
              </div>
              <div className="text-gray-500 hidden sm:block">{last3Calc ? money(last3Calc.pre / last3.length) + " a month on average" : "no final months yet"}</div>
            </div>

            {snapNow ? (
              <p className={"mt-3 text-sm " + (onPace ? "text-green-700" : "text-red-600")}>
                This month so far: {money(income)} of the {money(due)} needed by {endDay} to be on pace for {money(plan.revenue)}
                {share > 0 && " (heading for " + money(income / share) + ")"}. From QuickBooks, pulled {new Date(snapNow.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}.
                {qb?.connected && (
                  <button onClick={pullMonthToDate} disabled={qbBusy} className="ml-3 text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50">
                    {qbBusy ? "Pulling..." : "Pull again"}
                  </button>
                )}
              </p>
            ) : qb?.connected ? (
              <p className="mt-3 text-sm text-gray-600">
                No QuickBooks pull for this month yet.
                <button onClick={pullMonthToDate} disabled={qbBusy} className="ml-2 text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50">
                  {qbBusy ? "Pulling..." : "Pull month to date"}
                </button>{" "}
                to see this month&apos;s pace.
              </p>
            ) : null}

            {over && (
              <p className="mt-2 text-sm text-red-600">
                That is more than your quoted {money(rate.quoted)} / hr. Even with every shop hour sold at the quoted rate, the most a month keeps is {money(plan.maxProfit)}.
                Raise the rate or add hours.
              </p>
            )}
            <p className="mt-2 text-xs text-gray-500">
              Fixed costs {money(plan.fixed)} / month from the saved Shop rate: payroll, overhead, shop supplies, loans and your draw target. Steel runs {pct(steel.pct)} of
              revenue across {steel.count} final month{steel.count === 1 ? "" : "s"}. Revenue needed = (fixed costs + target) / (1 - steel share). Per shop hour = revenue after
              steel / the crew&apos;s shop hours from the Shop rate, the same measure as Recovered / hr in the tracker. At {money(rate.quoted)} / hr that is{" "}
              {hrs(plan.hours)} hours to sell; fully booked, the most a month keeps is {money(plan.maxProfit)}.
            </p>
          </section>
        );
      })()}

      <nav className="flex gap-1 border-b-2 border-gray-800 mb-4 overflow-x-auto" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={
              "px-4 py-2 text-sm font-semibold whitespace-nowrap rounded-t-md " +
              (tab === t.id ? "bg-gray-800 text-white" : "text-gray-600 hover:text-gray-900 hover:bg-gray-100")
            }
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* ------------------------------------------------ Monthly tracker */}
      {tab === "months" && (
        <section>
          <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-gray-600 text-right align-bottom">
                  <th className="text-left px-3 py-2 font-semibold">Month</th>
                  <th className="px-3 py-2 font-semibold">Revenue</th>
                  <th className="px-3 py-2 font-semibold">Steel</th>
                  <th className="px-3 py-2 font-semibold">Revenue<br />after steel</th>
                  <th className="px-3 py-2 font-semibold">Out, not<br />materials</th>
                  <th className="px-3 py-2 font-semibold">Crew<br />hours</th>
                  <th className="px-3 py-2 font-semibold">Cost<br />/ hr</th>
                  <th className="px-3 py-2 font-semibold">Recovered<br />/ hr</th>
                  <th className="px-3 py-2 font-semibold">Margin<br />/ hr</th>
                  <th className="px-3 py-2 font-semibold">Profit before<br />draws</th>
                  <th className="px-3 py-2 font-semibold">Margin<br />before draws</th>
                  <th className="px-3 py-2 font-semibold">Profit after<br />everything</th>
                  <th className="px-3 py-2 font-semibold">Margin<br />after</th>
                  <th className="px-3 py-2 font-semibold">Draw it<br />supports</th>
                  <th className="px-3 py-2 font-semibold">Your<br />draw</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {ids.length === 0 && (
                  <tr>
                    <td colSpan={15} className="px-3 py-6 text-gray-600">
                      No months yet. Use Add next month to enter the first one.
                    </td>
                  </tr>
                )}
                {ids.map((id) => {
                  const m = months[id];
                  const c = calcMonth(m, rate);
                  return (
                    <tr
                      key={id}
                      tabIndex={0}
                      onClick={() => openMonth(id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openMonth(id);
                      }}
                      className={"border-b border-gray-100 text-right cursor-pointer hover:bg-blue-50 " + (editing === id ? "bg-blue-50" : "")}
                    >
                      <td className="text-left px-3 py-2 whitespace-nowrap">
                        {monthLabel(id)}
                        {!m.is_final && <span className="ml-2 px-1.5 border border-yellow-400 text-xs text-gray-800 rounded">open</span>}
                      </td>
                      <td className="px-3 py-2">{money(m.revenue)}</td>
                      <td className="px-3 py-2">{money(m.materials)}</td>
                      <td className="px-3 py-2">{money(c.after)}</td>
                      <td className="px-3 py-2">{money(c.out)}</td>
                      <td className="px-3 py-2">{hrs(c.h)}</td>
                      <td className="px-3 py-2">{money(c.cost)}</td>
                      <td className="px-3 py-2">{money(c.rec)}</td>
                      <td className={"px-3 py-2 " + signCls(c.margin)}>{money(c.margin)}</td>
                      <td className={"px-3 py-2 " + signCls(c.pre)}>{money(c.pre)}</td>
                      <td className={"px-3 py-2 " + signCls(c.prePct)}>{pct(c.prePct)}</td>
                      <td className={"px-3 py-2 " + signCls(c.profit)}>{money(c.profit)}</td>
                      <td className={"px-3 py-2 " + signCls(c.pct)}>{pct(c.pct)}</td>
                      <td className="px-3 py-2">{money(c.supports)}</td>
                      <td className={"px-3 py-2 " + (m.owner_draws > c.supports ? "text-red-600" : "")}>{money(m.owner_draws)}</td>
                    </tr>
                  );
                })}
                {[
                  { name: "All final months", list: finalIds.map((id) => months[id]) },
                  { name: "Last 3 final", list: last3 },
                ]
                  .filter((s) => s.list.length)
                  .map((s) => {
                    const t = sumMonths(s.list);
                    const c = calcMonth(t, rate);
                    return (
                      <tr key={s.name} className="bg-gray-100 font-semibold text-right border-b border-gray-200">
                        <td className="text-left px-3 py-2">{s.name}</td>
                        <td className="px-3 py-2">{money(t.revenue)}</td>
                        <td className="px-3 py-2">{money(t.materials)}</td>
                        <td className="px-3 py-2">{money(c.after)}</td>
                        <td className="px-3 py-2">{money(c.out)}</td>
                        <td className="px-3 py-2">{hrs(c.h)}</td>
                        <td className="px-3 py-2">{money(c.cost)}</td>
                        <td className="px-3 py-2">{money(c.rec)}</td>
                        <td className={"px-3 py-2 " + signCls(c.margin)}>{money(c.margin)}</td>
                        <td className={"px-3 py-2 " + signCls(c.pre)}>{money(c.pre)}</td>
                        <td className={"px-3 py-2 " + signCls(c.prePct)}>{pct(c.prePct)}</td>
                        <td className={"px-3 py-2 " + signCls(c.profit)}>{money(c.profit)}</td>
                        <td className={"px-3 py-2 " + signCls(c.pct)}>{pct(c.pct)}</td>
                        <td className="px-3 py-2">{money(c.supports)}</td>
                        <td className="px-3 py-2">{money(t.owner_draws)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-3 mt-4 items-center">
            <button onClick={addNextMonth} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700">
              Add next month
            </button>
            {ids.length > 0 && (
              <button onClick={downloadCsv} className="px-4 py-2 border border-gray-300 rounded-md font-medium text-gray-700 hover:bg-gray-50">
                Download as spreadsheet (CSV)
              </button>
            )}
          </div>

          {editing && monthDraft && (
            <form onSubmit={saveMonth} autoComplete="off" className="bg-white border border-gray-200 rounded-lg p-5 mt-5">
              <h2 className="text-xl font-bold text-gray-900 mb-4">
                {monthLabel(editing)}
                {!months[editing] && <span className="ml-2 text-sm font-normal text-gray-500">(new)</span>}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {MONTH_INPUTS.map((f) => (
                  <div key={f.key}>
                    <label htmlFor={"m-" + f.key} className="block text-sm font-medium text-gray-700 mb-1">
                      {f.label}
                    </label>
                    <input
                      id={"m-" + f.key}
                      type="text"
                      inputMode="decimal"
                      value={monthDraft[f.key]}
                      onChange={(e) => setMonthDraft({ ...monthDraft, [f.key]: e.target.value })}
                      className={inputCls}
                    />
                    {f.hint && <p className="text-xs text-gray-500 mt-1">{f.hint}</p>}
                  </div>
                ))}
              </div>
              {fillNotes.length > 0 && (
                <ul className="mt-4 text-xs text-gray-600 list-disc pl-5 space-y-0.5">
                  {fillNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-4 mt-5">
                {qb?.connected && !months[editing]?.is_final && (
                  <button
                    type="button"
                    onClick={fillMonthFromQb}
                    disabled={busy}
                    className="px-4 py-2 border border-green-700 text-green-800 rounded-md font-medium hover:bg-green-50 disabled:opacity-50"
                  >
                    Fill from QuickBooks
                  </button>
                )}
                <label className="flex items-center gap-2 text-gray-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={monthDraft.is_final}
                    onChange={(e) => setMonthDraft({ ...monthDraft, is_final: e.target.checked })}
                    className="h-5 w-5 rounded border-gray-300"
                  />
                  Month is final
                </label>
                <button type="submit" disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">
                  {busy ? "Saving..." : "Save month"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setMonthDraft(null);
                    setFillNotes([]);
                  }}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium"
                >
                  Close
                </button>
                <Msg m={monthMsg} />
              </div>
            </form>
          )}
        </section>
      )}

      {/* ------------------------------------------------ Shop rate */}
      {tab === "rate" && rateDraft && liveBurden && liveRate && (
        <section className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6">
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">Crew</h2>
              <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
                    <tr>
                      <th className="text-left px-2 py-2 font-semibold">Name</th>
                      <th className="text-left px-2 py-2 font-semibold">$ / hr</th>
                      <th className="text-left px-2 py-2 font-semibold">Hrs / wk</th>
                      <th className="px-2 py-2 font-semibold">Shop hours?</th>
                      <th className="text-right px-2 py-2 font-semibold">Monthly pay</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rateDraft.crew.map((p, i) => {
                      const set = (patch: Partial<RateDraft["crew"][number]>) =>
                        setRateDraft({ ...rateDraft, crew: rateDraft.crew.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                      return (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="px-2 py-1">
                            <input aria-label="Name" value={p.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} />
                          </td>
                          <td className="px-2 py-1 w-24">
                            <input aria-label="Hourly rate" inputMode="decimal" value={p.rate} onChange={(e) => set({ rate: e.target.value })} className={inputCls} />
                          </td>
                          <td className="px-2 py-1 w-20">
                            <input aria-label="Hours per week" inputMode="decimal" value={p.hours} onChange={(e) => set({ hours: e.target.value })} className={inputCls} />
                          </td>
                          <td className="px-2 py-1 text-center">
                            <input type="checkbox" aria-label="Counts as shop hours" checked={p.shop} onChange={(e) => set({ shop: e.target.checked })} className="h-5 w-5" />
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">{money(crewMonthlyPay(liveRate.crew[i]))}</td>
                          <td className="px-2 py-1 text-right">
                            <button
                              type="button"
                              onClick={() => setRateDraft({ ...rateDraft, crew: rateDraft.crew.filter((_, j) => j !== i) })}
                              className="text-red-600 hover:text-red-800 text-xs font-medium"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                onClick={() => setRateDraft({ ...rateDraft, crew: [...rateDraft.crew, { name: "New hire", rate: "23", hours: "40", shop: true }] })}
                className="mt-3 px-3 py-1.5 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Add crew member
              </button>
            </div>

            <div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">Monthly costs</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {SCALARS.map((s) => (
                  <div key={s.key}>
                    <label htmlFor={"r-" + s.key} className="block text-sm font-medium text-gray-700 mb-1">
                      {s.label}
                    </label>
                    <input
                      id={"r-" + s.key}
                      inputMode="decimal"
                      value={rateDraft.fields[s.key]}
                      onChange={(e) => setRateDraft({ ...rateDraft, fields: { ...rateDraft.fields, [s.key]: e.target.value } })}
                      className={inputCls}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">Loan payments</h2>
              <div className="space-y-2">
                {rateDraft.debts.map((d, i) => {
                  const set = (patch: Partial<RateDraft["debts"][number]>) =>
                    setRateDraft({ ...rateDraft, debts: rateDraft.debts.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                  return (
                    <div key={i} className="flex gap-2 items-center">
                      <input aria-label="Loan name" value={d.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} />
                      <input aria-label="Monthly payment" inputMode="decimal" value={d.amount} onChange={(e) => set({ amount: e.target.value })} className={inputCls + " max-w-[9rem]"} />
                      <label className="flex items-center gap-1.5 text-xs text-gray-600 whitespace-nowrap cursor-pointer" title="Added to loan payments when a month is filled from QuickBooks">
                        <input type="checkbox" checked={d.outsideQb} onChange={(e) => set({ outsideQb: e.target.checked })} className="h-4 w-4 rounded border-gray-300" />
                        Paid outside QuickBooks
                      </label>
                      <button
                        type="button"
                        onClick={() => setRateDraft({ ...rateDraft, debts: rateDraft.debts.filter((_, j) => j !== i) })}
                        className="text-red-600 hover:text-red-800 text-xs font-medium"
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => setRateDraft({ ...rateDraft, debts: [...rateDraft.debts, { name: "New loan", amount: "0", outsideQb: false }] })}
                className="mt-3 px-3 py-1.5 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Add loan
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button onClick={saveRate} disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">
                {busy ? "Saving..." : "Save shop rate"}
              </button>
              <button
                type="button"
                onClick={fillRateFromActuals}
                disabled={busy || finalIds.length === 0}
                title="Overhead, shop supplies and actual draw from the average of the last 6 final months"
                className="px-4 py-2 border border-green-700 text-green-800 rounded-md font-medium hover:bg-green-50 disabled:opacity-50"
              >
                Fill from actuals (last 6 final months)
              </button>
              <Msg m={rateMsg} />
            </div>
          </div>

          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">How the rate stacks</h2>
            <div className="bg-white border border-gray-200 rounded-lg p-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums text-gray-800">
              <div>Shop hours worked / month</div><div className="text-right">{hrs(liveBurden.hours)}</div>
              <div>Payroll all-in / month</div><div className="text-right">{money(liveBurden.payroll)}</div>
              <div>Overhead + supplies / month</div><div className="text-right">{money(liveRate.overhead + liveRate.supplies)}</div>
              <div>Loan payments / month</div><div className="text-right">{money(liveBurden.debt)}</div>
              <div>Draw target / month</div><div className="text-right">{money(liveRate.drawTarget)}</div>
              <div className="font-semibold border-t-2 border-gray-800 pt-1">Total out, not materials</div>
              <div className="font-semibold border-t-2 border-gray-800 pt-1 text-right">{money(liveBurden.monthlyTotal)}</div>
              <div className="col-span-2 h-3" />
              <div>Operating burden / hr</div><div className="text-right">{money(liveBurden.op, 2)}</div>
              <div>+ loan payments / hr</div><div className="text-right">{money(liveBurden.withDebt, 2)}</div>
              <div className="font-semibold border-t-2 border-gray-800 pt-1">Fully loaded / hr</div>
              <div className="font-semibold border-t-2 border-gray-800 pt-1 text-right">{money(liveBurden.full, 2)}</div>
              <div>At actual draw of {money(liveRate.drawActual)}</div><div className="text-right">{money(liveBurden.fullActual, 2)}</div>
              <div>Margin at quoted {money(liveRate.quoted)}</div><div className="text-right">{money(liveRate.quoted - liveBurden.full, 2)}</div>
              <div>Left monthly if every hour is billed</div><div className="text-right">{money((liveRate.quoted - liveBurden.full) * liveBurden.hours)}</div>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-4 mt-4">
              <p className="text-sm text-gray-700">
                Burden rate job costing uses now (Settings): <span className="font-semibold tabular-nums">{money(settingsBurden, 2)}</span> / hr
              </p>
              {savedBurden && Number.isFinite(savedBurden.full) && Math.abs(savedBurden.full - (settingsBurden ?? 0)) >= 0.005 ? (
                <button
                  onClick={applyBurden}
                  disabled={busy}
                  className="mt-3 px-3 py-2 border border-gray-800 rounded-md text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-50"
                >
                  Use {money(savedBurden.full, 2)} as the ShopWorks burden rate
                </button>
              ) : (
                <p className="text-sm text-green-700 mt-2">Matches the saved fully loaded rate.</p>
              )}
              <p className="text-xs text-gray-500 mt-2">
                The button uses the last SAVED shop rate, so trying numbers out above never moves job costing. Save first, then apply.
              </p>
            </div>
            <p className="text-xs text-gray-500 mt-3">
              Update this whenever pay changes, someone is hired or leaves, a loan is added or paid off, or your draw target changes.
            </p>
          </div>
        </section>
      )}

      {/* ------------------------------------------------ Budget */}
      {tab === "budget" && (
        <section>
          {/* QuickBooks connection */}
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            {!qb ? (
              <p className="text-sm text-gray-600">Checking QuickBooks...</p>
            ) : !qb.configured ? (
              <p className="text-sm text-gray-600">
                QuickBooks isn&apos;t set up on this server yet{qb.error ? " (" + qb.error + ")" : ""}. Ceilings still work; spent and on-track fill in once it is.
              </p>
            ) : !qb.connected ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-gray-700">
                  Connect your QuickBooks company to see what has been spent this month against each ceiling.
                  {qb.staleEnvironment && " (The old connection was made to QuickBooks " + qb.staleEnvironment + " and needs connecting again.)"}
                </span>
                <button onClick={connectQb} className="ml-auto bg-green-700 text-white px-4 py-2 rounded-md font-medium hover:bg-green-800">
                  Connect QuickBooks
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-gray-700">
                  Connected to <span className="font-semibold text-gray-900">{qb.companyName || "your QuickBooks company"}</span>
                  {qb.environment === "sandbox" && <span className="ml-2 px-1.5 border border-yellow-400 text-xs rounded">sandbox</span>}
                </span>
                <button onClick={pullMonthToDate} disabled={qbBusy} className="ml-auto bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">
                  {qbBusy ? "Working..." : "Pull month to date"}
                </button>
                <button onClick={disconnectQb} disabled={qbBusy} className="px-3 py-2 text-sm text-gray-600 hover:text-red-700 disabled:opacity-50">
                  Disconnect
                </button>
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-x-4 text-sm">
              <Msg m={qbMsg} />
              {qbSnap && (
                <span className="text-gray-500">
                  Showing {qbSnap.start} to {qbSnap.end}
                  {qbSnap.pl.basis ? ", " + qbSnap.pl.basis.toLowerCase() + " basis" : ", basis not stated (pulled before 2026-09-28 fix - pull again)"}
                  , pulled {new Date(qbSnap.at).toLocaleString()}.
                  {qbSnap.start.slice(0, 7) !== monthId(today) && " That was an earlier month - pull again for this one."}
                </span>
              )}
            </div>
          </div>

          {qbSnap && (() => {
            const lines = liveBudget.categories.map((c) => ({ c, l: budgetLine(c, qbSnap, liveBudget) }));
            const capped = lines.filter((x) => !x.c.untracked);
            const tot = capped.reduce(
              (a, x) => ({ limit: a.limit + x.l.limit, spent: a.spent + x.l.spent, proj: a.proj + x.l.projected }),
              { limit: 0, spent: 0, proj: 0 }
            );
            return (
              <div className="flex flex-wrap gap-x-10 gap-y-3 bg-white border border-gray-200 rounded-lg p-4 mb-4">
                <div>
                  <div className="text-3xl font-semibold tabular-nums text-gray-900">{money(tot.spent)}</div>
                  <div className="text-sm text-gray-600">Spent so far (not materials, not payroll)</div>
                </div>
                <div>
                  <div className="text-3xl font-semibold tabular-nums text-gray-900">{money(tot.limit)}</div>
                  <div className="text-sm text-gray-600">Monthly ceiling</div>
                </div>
                <div>
                  <div className={"text-3xl font-semibold tabular-nums " + (tot.proj > tot.limit ? "text-red-600" : "")} style={tot.proj > tot.limit ? undefined : { color: "#1A7FA6" }}>
                    {money(tot.proj)}
                  </div>
                  <div className="text-sm text-gray-600">On track to finish the month at</div>
                </div>
              </div>
            );
          })()}

          <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Category</th>
                  <th className="text-left px-3 py-2 font-semibold">Monthly ceiling</th>
                  <th className="text-right px-3 py-2 font-semibold">Spent</th>
                  <th className="text-right px-3 py-2 font-semibold">Left</th>
                  <th className="text-right px-3 py-2 font-semibold">On track for</th>
                  <th className="text-right px-3 py-2 font-semibold">Used</th>
                  <th className="text-left px-3 py-2 font-semibold">QuickBooks accounts</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {budgetDraft.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-gray-600">
                      No categories yet. Add the overhead lines you want to keep a ceiling on.
                    </td>
                  </tr>
                )}
                {budgetDraft.map((c, i) => {
                  const set = (patch: Partial<BudgetDraft[number]>) => setBudgetDraft(budgetDraft.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  const live = draftToBudget([c]).categories[0];
                  const l = qbSnap ? budgetLine(live, qbSnap, liveBudget) : null;
                  const kind = c.untracked ? "tracked only" : c.fromCashFlow ? "from cash flow" : c.pctOfRevenue !== undefined ? "share of sales" : c.fixed ? "fixed monthly" : "builds through the month";
                  return (
                    <tr key={i} className="border-b border-gray-100 align-top">
                      <td className="px-3 py-1">
                        <input aria-label="Category name" value={c.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} />
                        <div className="text-xs text-gray-500 mt-0.5">{kind}</div>
                      </td>
                      <td className="px-3 py-1 w-48">
                        {c.untracked ? (
                          <span className="text-gray-500 inline-block pt-2">not capped</span>
                        ) : c.pctOfRevenue !== undefined ? (
                          <div className="flex items-center gap-2">
                            <input aria-label={c.name + " percent of sales"} inputMode="decimal" value={c.pctText} onChange={(e) => set({ pctText: e.target.value })} className={inputCls + " max-w-[6rem]"} />
                            <span className="text-gray-500 text-xs">of sales{l ? " = " + money(l.limit) : ""}</span>
                          </div>
                        ) : (
                          <input aria-label={c.name + " ceiling"} inputMode="decimal" value={c.limitText} onChange={(e) => set({ limitText: e.target.value })} className={inputCls} />
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{l ? money(l.spent) : "-"}</td>
                      <td className={"px-3 py-2 text-right tabular-nums " + (l && !c.untracked && l.left < 0 ? "text-red-600" : "")}>
                        {l && !c.untracked ? money(l.left) : "-"}
                      </td>
                      <td className={"px-3 py-2 text-right tabular-nums " + (l && !c.untracked ? (l.over ? "text-red-600 font-semibold" : "text-green-700") : "")}>
                        {l && !c.untracked ? money(l.projected) : "-"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{l && !c.untracked && l.share !== null ? pct(l.share) : "-"}</td>
                      <td className="px-3 py-1 min-w-[16rem]">
                        <input
                          aria-label={c.name + " QuickBooks accounts"}
                          value={c.matchText}
                          onChange={(e) => set({ matchText: e.target.value })}
                          placeholder={c.fromCashFlow ? "owner's draw account (optional)" : "account names, comma separated"}
                          className={inputCls + " text-xs"}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" onClick={() => setBudgetDraft(budgetDraft.filter((_, j) => j !== i))} className="text-red-600 hover:text-red-800 text-xs font-medium">
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-gray-100 font-semibold">
                  <td className="px-3 py-2">Total dollar ceilings</td>
                  <td className="px-3 py-2 tabular-nums" colSpan={7}>
                    {money(budgetDraft.filter((c) => !c.untracked && c.pctOfRevenue === undefined).reduce((a, c) => a + parseNum(c.limitText), 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <button
              type="button"
              onClick={() => setBudgetDraft([...budgetDraft, { name: "New category", limit: 0, match: [], limitText: "0", pctText: "", matchText: "" }])}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Add category
            </button>
            <button onClick={saveBudget} disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">
              {busy ? "Saving..." : "Save ceilings and accounts"}
            </button>
            <Msg m={budgetMsg} />
          </div>

          {qbSnap && (
            <details className="bg-white border border-gray-200 rounded-md p-3 mt-4 text-sm">
              <summary className="cursor-pointer font-semibold text-gray-900">What QuickBooks sent (to compare with your Profit and Loss)</summary>
              <p className="text-gray-600 mt-2 mb-2">
                Exactly what came back for {qbSnap.pl.period || qbSnap.start + " to " + qbSnap.end}
                {qbSnap.pl.basis ? " (" + qbSnap.pl.basis + ")" : ""}. Each line should match the same line on your QuickBooks report for the same dates and basis.
              </p>
              {[
                { title: "Profit and Loss", rep: qbSnap.pl },
                { title: "Statement of Cash Flows", rep: qbSnap.cf },
              ].map(({ title, rep }) => {
                const rows: { name: string; amount: number; depth: number; total: boolean }[] = [];
                const walk = (nodes: QbSnapshot["pl"]["groups"][string][], depth: number) => {
                  for (const n of nodes) {
                    if (n.children) {
                      if (n.children.length) walk(n.children, depth + 1);
                      rows.push({ name: "Total " + n.name, amount: n.amount, depth, total: true });
                    } else rows.push({ name: n.name, amount: n.amount, depth, total: false });
                  }
                };
                walk(Object.values(rep.groups), 0);
                return (
                  <div key={title} className="mt-3">
                    <p className="font-semibold text-gray-900">{title}</p>
                    <table className="w-full max-w-xl text-sm tabular-nums">
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i} className={r.total ? "font-semibold border-t border-gray-200" : ""}>
                            <td className="py-0.5" style={{ paddingLeft: r.depth * 16 }}>{r.name}</td>
                            <td className="py-0.5 text-right">{money(r.amount, 2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </details>
          )}

          {qbSnap && unmatched.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 mt-4 text-sm">
              <p className="font-semibold text-gray-900 mb-1">QuickBooks accounts not in any category this month</p>
              <p className="text-gray-600 mb-2">
                They still count in the monthly tracker as overhead. To track one against a ceiling, type its name into a category&apos;s QuickBooks accounts box and save.
              </p>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                {unmatched.map((u) => (
                  <li key={u.name} className="flex justify-between gap-3">
                    <span>{u.name}</span>
                    <span className="tabular-nums">{money(u.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-gray-500 mt-3 max-w-3xl">
            Ceilings cover overhead only. Materials, shop supplies and payroll move with the work, so they are tracked but not capped. &quot;On track for&quot; is where the month should land: spending that builds up through the month is scaled by how much of the month is left; fixed items like rent, insurance and your draw are just what has gone out, since they get paid once. Red means it lands over the ceiling. Account names must match QuickBooks exactly (capitals don&apos;t matter); naming a parent account counts everything under it.
          </p>
        </section>
      )}

      {/* ------------------------------------------------ How to fill it in */}
      {tab === "how" && (
        <dl className="max-w-3xl bg-white border border-gray-200 rounded-lg p-5 space-y-3 text-sm">
          {[
            ["Revenue", "QuickBooks, Profit and Loss for last month: Total for Income."],
            ["Materials (steel COGS)", "Same report: the Cost of Goods Sold line only, not labor or supplies."],
            ["Shop supplies", "Same report: Shop Supplies."],
            ["Payroll all-in", "Total for Payroll Expenses, plus Cost of Labor if anything is still coded there."],
            ["Other overhead", "Total for Expenses minus Total for Payroll Expenses, plus any Other Expenses."],
            ["Loan payments", "Every loan payment for the month, including any paid outside QuickBooks (an SBA loan through its servicer, for example). The Statement of Cash Flows, financing section, shows most of them."],
            ["Owner draws", "Statement of Cash Flows: the owner's draw account, entered as a positive number."],
            ["Equipment / vehicle buys", "Statement of Cash Flows, investing section, entered as positive."],
            ["New borrowing", "Any money borrowed that month: line of credit draws or new loans."],
            ["Crew hours worked", "Payroll details for the month: regular plus overtime hours for hourly crew. Leave out PTO, holiday and salaried hours."],
            ["Profit before draws", "Revenue minus steel, supplies, payroll, overhead, loan payments and equipment buys: what the business made before you took anything out."],
            ["Profit after everything", "The same, minus your draws too. New borrowing is left out, since borrowed money isn't profit. Margin is that profit as a share of revenue."],
            ["Draw it supports", "Operating profit, less the tax reserve, loan payments and the equipment fund from the Shop rate tab. Your draw shows red when it was more than that."],
            ["Fill from QuickBooks", "With QuickBooks connected (Budget tab), the month form has a Fill from QuickBooks button. It reads that month's Profit and Loss and Statement of Cash Flows and fills every box except crew hours, using the same rules as above and the account names on the Budget tab. Check the numbers, add anything paid outside QuickBooks and the crew hours, then Save month. It is not offered on a month already marked final."],
            ["Target", "The card above the tabs. Type the profit you want to keep each month after your draw and loans, and it shows the revenue that takes, the revenue after steel, and what each shop hour has to recover after steel (compare it with Recovered / hr in the tracker). Fixed costs come from the saved Shop rate, so update that first. The steel share is worked out from your final months. Shop supplies are already in the fixed costs, so they are not taken off again. The margins show what the target means as a share of sales, before and after your draw, next to what the last 3 final months achieved before draws."],
            ["Month is final", "Tick it once the numbers are complete. The banner at the top checks for it, and only final months count toward the recovered rate."],
          ].map(([t, d]) => (
            <div key={t}>
              <dt className="font-semibold text-gray-900">{t}</dt>
              <dd className="text-gray-600">{d}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
