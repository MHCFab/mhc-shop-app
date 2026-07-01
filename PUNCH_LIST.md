# ShopWorks — Punch List

Running list of issues and improvements to work through. Newest context at top of each item.

## Costing accuracy (raised 2026-06-26, during fabricated-inventory setup)

### 1. Auto-update catalog cost when stock comes in  *(requirement)*
Erik should never have to manually edit the cost on a raw material, purchased part, or fabricated
item. It should update automatically:
- **Raw material / purchased part:** when a purchase is added (and likely a manual adjustment with a
  cost), set the item's catalog cost (`current_cost_per_foot` / `current_cost_each`) to that cost.
- **Fabricated item:** already automatic — each build receipt / opening-stock entry captures its own
  cost per unit; the Fabricated tab shows the latest. No catalog cost field to maintain.
- Open decision: always overwrite catalog cost with the most recent purchase cost? (Recommended, and it
  makes job costing track current prices automatically.)

### 2. LIFO not updating after a higher-cost purchase  *(bug)*
Symptom: received a material at a higher cost than existing stock, but the LIFO $/ft column didn't change.
Cause (in `getAvailableRawMaterials` / parts): LIFO = most recent inventory row by `purchase_date`, but
the calc includes the **negative** rows from cutting-nest pulls and saved drops (at older costs) and does
not break ties when rows share the same date. So a same-day pull/drop or a date tie can mask the new
purchase. Fix: compute LIFO from **positive stock-in rows only**, ordered by `purchase_date` then
`created_at` (or id) descending. (Largely moot for job costing if #1 lands, but the LIFO column should
still be correct.)

### 3. Raw-material detail page shows no purchase history  *(bug/gap)*
The material page (`app/admin/inventory/material/[id]/page.tsx`) shows "Available lengths" but no
purchase-history table. The purchased-part page already has one — mirror it here (date, supplier, qty,
cost/ft, notes).

### 4. Fabricated unit-cost basis  *(decision)*
Build receipts value material/parts at the catalog **current cost**, not the LIFO cost of the specific
batches the build consumed (the job cost report uses `current_cost_per_foot` / `current_cost_each`). So a
received fabricated unit's cost = current-catalog material + current-catalog parts + actual labor ÷ units.
Decide whether fabricated cost should instead use true LIFO/actual consumed cost. Ties into Phase 2
consumption costing. (Note: if #1 makes catalog cost = latest purchase cost, current-cost and LIFO largely
converge.)

## Fabricated sub-assemblies — remaining phases

### 5. Phase 2 — jobs pull finished sub-assemblies from fabricated stock  *(DONE, pending deploy)*
When a product's recipe includes a stockable sub-assembly, a job now pulls the finished unit from
fabricated stock instead of re-expanding it into raw material + tasks. Final design (after iteration):
fabricated consumption **mirrors purchased parts** — a job soft-reserves fabricated units in
`inventory_allocations` (item_type `'fabricated'`, new `product_template_id` column) at release; the
`fabricated_inventory` ledger is NOT auto-decremented (only builds / opening / manual adjust move it).
Shortfall = total on-hand − other jobs' fabricated reservations, warn-but-allow. Cost report values each
pulled unit at the fabricated item's "highest cost on hand" × planned qty (no separate actuals workflow).
No employee policy added — fabricated stock/cost stays admin-only like raw materials; the floor sees the
item via the pick list. Schema: `fabricated-phase2-schema.sql` (product_template_id on
job_pick_list_items + inventory_allocations, item_type CHECKs widened to include 'fabricated').

### 6. Phase 3 — shared-nest builds + reorder targets
- **Reorder targets — DONE, deployed 2026-06-27.** `product_templates.reorder_point` + `reorder_target`
  (schema `fabricated-phase3-reorder-schema.sql`). Set on the template Settings tab (stockable only).
  `getFabricatedStock` returns reorderPoint/reorderTarget/belowReorder/suggestedBuild (compared against
  raw on-hand, not net of reservations — Erik's call). Surfaced: Reorder badge + point/target columns +
  low count on the inventory Fabricated tab; point/target/suggested-build + New build order button on the
  fabricated detail page; "Fabricated items to reorder" widget (most-short-first) on the admin dashboard.
- **Shared-nest builds — STILL TO DO.** Build multiple stockable items from one shared cutting nest.
  (Next fresh session.)

## Batch B — costing UI (DONE, pending deploy)
- Raw-material detail page: Stock / History tabs; purchase & price history table with a Type column; headline shows computed cost on hand.
- New fabricated detail page (Overview + History tabs); Fabricated tab "View item" now links there.
- Material and part detail headers show the computed "highest cost on hand" instead of the seed catalog cost.

## Done (deployed)
- **Reservation double-count → negative available / false shortage (fixed, pending deploy 2026-07-01).**
  Finalizing a cutting nest set each job's raw-material reservation to its *net consumed*, but that material
  had already left stock via the pulls — so it was subtracted twice (e.g. 1.25x.095 ERW showed -32.25 ft).
  Fix (Option 1, read-only): a raw-material reservation now = max(0, reserved − already pulled), applied in
  `getAvailableRawMaterials` and `getJobStockShortfall`. Finalized/cut jobs stop reserving stock they took;
  fixes current stuck numbers live, no schema/SQL. Also handles partially-cut jobs.
- **Undo a pull now deletes the transaction (pending deploy 2026-07-01).** `reverseCuttingNestEntry` used to
  insert a compensating 'reversal' +row and leave the original pull; now it deletes the pull's inventory row
  (via `created_inventory_id`, now stored by `pullSticks`; legacy pulls matched by job/material/length).
- **Stock alert didn't clear after purchases (fixed, pending deploy 2026-07-01).** `getJobStockShortfall`
  subtracted reservations from ALL other jobs, including already-**complete** jobs that keep their
  `inventory_allocations` rows until they're invoiced/archived. So finished jobs phantom-held stock and
  buying material/parts could never clear an active job's alert. Fix: the shortfall now ignores allocations
  belonging to jobs with status 'complete'. Read-only change in `app/lib/inventory.ts`; no schema change.
- Phase 1 fabricated sub-assemblies (stockable flag, build orders, receive-to-stock, Fabricated tab).
- Purchased-part delete: accurate in-use check + safe cleanup.
- Stockable toggle + opening stock on the template create/edit form.
- Costing rule "highest cost still on hand" live across the inventory list and the job cost report
  (items 1, 2, and part of 4 above). entry_type schema + tagging in place. LIFO columns relabeled "Cost".
  Item 3 (material purchase-history table) and the detail-page cost display are the remaining Batch B work.
