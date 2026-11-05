-- Supabase Storage bucket for product images.
--
-- Bucket: 'product-images', public read (image URLs are embedded in the UI
-- and need to render without a signed URL). Writes are restricted by RLS on
-- storage.objects: only authenticated users, and only inside a top-level
-- folder named after their own company_id. Expected object path format:
--   {company_id}/{random}.{ext}
--
-- Tenant isolation here uses public.get_company_id() (SECURITY DEFINER
-- helper from 20260612090003) rather than trusting any client-supplied id:
-- (storage.foldername(name))[1] is the first path segment of the object key,
-- and it must equal the caller's own company_id.
--
-- Idempotency: bucket insert is ON CONFLICT DO NOTHING; every policy is
-- dropped-if-exists before (re)creation. Policy names are prefixed with
-- product_images_ to stay unique within storage.objects.

-- Step 1: bucket (public read)
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO NOTHING;

-- Step 2: RLS policies on storage.objects, scoped to this bucket only.
-- storage.objects already has RLS enabled by Supabase; without policies the
-- bucket would be read-only-via-public-URL and fully write-locked.

-- 2a. SELECT: public read. The bucket is already public=true (served via the
-- public object endpoint), but an explicit policy keeps API-based listing /
-- download working and makes the intent auditable.
DROP POLICY IF EXISTS "product_images_public_read" ON storage.objects;
CREATE POLICY "product_images_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'product-images');

-- 2b. INSERT: authenticated only, first folder must be own company_id.
DROP POLICY IF EXISTS "product_images_company_insert" ON storage.objects;
CREATE POLICY "product_images_company_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'product-images'
    AND (storage.foldername(name))[1] = public.get_company_id()::text
  );

-- 2c. UPDATE: same scoping on both the existing row (USING) and the new
-- values (WITH CHECK), so an object cannot be moved out of the company
-- folder either.
DROP POLICY IF EXISTS "product_images_company_update" ON storage.objects;
CREATE POLICY "product_images_company_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (storage.foldername(name))[1] = public.get_company_id()::text
  )
  WITH CHECK (
    bucket_id = 'product-images'
    AND (storage.foldername(name))[1] = public.get_company_id()::text
  );

-- 2d. DELETE: authenticated only, own company folder only.
DROP POLICY IF EXISTS "product_images_company_delete" ON storage.objects;
CREATE POLICY "product_images_company_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (storage.foldername(name))[1] = public.get_company_id()::text
  );
