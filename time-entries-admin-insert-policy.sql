-- ============================================================
-- Let admins manually add a time entry for any employee
-- Review before running. Run in Supabase SQL Editor.
--
-- Context: employees clock in by INSERTing their OWN time_entries row
-- (employee_id = their user id). The new admin "Add time" button inserts a
-- row for a DIFFERENT employee. If the only INSERT permission on the table is
-- the employee "own rows" policy, RLS will block the admin insert.
--
-- STEP 1 (diagnostic, read-only): see the current policies on time_entries.
-- If you already see a policy with cmd = ALL for admins (e.g.
-- time_entries_admin_all), admins can already insert and you can SKIP step 2.
-- ============================================================
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'time_entries'
ORDER BY policyname;

-- ============================================================
-- STEP 2 (only if no admin ALL/INSERT policy exists above):
-- Add an admin-only INSERT policy, scoped to the admin's own company.
-- Permissive + idempotent: it sits alongside existing policies and is safe
-- to re-run. RLS changes take effect immediately (no schema-cache reload).
-- Uses the same helpers as the rest of the app: current_company_id(), is_admin().
-- ============================================================
DROP POLICY IF EXISTS time_entries_admin_insert ON time_entries;
CREATE POLICY time_entries_admin_insert ON time_entries
  FOR INSERT WITH CHECK (company_id = current_company_id() AND is_admin());
