-- Optional one-time data fix.
-- The template form shipped earlier tagged fabricated opening stock as a generic
-- 'adjustment'. Under the new costing rule, opening stock must be its own price
-- layer ('opening'). This retags any such rows you already created. Safe to re-run.
UPDATE fabricated_inventory
SET source = 'opening'
WHERE source = 'adjustment'
  AND notes ILIKE 'Opening stock%';
