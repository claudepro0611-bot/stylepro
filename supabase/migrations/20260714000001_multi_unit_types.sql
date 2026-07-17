-- unit_type (single string) -> unit_types (array), to support selecting
-- multiple units per company instead of just one.

ALTER TABLE public.company_settings
ALTER COLUMN settings SET DEFAULT '{
  "product": {
    "unit_types": ["dona"],
    "block_size": 1
  }
}'::jsonb;

-- Convert any row still holding the old shape. Scoped to rows that still
-- have "unit_type" so this is safe to re-run.
UPDATE public.company_settings
SET settings = jsonb_set(
  settings,
  '{product}',
  jsonb_build_object(
    'unit_types', jsonb_build_array(COALESCE(settings->'product'->>'unit_type', 'dona')),
    'block_size', COALESCE((settings->'product'->>'block_size')::numeric, 1)
  )
)
WHERE settings->'product' ? 'unit_type';
