-- Step 1: barcode column + lookup index.
--
-- Audit before writing DDL: set_product_size_barcode (Phase 4) already
-- does `UPDATE public.product_sizes SET barcode = p_barcode ...`, which
-- means the column already existed. Confirmed via information_schema:
-- product_sizes.barcode (text) is already present, so the ADD COLUMN
-- below is a no-op — kept anyway for parity with the literal instruction
-- and idempotency.
--
-- Also found two pre-existing barcode indexes that the literal brief
-- didn't anticipate:
--   product_sizes_barcode_lookup  — non-unique, on (barcode) alone, no
--                                    company scoping.
--   product_sizes_barcode_unique  — UNIQUE on (company_id, barcode)
--                                    WHERE barcode IS NOT NULL, but
--                                    missing the "AND barcode <> ''"
--                                    exclusion this task asks for.
-- Because an index named product_sizes_barcode_lookup already existed
-- (just with a different definition), a literal
-- `CREATE UNIQUE INDEX IF NOT EXISTS product_sizes_barcode_lookup ...`
-- would have silently done nothing — Postgres's IF NOT EXISTS only checks
-- the name, not whether the definition matches. Verified no existing
-- (company_id, barcode) duplicates first, then dropped both stale indexes
-- and created exactly the single index requested under that name, so
-- there's one unambiguous barcode-uniqueness index instead of two
-- overlapping ones.

ALTER TABLE public.product_sizes ADD COLUMN IF NOT EXISTS barcode text;

DROP INDEX IF EXISTS public.product_sizes_barcode_lookup;
DROP INDEX IF EXISTS public.product_sizes_barcode_unique;

CREATE UNIQUE INDEX IF NOT EXISTS product_sizes_barcode_lookup
  ON public.product_sizes (company_id, barcode)
  WHERE barcode IS NOT NULL AND barcode <> '';

-- Step 2: stock_in auto-generates a barcode for any row that doesn't have
-- one yet (first time a given size+color variant is ever stocked).
--
-- now() is the transaction start time, so it's identical for every entry
-- processed within one stock_in call — the epoch-seconds prefix alone
-- would collide across several new variants saved from the same kirim
-- matrix. The first 4 characters of the row's own (freshly generated)
-- uuid id are appended specifically to keep those same-second inserts
-- from producing duplicate barcodes; that's why the id suffix is kept
-- rather than trimming the final string back down to just the 13-digit
-- timestamp.
CREATE OR REPLACE FUNCTION public.stock_in(p_entries jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_entry jsonb;
  v_quantity integer;
  v_purchase_price numeric;
  v_color text;
  v_product_size_id uuid;
  v_current_barcode text;
  v_generated_barcode text;
BEGIN
  IF NOT public.has_permission('kirim') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_entries IS NULL OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'No entries to record';
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    v_quantity := (v_entry->>'quantity')::integer;
    v_purchase_price := COALESCE((v_entry->>'purchase_price')::numeric, 0);
    v_color := COALESCE(v_entry->>'color', '');

    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid stock-in quantity: %', v_entry;
    END IF;

    INSERT INTO public.product_sizes (
      company_id, product_id, size, color, stock, warehouse_id,
      purchase_price, selling_price, updated_at
    ) VALUES (
      v_company_id,
      (v_entry->>'product_id')::uuid,
      v_entry->>'size',
      v_color,
      v_quantity,
      NULLIF(v_entry->>'warehouse_id', '')::uuid,
      v_purchase_price,
      COALESCE((v_entry->>'selling_price')::numeric, 0),
      now()
    )
    ON CONFLICT (company_id, product_id, size, color) DO UPDATE
      SET stock = public.product_sizes.stock + excluded.stock,
          purchase_price = excluded.purchase_price,
          selling_price = excluded.selling_price,
          updated_at = now()
    RETURNING id, barcode INTO v_product_size_id, v_current_barcode;

    IF v_current_barcode IS NULL OR v_current_barcode = '' THEN
      v_generated_barcode := lpad(extract(epoch FROM now())::bigint::text, 13, '0')
                             || lpad(v_product_size_id::text, 4, '0');
      UPDATE public.product_sizes
      SET barcode = v_generated_barcode
      WHERE id = v_product_size_id AND (barcode IS NULL OR barcode = '');
    END IF;

    INSERT INTO public.stock_in_entries (
      company_id, product_id, product_name, category, size, color,
      quantity, unit_price, purchase_price, selling_price, total_amount,
      supplier, date, note, product_size_id
    ) VALUES (
      v_company_id,
      (v_entry->>'product_id')::uuid,
      v_entry->>'product_name',
      v_entry->>'category',
      v_entry->>'size',
      v_color,
      v_quantity,
      v_purchase_price,
      v_purchase_price,
      COALESCE((v_entry->>'selling_price')::numeric, 0),
      v_purchase_price * v_quantity,
      v_entry->>'supplier',
      COALESCE((v_entry->>'date')::date, current_date),
      v_entry->>'note',
      v_product_size_id
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.stock_in(jsonb) TO authenticated;
