-- ===========================================================================
-- ShopWorks — job-note acknowledgments survive removing the worker
-- ===========================================================================
-- THE PROBLEM
--
-- Removing an employee failed for Jared and worked for Joseph. The reason:
-- `job_note_acknowledgments` (added 2026-07-31, the record of which worker
-- ticked off which job note) points at the person's profile with NO delete
-- rule. In Postgres that means "refuse the delete". Jared had acknowledged at
-- least one note; Joseph never had. So the database blocked Jared and let
-- Joseph through.
--
-- Because the Remove button deletes the login first and lets the profile
-- follow, the block came back as a raw database error rather than anything
-- readable.
--
-- THE FIX (Erik's decision 2026-08-27: keep the record, not the row-deletion)
--
-- Stamp the worker's name onto each acknowledgment, then let the LINK to the
-- login go null when they are removed. "Jared acknowledged this note on
-- 12 Aug" stays true forever; only the pointer to a login that no longer
-- exists goes away. Same pattern the time entries already use to survive
-- invoicing.
--
-- ORDER OF OPERATIONS: run this file FIRST, then deploy the code. The code
-- change only adds the name to newly-written acknowledgments; it needs the
-- column to exist. Running this file on its own harms nothing — the column
-- simply sits there unwritten until the deploy lands.
--
-- Nothing in here deletes or rewrites an existing acknowledgment.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- PART 0 — LOOK FIRST (read-only)
-- ---------------------------------------------------------------------------
-- 0a. The rule as it stands. Should show one row, on_delete = NO ACTION.
SELECT con.conname AS constraint_name,
       CASE con.confdeltype
         WHEN 'a' THEN 'NO ACTION - BLOCKS DELETE'
         WHEN 'r' THEN 'RESTRICT - BLOCKS DELETE'
         WHEN 'c' THEN 'cascade'
         WHEN 'n' THEN 'set null'
         WHEN 'd' THEN 'set default'
       END AS on_delete
FROM pg_constraint con
JOIN pg_class child  ON child.oid  = con.conrelid
JOIN pg_class parent ON parent.oid = con.confrelid
WHERE con.contype = 'f'
  AND child.relname  = 'job_note_acknowledgments'
  AND parent.relname = 'profiles';

-- 0b. How many acknowledgments exist, and who they belong to. This is the
--     "before" picture — the same rows must still be here at the end.
SELECT COALESCE(NULLIF(trim(p.full_name), ''), p.email, '(login already gone)') AS worker,
       count(*) AS acknowledgments
FROM public.job_note_acknowledgments a
LEFT JOIN public.profiles p ON p.id = a.employee_id
GROUP BY 1
ORDER BY 1;


-- ---------------------------------------------------------------------------
-- PART 1 — THE CHANGE
-- ---------------------------------------------------------------------------

-- 1) Somewhere to keep the name.
ALTER TABLE public.job_note_acknowledgments
  ADD COLUMN IF NOT EXISTS employee_name text;

-- 2) Fill it in for every acknowledgment already recorded, from the profile
--    it currently points at. Full name if there is one, otherwise the email.
UPDATE public.job_note_acknowledgments a
SET employee_name = COALESCE(NULLIF(trim(p.full_name), ''), p.email)
FROM public.profiles p
WHERE p.id = a.employee_id
  AND (a.employee_name IS NULL OR trim(a.employee_name) = '');

-- 3) The link to the login is allowed to be empty now that the name is kept
--    separately.
ALTER TABLE public.job_note_acknowledgments
  ALTER COLUMN employee_id DROP NOT NULL;

-- 4) Replace the blocking rule with "empty the link, keep the row". The
--    constraint's real name is looked up rather than assumed.
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class child  ON child.oid  = con.conrelid
  JOIN pg_class parent ON parent.oid = con.confrelid
  WHERE con.contype = 'f'
    AND child.relname  = 'job_note_acknowledgments'
    AND parent.relname = 'profiles'
  LIMIT 1;

  IF cname IS NULL THEN
    RAISE EXCEPTION 'No foreign key from job_note_acknowledgments to profiles was found - stop and check.';
  END IF;

  EXECUTE format('ALTER TABLE public.job_note_acknowledgments DROP CONSTRAINT %I', cname);

  EXECUTE 'ALTER TABLE public.job_note_acknowledgments
             ADD CONSTRAINT job_note_acknowledgments_employee_id_fkey
             FOREIGN KEY (employee_id) REFERENCES public.profiles(id) ON DELETE SET NULL';
END $$;

-- 5) The schema cache goes stale after ALTER TABLE. Run this, then wait about
--    ten seconds before using the app.
NOTIFY pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- PART 2 — VERIFY (read-only)
-- ---------------------------------------------------------------------------
-- 2a. The rule should now read "set null".
SELECT con.conname AS constraint_name,
       CASE con.confdeltype
         WHEN 'a' THEN 'PROBLEM - still blocks delete'
         WHEN 'r' THEN 'PROBLEM - still blocks delete'
         WHEN 'c' THEN 'PROBLEM - cascade, not what we asked for'
         WHEN 'n' THEN 'OK - set null'
         WHEN 'd' THEN 'PROBLEM - set default'
       END AS on_delete
FROM pg_constraint con
JOIN pg_class child  ON child.oid  = con.conrelid
JOIN pg_class parent ON parent.oid = con.confrelid
WHERE con.contype = 'f'
  AND child.relname  = 'job_note_acknowledgments'
  AND parent.relname = 'profiles';

-- 2b. Every existing acknowledgment should now carry a name, and the row
--     count per worker must match what PART 0b showed.
SELECT COALESCE(employee_name, '(no name recorded)') AS worker,
       count(*) AS acknowledgments,
       count(*) FILTER (WHERE employee_id IS NULL) AS login_removed
FROM public.job_note_acknowledgments
GROUP BY 1
ORDER BY 1;

-- 2c. Nothing should be left without a name while its login still exists.
SELECT count(*) AS should_be_zero
FROM public.job_note_acknowledgments
WHERE employee_id IS NOT NULL
  AND (employee_name IS NULL OR trim(employee_name) = '');


-- ---------------------------------------------------------------------------
-- AFTER THIS
-- ---------------------------------------------------------------------------
-- Remove will work on Jared. Do it from Employees -> Remove in the app, not
-- with SQL, so the login itself is deleted and not just the profile row.
-- His acknowledgments stay, with his name on them and no login attached.


-- ---------------------------------------------------------------------------
-- UNDO
-- ---------------------------------------------------------------------------
-- Puts the blocking rule back. Only works while no acknowledgment has a
-- missing login - once a worker has actually been removed, the NOT NULL
-- cannot be restored without deleting their rows, which is the whole point of
-- the change. The employee_name column is harmless and can be left in place.
/*
ALTER TABLE public.job_note_acknowledgments
  DROP CONSTRAINT job_note_acknowledgments_employee_id_fkey;
ALTER TABLE public.job_note_acknowledgments
  ALTER COLUMN employee_id SET NOT NULL;
ALTER TABLE public.job_note_acknowledgments
  ADD CONSTRAINT job_note_acknowledgments_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES public.profiles(id);
NOTIFY pgrst, 'reload schema';
*/
