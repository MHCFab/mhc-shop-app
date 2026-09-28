// ---------------------------------------------------------------------------
// Turning QuickBooks reports into Finances-page numbers. QUICKBOOKS-REPORT-V1
//
// Pure functions only - no network, no database, no secrets - so the server
// route can use parseReport() and the page can use the rest, and all of it
// can be checked on sample reports on its own.
//
// HOW QUICKBOOKS SHAPES A REPORT (Profit and Loss, Statement of Cash Flows):
// a tree of rows. A "Section" row has a Header (its name), child Rows, and a
// Summary (its total). A "Data" row is one account and its amount. The top
// level sections carry a `group`:
//   P&L        Income, COGS, GrossProfit, Expenses, NetOperatingIncome,
//              OtherIncome, OtherExpenses, NetOtherIncome, NetIncome
//   Cash flow  OperatingActivities, InvestingActivities, FinancingActivities,
//              and some totals
// A parent account appears as a Section named after it; money posted to the
// parent itself shows up as a Data row inside it with the same name.
//
// MATCHING: a budget category lists QuickBooks account names. A name matches
// an account (case-insensitive) when it equals the account's name, or the
// last part of a "Parent:Child" name. When it matches a PARENT, the parent's
// total is used and its children are not counted again.
// ---------------------------------------------------------------------------

import type { BudgetCategory, BudgetConfig, MonthField } from "./finance-math";

export type QbNode = {
  name: string;
  amount: number; // a section's total, or an account's amount
  children?: QbNode[];
};

// A parsed report: its top-level sections, keyed by QuickBooks' group name.
export type QbReport = {
  groups: Record<string, QbNode>;
  // What QuickBooks itself says it ran (from the report header), so the page
  // can show it and nobody has to guess: "Accrual" or "Cash", and the dates.
  basis?: string;
  period?: string;
};

export type QbSnapshot = {
  at: string; // when it was pulled (ISO)
  start: string; // 'YYYY-MM-DD'
  end: string; // 'YYYY-MM-DD'
  realm?: string;
  companyName?: string | null;
  pl: QbReport;
  cf: QbReport;
};

// ---- parsing ---------------------------------------------------------------

type RawCol = { value?: string };
type RawRow = {
  type?: string;
  group?: string;
  ColData?: RawCol[];
  Header?: { ColData?: RawCol[] };
  Summary?: { ColData?: RawCol[] };
  Rows?: { Row?: RawRow[] };
};

function amountOf(cols: RawCol[] | undefined): number {
  if (!cols || cols.length < 2) return 0;
  // The last column is the total (the only money column unless the report was
  // asked to split by month, which we never do).
  const raw = String(cols[cols.length - 1]?.value ?? "").replace(/[$,\s]/g, "");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function nameOf(cols: RawCol[] | undefined): string {
  return String(cols?.[0]?.value ?? "").trim();
}

function parseRow(r: RawRow): QbNode | null {
  const isSection = r.type === "Section" || !!r.Rows || !!r.Header || !!r.Summary;
  if (!isSection) {
    const name = nameOf(r.ColData);
    if (!name) return null;
    return { name, amount: amountOf(r.ColData) };
  }
  const children = (r.Rows?.Row || []).map(parseRow).filter((n): n is QbNode => n !== null);
  const headerName = nameOf(r.Header?.ColData);
  const summaryName = nameOf(r.Summary?.ColData).replace(/^Total( for)?\s+/i, "");
  const name = headerName || summaryName || r.group || "";
  // Some sections have no Summary (rare); fall back to adding the children.
  const amount = r.Summary?.ColData ? amountOf(r.Summary.ColData) : children.reduce((a, c) => a + c.amount, 0);
  return { name, amount, children };
}

export function parseReport(json: unknown): QbReport {
  const rows = ((json as { Rows?: { Row?: RawRow[] } })?.Rows?.Row || []) as RawRow[];
  const groups: Record<string, QbNode> = {};
  for (const r of rows) {
    const node = parseRow(r);
    if (!node) continue;
    const key = r.group || node.name;
    if (key) groups[key] = node;
  }
  const h = (json as { Header?: { ReportBasis?: string; StartPeriod?: string; EndPeriod?: string } })?.Header;
  return {
    groups,
    basis: h?.ReportBasis || undefined,
    period: h?.StartPeriod && h?.EndPeriod ? h.StartPeriod + " to " + h.EndPeriod : undefined,
  };
}

// ---- matching --------------------------------------------------------------

function norm(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function nameMatches(accountName: string, wanted: string): boolean {
  const a = norm(accountName);
  const w = norm(wanted);
  if (!w) return false;
  if (a === w) return true;
  const last = a.split(":").pop()?.trim() ?? a;
  return last === w;
}

// Sum every account in `nodes` that one of `names` matches. A matched parent
// counts once, with its total, and its children are not visited.
export function sumMatches(nodes: QbNode[], names: string[]): number {
  if (!names.length) return 0;
  let total = 0;
  const walk = (list: QbNode[]) => {
    for (const n of list) {
      if (names.some((w) => nameMatches(n.name, w))) total += n.amount;
      else if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return total;
}

// The accounts (leaf rows) under `nodes`, with their parent path.
export function leaves(nodes: QbNode[], path: string[] = []): { name: string; path: string[]; amount: number }[] {
  const out: { name: string; path: string[]; amount: number }[] = [];
  for (const n of nodes) {
    if (n.children && n.children.length) out.push(...leaves(n.children, [...path, n.name]));
    else if (!n.children) out.push({ name: n.name, path, amount: n.amount });
  }
  return out;
}

const COST_GROUPS = ["COGS", "Expenses", "OtherExpenses"];

function costNodes(pl: QbReport): QbNode[] {
  return COST_GROUPS.map((g) => pl.groups[g]).filter((n): n is QbNode => !!n).map((n) => n.children || []).flat();
}

function groupTotal(r: QbReport, g: string): number {
  return r.groups[g]?.amount ?? 0;
}

// ---- owner draws and the cash flow report -----------------------------------

const DRAW_RE = /(member|owner|partner|shareholder)'?s?\s*(draw|distribution)|^draws?$|^distributions?$/i;
const EQUITY_RE = /contribution|investment|capital|equity|stock|retained|opening balance/i;

function financingLeaves(cf: QbReport) {
  return leaves(cf.groups.FinancingActivities?.children || []);
}

function isDraw(name: string, drawNames: string[]): boolean {
  if (drawNames.length) return drawNames.some((w) => nameMatches(name, w));
  const last = name.split(":").pop()?.trim() ?? name;
  return DRAW_RE.test(last) || DRAW_RE.test(name);
}

// Owner draws for the period, as a positive number. Uses the draw category's
// account list when it has one, otherwise anything that looks like an owner's
// or member's draw in the financing section.
export function ownerDraws(cf: QbReport, drawNames: string[] = []): number {
  const total = financingLeaves(cf)
    .filter((l) => isDraw(l.name, drawNames))
    .reduce((a, l) => a + l.amount, 0);
  return total ? -total : 0; // money going out shows negative on the report
}

// ---- the Budget tab ----------------------------------------------------------

export type BudgetLine = {
  spent: number;
  limit: number;
  left: number;
  projected: number; // "on track for"
  share: number | null; // spent / limit
  over: boolean;
};

// How far through the month the snapshot's end date is, 0..1.
export function monthShare(endDate: string): number {
  const [y, m, d] = endDate.split("-").map(Number);
  if (!y || !m || !d) return 1;
  const days = new Date(y, m, 0).getDate();
  return Math.min(1, Math.max(0, d / days));
}

function drawCategoryNames(b: BudgetConfig): string[] {
  const c = b.categories.find((x) => x.fromCashFlow);
  return c ? c.match : [];
}

export function budgetLine(c: BudgetCategory, snap: QbSnapshot, budget: BudgetConfig): BudgetLine {
  const income = groupTotal(snap.pl, "Income");
  const limit = c.pctOfRevenue !== undefined ? income * c.pctOfRevenue : c.limit;
  const spent = c.fromCashFlow ? ownerDraws(snap.cf, drawCategoryNames(budget)) : sumMatches(costNodes(snap.pl), c.match);
  const share = monthShare(snap.end);
  const oneOff = c.fixed || c.fromCashFlow || c.pctOfRevenue !== undefined;
  const projected = oneOff || !share ? spent : spent / share;
  return {
    spent,
    limit,
    left: limit - spent,
    projected,
    share: limit ? spent / limit : null,
    over: !c.untracked && projected > limit + 0.005,
  };
}

// Cost accounts on the P&L that no budget category claims. Shown under the
// Budget table so a shop can see what to add to a category's account list.
export function unmatchedAccounts(snap: QbSnapshot, budget: BudgetConfig): { name: string; amount: number }[] {
  const names = budget.categories.filter((c) => !c.fromCashFlow).flatMap((c) => c.match);
  const out: { name: string; amount: number }[] = [];
  const walk = (list: QbNode[]) => {
    for (const n of list) {
      if (names.some((w) => nameMatches(n.name, w))) continue;
      if (n.children && n.children.length) walk(n.children);
      else if (!n.children && Math.abs(n.amount) >= 0.005) out.push({ name: n.name, amount: n.amount });
    }
  };
  walk(costNodes(snap.pl));
  return out;
}

// ---- the month form ------------------------------------------------------------

// Which budget category stands for materials / payroll / shop supplies. Found
// by name, with sensible QuickBooks account names to fall back on.
function roleNames(b: BudgetConfig, re: RegExp, fallback: string[]): string[] {
  const c = b.categories.find((x) => re.test(x.name) && x.match.length);
  return c ? c.match : fallback;
}

export type MonthFill = {
  values: Partial<Record<MonthField, number>>;
  notes: string[];
};

// The month form's boxes, from a P&L and cash flow for that month. Crew hours
// are never filled - they are not in QuickBooks.
export function monthFromReports(pl: QbReport, cf: QbReport, budget: BudgetConfig): MonthFill {
  const costs = costNodes(pl);
  const costTotal = COST_GROUPS.reduce((a, g) => a + groupTotal(pl, g), 0);

  const materials = sumMatches(costs, roleNames(budget, /material/i, ["Cost of Goods Sold", "Materials"]));
  const payroll = sumMatches(costs, roleNames(budget, /payroll|wage/i, ["Payroll Expenses", "Wages", "Salaries and Wages", "Payroll Taxes", "Cost of Labor"]));
  const supplies = sumMatches(costs, roleNames(budget, /shop suppl/i, ["Shop Supplies"]));
  // Everything else that cost money on the P&L, so the four always add up to
  // the report's own totals and nothing falls through the cracks.
  const overhead = costTotal - materials - payroll - supplies;

  const drawNames = drawCategoryNames(budget);
  let draws = 0;
  let debt = 0;
  let borrowing = 0;
  const skipped: string[] = [];
  for (const l of financingLeaves(cf)) {
    if (!l.amount) continue;
    if (isDraw(l.name, drawNames)) draws -= l.amount;
    else if (EQUITY_RE.test(l.name)) skipped.push(l.name);
    else if (l.amount < 0) debt -= l.amount;
    else borrowing += l.amount;
  }
  let equipment = 0;
  for (const l of leaves(cf.groups.InvestingActivities?.children || [])) {
    if (l.amount < 0) equipment -= l.amount;
  }

  const round = (v: number) => Math.round(v * 100) / 100;
  const notes = [
    "Loan payments only count what went through QuickBooks. Add anything paid outside it, like an SBA loan through its servicer.",
    "A loan you both paid and drew on in the same month shows as the difference, on whichever side it landed.",
    "Crew hours are not in QuickBooks. Enter them from payroll.",
  ];
  if (skipped.length) notes.push("Left out as owner money, not loans: " + Array.from(new Set(skipped)).join(", ") + ".");

  return {
    values: {
      revenue: round(groupTotal(pl, "Income")),
      materials: round(materials),
      supplies: round(supplies),
      payroll: round(payroll),
      overhead: round(overhead),
      debt_payments: round(debt),
      owner_draws: round(draws),
      equipment: round(equipment),
      new_borrowing: round(borrowing),
    },
    notes,
  };
}
