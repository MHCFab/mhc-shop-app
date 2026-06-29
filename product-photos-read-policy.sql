-- ============================================================
-- Let signed-in users VIEW product photos
-- Review before running. Run in Supabase SQL Editor.
--
-- Problem: the product-photos storage bucket has policies to UPLOAD (insert)
-- and DELETE objects, but NO read (select) policy. Generating the signed URL
-- the app uses to display a photo requires read access, so every photo comes
-- back blank ("Image unavailable") even though the file uploaded fine.
--
-- Fix: add a SELECT policy that mirrors the two existing ones (scoped to the
-- product-photos bucket, for signed-in users). This matches your current setup
-- exactly — it only adds the missing read permission.
--
-- Idempotent: the DROP makes it safe to re-run. Storage RLS changes take effect
-- immediately — no redeploy needed.
-- ============================================================

DROP POLICY IF EXISTS "Authenticated users can view product photos" ON storage.objects;
CREATE POLICY "Authenticated users can view product photos"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'product-photos');
