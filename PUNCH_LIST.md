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

### 5. Phase 2 — jobs pull finished sub-assemblies from fabricated stock
When a product's recipe includes a stockable sub-assembly, a job should pull the finished unit from
fabricated stock instead of re-expanding it into raw material + tasks. Needs: stop expansion at stockable
subs, a `'fabricated'` allocation type (schema change), a consumption ledger entry, an extended shortfall
alert, and an employee SELECT policy on `fabricated_inventory`. Costing of the pulled unit (LIFO vs the
captured per-unit cost) to be decided — see #4.

### 6. Phase 3 — shared-nest builds + reorder targets
Build multiple stockable items from a shared cutting nest; set reorder points/targets per fabricated item.

## Done (this work)
- Phase 1 fabricated sub-assemblies (stockable flag, build orders, receive-to-stock, Fabricated tab). Deployed.
- Purchased-part delete: accurate in-use check + safe cleanup.
- Stockable toggle + opening stock on the template create/edit form.
