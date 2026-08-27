# P0 Security Audit — ShopWorks

**Run 2026-08-21. Code review complete. Database review complete. All four fixes APPLIED to production 2026-08-21 and verified (PART 2 returned four OKs).**

This is the gate before any other shop's data goes into the database. The
question it answers: *if Shop B logs in tomorrow, is there any way they can
see or change Shop A's data — and vice versa?*

**Headline: the shop-to-shop wall is solid. The problems are all inside your
own shop — customer portal logins and switched-off employees reaching things
they shouldn't.**

Files that go with this one:

- `security-audit-readonly.sql` — the six read-only queries this is based on
- `security-audit-fixes.sql` — the fixes, in reviewable order

---

## What was checked

| Area | Result |
|---|---|
| The 6 routes that use the master (service role) key | **Clean** |
| Row security on all 36 tables | **On everywhere, no table without rules** |
| All 90 rules, read line by line | 10 too loose (all within one shop) |
| The 4 gatekeeper functions | 1 of 4 missing an "is this account still active" check |
| Owner-power functions and views | **Clean** — no views at all, all functions locked to a fixed search path |
| Photo storage | **Wide open to every signed-in user** |
| Existing data crossed between shops | **Zero** — every one of 9 checks came back 0 |
| Sign-in page, committed secrets, browser code | **Clean** |

---

## The four fixes — APPLIED 2026-08-21

All four are live on production. They were rules and one function only, so
they took effect immediately — nothing to build, push or deploy. The undo for
each one is at the bottom of `security-audit-fixes.sql`, and that undo section
is now the only record of what the rules said before.

### 1. Switching an employee off doesn't fully switch them off — MEDIUM, live today

`current_company_id()` is the function that answers "which shop is this
person in," and every rule in the database leans on it. Its three sibling
functions all check the account is still active. This one never did:

```sql
SELECT company_id FROM profiles WHERE id = auth.uid();
```

Eight rules ask only "same shop?" and stop there, so a deactivated employee
keeps access to raw material stock and inventory reservations until their
login is deleted outright. One line on one function closes it on every table
at once.

### 2. Customer portal logins can reach staff tables — MEDIUM, live today

Those same eight rules let a customer portal account read your stock levels
and reservations, and insert rows into raw material inventory, cutting nest
entries, inventory allocations and material variances. Nothing in the portal
does this — a customer would have to hand-craft API calls — but the door is
unlocked.

All eight were added *after* the customer-portal security clean-up in July,
so they simply missed the "staff only" guard every older rule got. The fix is
the same one-line addition to each: `AND is_shop_user()`.

### 3. Invitations reach across shops — LOW

The "mark my own invitation accepted" rules match on email address alone,
with no shop check. It's the only rule in the entire database that can touch
another shop's row. It only flips a status field.

### 4. Product photos are open to everyone — HIGH, live today

All three storage rules ask only *"is this the product-photos bucket?"*:

```
view    → any signed-in user
upload  → any signed-in user
delete  → any signed-in user
```

Any customer portal login could **delete every product photo you have**. Once
a second shop exists, they could browse and delete yours too. The bucket
itself is private (no photo can be pulled by URL without a signed link), so
this is about who's allowed to make those links.

Easy to fix: every photo is already stored under `<shop id>/<product id>/<file>`,
so checking the first folder against the caller's shop is enough. Nothing
moves, nothing re-uploads.

---

## Cleared — worth knowing these came back good

- **An employee cannot make themselves an admin.** The only write rule on
  profiles is *is an admin **and** same shop*. This was the one that could
  have been ugly.
- **No data is crossed between shops today.** Nine parent/child checks, all zero.
- **No table is missing row security**, and none is missing rules.
- **The `{public}` in the roles column is normal**, not a hole — every rule
  still requires a shop, which is empty for anyone not signed in.
- **All owner-power functions have a fixed `search_path`** — the classic
  Supabase escalation trick is already shut.
- **Only one trigger on the login table, AFTER INSERT only** — so an existing
  user can't rewrite their own role by editing their profile metadata.

---

## Still open

> **2026-08-27 session.** `handle-new-user-hardening.sql` is in the repo root:
> PART 0 read-only look, PART 1 the change, PART 2 verification, undo at the
> bottom. **Deploy the app code FIRST** — the two invite routes now record the
> invitation row before sending the invite, and the hardened trigger depends on
> that row already existing. Running the SQL against the old routes would refuse
> every invite.

- [x] ~~Run PART 0, PART 1 and PART 2 of `security-audit-fixes.sql`~~ — done 2026-08-21, all four verified OK
- [ ] **Remove the two ex-employee logins** (Joseph, Jared) with the Remove
      button on the Employees page, not just the on/off toggle. The toggle
      only marks them inactive inside the app; Remove deletes the actual
      login so there is nothing left to sign in with.
- [ ] **Confirm "Allow new users to sign up" is OFF** in Supabase →
      Authentication → Sign In / Providers. If it's on, anyone could register
      themselves as an admin in your shop, because the new-user trigger takes
      role and shop straight from the sign-up data with no verification.
- [~] **Harden `handle_new_user`** — SQL WRITTEN 2026-08-27, NOT YET RUN.
      The trigger no longer reads the role or the shop from the sign-up
      request at all: the role comes from which invitation list matched (so
      "admin" is unreachable), the shop comes from the invitation row, and no
      pending invitation means no account. Run `handle-new-user-hardening.sql`
      AFTER the code is deployed, then test a real invite end to end.
- [x] ~~**Delete `app/cost-sheets/page.tsx`**~~ — orphan page from early
      development, linked from nowhere, reading a `parts` table that doesn't
      exist and inserting materials with no shop attached. Renamed to
      `page.tsx.disabled` on 2026-08-27 so the route is already dead; delete
      the whole `app/cost-sheets` folder in Cursor to finish it off.
- [ ] **Backups** — confirm point-in-time recovery is on, and actually test a
      restore once. A backup nobody has restored isn't a backup.
- [x] ~~**Terms of Service + Privacy Policy**~~ — draft pages live at `/terms` and `/privacy` 2026-08-27, linked from the login page. Bracketed blanks still to fill in, and counsel still to review.
- [ ] **Decide on MFA for admin logins.** Can wait, but decide.
