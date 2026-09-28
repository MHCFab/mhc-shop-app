// ---------------------------------------------------------------------------
// The Finances page's arithmetic, kept apart from the screen so the numbers
// can be checked on their own and so the QuickBooks pull (next session) can
// reuse them. Every formula here is the one the Claude tracker used, carried
// over unchanged so the numbers match what Erik has been looking at.
// FINANCE-MATH-V1
// ---------------------------------------------------------------------------

export type CrewMember = {
  name: string;
  rate: number; // $ per hour
  hours: number; // hours per week
  shop: boolean; // do their hours count as billable shop hours?
};

export type Debt = { name: string; amount: number; outsideQb?: boolean }; // outsideQb: paid outside QuickBooks, added to QuickBooks fills

// The Shop rate tab. Stored as one jsonb blob in finance_settings.rate.
// Percentages are stored as fractions: 0.0782 means 7.82%.
export type RateConfig = {
  crew: CrewMember[];
  debts: Debt[];
  taxPct: number;
  match: number;
  fees: number;
  workedPct: number;
  overhead: number;
  supplies: number;
  drawTarget: number;
  drawActual: number;
  quoted: number;
  taxReserve: number;
  equipFund: number;
  targetProfit: number; // the Target card: profit to keep each month AFTER draw + loans
};

export type BudgetCategory = {
  name: string;
  limit: number;
  match: string[]; // QuickBooks account names that feed it (used by the QuickBooks pull)
  fixed?: boolean; // paid once a month, so "on track for" is just what has gone out
  fromCashFlow?: boolean; // owner draws: comes from the cash flow report, not the P&L
  pctOfRevenue?: number; // ceiling is a share of sales instead of a dollar figure
  untracked?: boolean; // shown but never capped (materials, payroll)
};

export type BudgetConfig = { categories: BudgetCategory[] };

// One month, as the finance_months table holds it.
export type MonthRow = {
  month: string; // 'YYYY-MM'
  revenue: number;
  materials: number;
  supplies: number;
  payroll: number;
  overhead: number;
  debt_payments: number;
  owner_draws: number;
  equipment: number;
  new_borrowing: number;
  crew_hours: number;
  is_final: boolean;
};

export const MONTH_FIELDS = [
  "revenue",
  "materials",
  "supplies",
  "payroll",
  "overhead",
  "debt_payments",
  "owner_draws",
  "equipment",
  "new_borrowing",
  "crew_hours",
] as const;
export type MonthField = (typeof MONTH_FIELDS)[number];

export const EMPTY_RATE: RateConfig = {
  crew: [],
  debts: [],
  taxPct: 0.0765,
  match: 0,
  fees: 0,
  workedPct: 0.95,
  overhead: 0,
  supplies: 0,
  drawTarget: 0,
  drawActual: 0,
  quoted: 0,
  taxReserve: 0.2,
  equipFund: 0,
  targetProfit: 0,
};

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

// Fill in anything missing, so a half-empty row from the database never
// turns into NaN on screen.
export function normaliseRate(raw: unknown): RateConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const crew = Array.isArray(r.crew) ? r.crew : [];
  const debts = Array.isArray(r.debts) ? r.debts : [];
  return {
    crew: crew.map((p: Record<string, unknown>) => ({
      name: String(p?.name ?? ""),
      rate: n(p?.rate),
      hours: n(p?.hours),
      shop: !!p?.shop,
    })),
    debts: debts.map((d: Record<string, unknown>) => {
      const out: Debt = { name: String(d?.name ?? ""), amount: n(d?.amount) };
      if (d?.outsideQb === true) out.outsideQb = true;
      return out;
    }),
    taxPct: r.taxPct == null ? EMPTY_RATE.taxPct : n(r.taxPct),
    match: n(r.match),
    fees: n(r.fees),
    workedPct: r.workedPct == null ? EMPTY_RATE.workedPct : n(r.workedPct),
    overhead: n(r.overhead),
    supplies: n(r.supplies),
    drawTarget: n(r.drawTarget),
    drawActual: n(r.drawActual),
    quoted: n(r.quoted),
    taxReserve: r.taxReserve == null ? EMPTY_RATE.taxReserve : n(r.taxReserve),
    equipFund: n(r.equipFund),
    targetProfit: n(r.targetProfit),
  };
}

export function normaliseBudget(raw: unknown): BudgetConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cats = Array.isArray(r.categories) ? r.categories : [];
  return {
    categories: cats.map((c: Record<string, unknown>) => ({
      name: String(c?.name ?? ""),
      limit: n(c?.limit),
      match: Array.isArray(c?.match) ? (c.match as unknown[]).map(String) : [],
      fixed: !!c?.fixed || undefined,
      fromCashFlow: !!c?.fromCashFlow || undefined,
      pctOfRevenue: c?.pctOfRevenue == null ? undefined : n(c.pctOfRevenue),
      untracked: !!c?.untracked || undefined,
    })),
  };
}

export function normaliseMonth(raw: Record<string, unknown>): MonthRow {
  const m = { month: String(raw.month), is_final: !!raw.is_final } as MonthRow;
  for (const f of MONTH_FIELDS) m[f] = n(raw[f]);
  return m;
}

export const WEEKS_PER_MONTH = 52 / 12;

export function crewMonthlyPay(p: CrewMember) {
  return p.rate * p.hours * WEEKS_PER_MONTH;
}

export type Burden = {
  gross: number;
  payroll: number;
  opCost: number;
  debt: number;
  hours: number;
  op: number; // operating burden per shop hour
  withDebt: number; // + loan payments
  full: number; // + draw target: the fully loaded rate
  fullActual: number; // at the actual average draw instead
  monthlyTotal: number;
};

export function burden(c: RateConfig): Burden {
  const gross = c.crew.reduce((a, p) => a + crewMonthlyPay(p), 0);
  const payroll = gross * (1 + c.taxPct) + c.match + c.fees;
  const opCost = payroll + c.overhead + c.supplies;
  const debt = c.debts.reduce((a, d) => a + d.amount, 0);
  const hours = c.crew.reduce((a, p) => a + (p.shop ? p.hours : 0), 0) * WEEKS_PER_MONTH * (c.workedPct || 1);
  const h = hours || NaN;
  return {
    gross,
    payroll,
    opCost,
    debt,
    hours,
    op: opCost / h,
    withDebt: (opCost + debt) / h,
    full: (opCost + debt + c.drawTarget) / h,
    fullActual: (opCost + debt + c.drawActual) / h,
    monthlyTotal: opCost + debt + c.drawTarget,
  };
}

export type MonthCalc = {
  after: number; // revenue after steel
  out: number; // everything out that isn't materials
  h: number;
  cost: number; // per crew hour
  rec: number; // recovered per crew hour
  margin: number;
  pre: number; // profit before draws
  prePct: number;
  profit: number; // profit after everything
  pct: number;
  supports: number; // the draw this month could support
};

type Totals = Omit<MonthRow, "month" | "is_final">;

export function calcMonth(m: Totals, rate: RateConfig | null): MonthCalc {
  const after = m.revenue - m.materials;
  const out = m.supplies + m.payroll + m.overhead + m.debt_payments + m.owner_draws;
  const h = m.crew_hours;
  const tr = rate ? rate.taxReserve : 0.2;
  const ef = rate ? rate.equipFund : 0;
  const operating = m.revenue - m.materials - m.supplies - m.payroll - m.overhead;
  const supports = Math.max(0, operating * (1 - tr) - m.debt_payments - ef);
  const profit = operating - m.debt_payments - m.owner_draws - m.equipment;
  const pre = profit + m.owner_draws;
  return {
    after,
    out,
    h,
    cost: h ? out / h : NaN,
    rec: h ? after / h : NaN,
    margin: h ? (after - out) / h : NaN,
    pre,
    prePct: m.revenue ? pre / m.revenue : NaN,
    profit,
    pct: m.revenue ? profit / m.revenue : NaN,
    supports,
  };
}

// ---- the Target card (FINANCE-TARGET-V1, 2026-09-28) --------------------------
// Revenue needed for a profit target:
//   revenue = (fixed monthly costs + target profit) / (1 - steel share)
// Fixed costs are the SAVED shop rate's monthly total: payroll all-in,
// overhead, shop supplies, loan payments and the draw target. Shop supplies are
// already in there, so they are NOT taken off as a share of sales as well -
// that would count them twice. The target is what is left in the business
// after the draw and loans, so a target of 0 is break-even with the draw paid.

// Steel (materials) as a share of revenue across the given months.
export function steelShare(list: MonthRow[]): { pct: number; count: number } {
  const rev = list.reduce((a, m) => a + m.revenue, 0);
  const mat = list.reduce((a, m) => a + m.materials, 0);
  return { pct: rev > 0 ? mat / rev : NaN, count: list.length };
}

export type TargetPlan = {
  fixed: number; // everything out that isn't steel, per month
  revenue: number; // revenue needed
  afterSteel: number; // revenue after steel needed (= fixed + target)
  hours: number; // shop hours to sell at the quoted rate
  capacity: number; // shop hours the crew actually works in a month
  maxProfit: number; // kept if every shop hour is sold at the quoted rate
  rateNeeded: number; // $/hr needed to hit the target on capacity alone
  marginAfter: number; // target / revenue: margin after draw, loans, everything
  preDraw: number; // profit before the draw at the target (target + draw target)
  marginPre: number; // preDraw / revenue - same basis as the tracker's "Margin before draws"
};

export function targetPlan(c: RateConfig, steelPct: number, target: number): TargetPlan {
  const b = burden(c);
  const fixed = b.monthlyTotal;
  const afterSteel = fixed + target;
  const keep = 1 - steelPct;
  const cap = b.hours || NaN;
  const revenue = keep > 0 ? afterSteel / keep : NaN;
  const preDraw = target + c.drawTarget;
  return {
    fixed,
    revenue,
    afterSteel,
    hours: c.quoted ? afterSteel / c.quoted : NaN,
    capacity: b.hours,
    maxProfit: c.quoted * cap - fixed,
    rateNeeded: afterSteel / cap,
    marginAfter: revenue ? target / revenue : NaN,
    preDraw,
    marginPre: revenue ? preDraw / revenue : NaN,
  };
}

export function sumMonths(list: MonthRow[]): Totals {
  const t = {} as Totals;
  for (const f of MONTH_FIELDS) t[f] = list.reduce((a, m) => a + m[f], 0);
  return t;
}

// ---- formatting -----------------------------------------------------------

export function money(v: number | null | undefined, digits = 0) {
  if (v == null || !Number.isFinite(v)) return "—";
  const s =
    "$" +
    Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return v < 0 ? "(" + s + ")" : s;
}

export function pct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = Math.abs(v * 100).toFixed(1) + "%";
  return v < 0 ? "(" + s + ")" : s;
}

export function hrs(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// "$1,234.50", "12%", " 40 " -> number. Anything unreadable is 0.
export function parseNum(s: string) {
  const x = parseFloat(String(s || "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(id: string) {
  const [y, m] = id.split("-");
  return MONTH_NAMES[Number(m) - 1] + " " + y;
}

export function monthId(d: Date) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

export function nextMonthId(id: string) {
  const [y, m] = id.split("-").map(Number);
  return monthId(new Date(y, m, 1));
}
