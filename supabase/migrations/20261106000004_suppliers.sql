-- Suppliers ("Yetkazuvchilar" / Поставщики) with payables tracking.
--
-- Until now the supplier was a free-text column on stock_in_entries. This
-- adds a real directory plus a running balance per supplier:
--
--   balance (what we owe) = opening_balance
--                         + SUM(stock_in_entries.total_amount WHERE supplier_id)
--                         − SUM(supplier_payments.amount)
--
-- Purchases are read straight from stock_in_entries, so deleting a kirim
-- entry (delete_stock_in_entry) automatically lowers the debt — no second
-- ledger to keep in sync. stock_in_entries.supplier (text) is kept and
-- filled with the supplier's name, so older readers keep working.
--
-- Existing free-text names are backfilled into suppliers (one row per
-- distinct trimmed, case-insensitive name per company) and the old entries
-- are linked to them.

-- ─── Tables ───────────────────────────────────────────────────────────────

CREATE TABLE public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  phone text NULL,
  company_name text NULL,
  inn text NULL,
  address text NULL,
  note text NULL,
  opening_balance numeric NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX suppliers_company_name_key ON public.suppliers (company_id, lower(trim(name)));

COMMENT ON TABLE public.suppliers IS
  'Supplier directory. Read via RLS (company-scoped SELECT); write ONLY via '
  'create_supplier / update_supplier / delete_supplier.';
COMMENT ON COLUMN public.suppliers.opening_balance IS
  'Debt to the supplier before purchases were tracked in the app (positive = we owe).';

CREATE TRIGGER suppliers_set_updated_at
  BEFORE UPDATE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'transfer')),
  date date NOT NULL DEFAULT current_date,
  note text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX supplier_payments_supplier_idx ON public.supplier_payments (supplier_id, date DESC);
CREATE INDEX supplier_payments_company_date_idx ON public.supplier_payments (company_id, date DESC);

ALTER TABLE public.stock_in_entries
  ADD COLUMN IF NOT EXISTS supplier_id uuid NULL REFERENCES public.suppliers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS stock_in_entries_supplier_idx ON public.stock_in_entries (supplier_id);

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation (select)" ON public.suppliers
  FOR SELECT TO authenticated
  USING (company_id = public.get_company_id());

CREATE POLICY "Company isolation (select)" ON public.supplier_payments
  FOR SELECT TO authenticated
  USING (company_id = public.get_company_id());

REVOKE ALL ON public.suppliers FROM authenticated, anon;
REVOKE ALL ON public.supplier_payments FROM authenticated, anon;
GRANT SELECT ON public.suppliers TO authenticated;
GRANT SELECT ON public.supplier_payments TO authenticated;

-- ─── Backfill from free-text names ────────────────────────────────────────

INSERT INTO public.suppliers (company_id, name)
SELECT DISTINCT ON (company_id, lower(trim(supplier))) company_id, trim(supplier)
FROM public.stock_in_entries
WHERE supplier IS NOT NULL AND trim(supplier) <> ''
ORDER BY company_id, lower(trim(supplier)), created_at
ON CONFLICT DO NOTHING;

UPDATE public.stock_in_entries e
SET supplier_id = s.id
FROM public.suppliers s
WHERE e.supplier_id IS NULL
  AND e.supplier IS NOT NULL AND trim(e.supplier) <> ''
  AND s.company_id = e.company_id
  AND lower(trim(s.name)) = lower(trim(e.supplier));

-- ─── Directory RPCs ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_supplier(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_id uuid;
BEGIN
  -- Kirim users can add a supplier on the fly from the kirim form.
  IF NOT (public.has_permission('yetkazuvchilar') OR public.has_permission('kirim')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL OR NULLIF(trim(p_data->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'Supplier name is required';
  END IF;

  INSERT INTO public.suppliers (company_id, name, phone, company_name, inn, address, note, opening_balance)
  VALUES (
    v_company_id,
    trim(p_data->>'name'),
    NULLIF(trim(p_data->>'phone'), ''),
    NULLIF(trim(p_data->>'company_name'), ''),
    NULLIF(trim(p_data->>'inn'), ''),
    NULLIF(trim(p_data->>'address'), ''),
    NULLIF(trim(p_data->>'note'), ''),
    COALESCE(NULLIF(p_data->>'opening_balance', '')::numeric, 0)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_supplier(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_name text;
BEGIN
  IF NOT public.has_permission('yetkazuvchilar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  v_name := NULLIF(trim(p_data->>'name'), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Supplier name is required';
  END IF;

  UPDATE public.suppliers SET
    name = v_name,
    phone = NULLIF(trim(p_data->>'phone'), ''),
    company_name = NULLIF(trim(p_data->>'company_name'), ''),
    inn = NULLIF(trim(p_data->>'inn'), ''),
    address = NULLIF(trim(p_data->>'address'), ''),
    note = NULLIF(trim(p_data->>'note'), ''),
    opening_balance = COALESCE(NULLIF(p_data->>'opening_balance', '')::numeric, 0),
    is_active = COALESCE((p_data->>'is_active')::boolean, is_active)
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier not found';
  END IF;

  -- Keep the denormalized name on kirim entries in step.
  UPDATE public.stock_in_entries SET supplier = v_name
  WHERE supplier_id = p_id AND company_id = v_company_id;
END;
$$;

-- Refuses while the supplier has kirim entries or payments: history must
-- not silently lose its supplier. Deactivate (is_active=false) instead.
CREATE OR REPLACE FUNCTION public.delete_supplier(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('yetkazuvchilar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF EXISTS (SELECT 1 FROM public.stock_in_entries WHERE supplier_id = p_id AND company_id = v_company_id)
     OR EXISTS (SELECT 1 FROM public.supplier_payments WHERE supplier_id = p_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Supplier has history';
  END IF;

  DELETE FROM public.suppliers WHERE id = p_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier not found';
  END IF;
END;
$$;

-- ─── Payment RPCs ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_supplier_payment(
  p_supplier_id uuid,
  p_amount numeric,
  p_payment_method text DEFAULT 'cash',
  p_date date DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('yetkazuvchilar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = p_supplier_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Supplier not found';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;
  IF COALESCE(p_payment_method, 'cash') NOT IN ('cash', 'card', 'transfer') THEN
    RAISE EXCEPTION 'Invalid payment method';
  END IF;

  INSERT INTO public.supplier_payments (
    company_id, supplier_id, amount, payment_method, date, note, created_by, created_by_name
  ) VALUES (
    v_company_id, p_supplier_id, p_amount, COALESCE(p_payment_method, 'cash'),
    COALESCE(p_date, current_date), NULLIF(trim(p_note), ''), auth.uid(),
    (SELECT full_name FROM public.users WHERE id = auth.uid())
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_supplier_payment(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('yetkazuvchilar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.supplier_payments WHERE id = p_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_supplier(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.update_supplier(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.delete_supplier(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_supplier_payment(uuid, numeric, text, date, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.delete_supplier_payment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_supplier(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_supplier(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_supplier(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_supplier_payment(uuid, numeric, text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_supplier_payment(uuid) TO authenticated;

-- ─── stock_in: link entries to a supplier ─────────────────────────────────
-- Based on 20261106000003_stock_transfers.sql. Only change: an optional
-- supplier_id per entry (validated against the caller's company); when
-- given, the text supplier column is set to that supplier's name.

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
  v_selling_price numeric;
  v_color text;
  v_product_id uuid;
  v_warehouse_id uuid;
  v_product_size_id uuid;
  v_current_barcode text;
  v_sibling_barcode text;
  v_generated_barcode text;
  v_supplier_id uuid;
  v_supplier_name text;
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
    v_selling_price := COALESCE((v_entry->>'selling_price')::numeric, 0);
    v_color := COALESCE(v_entry->>'color', '');
    v_product_id := (v_entry->>'product_id')::uuid;
    v_warehouse_id := NULLIF(v_entry->>'warehouse_id', '')::uuid;
    v_supplier_id := NULLIF(v_entry->>'supplier_id', '')::uuid;
    v_supplier_name := v_entry->>'supplier';

    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid stock-in quantity: %', v_entry;
    END IF;

    IF v_warehouse_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.warehouses WHERE id = v_warehouse_id AND company_id = v_company_id
    ) THEN
      RAISE EXCEPTION 'Invalid warehouse';
    END IF;

    IF v_supplier_id IS NOT NULL THEN
      SELECT name INTO v_supplier_name
      FROM public.suppliers WHERE id = v_supplier_id AND company_id = v_company_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid supplier';
      END IF;
    END IF;

    INSERT INTO public.product_sizes (
      company_id, product_id, size, color, stock, warehouse_id,
      purchase_price, selling_price, updated_at
    ) VALUES (
      v_company_id, v_product_id, v_entry->>'size', v_color, v_quantity, v_warehouse_id,
      v_purchase_price, v_selling_price, now()
    )
    ON CONFLICT (company_id, product_id, size, color, warehouse_id) DO UPDATE
      SET stock = public.product_sizes.stock + excluded.stock,
          purchase_price = excluded.purchase_price,
          selling_price = excluded.selling_price,
          updated_at = now()
    RETURNING id, barcode INTO v_product_size_id, v_current_barcode;

    UPDATE public.product_sizes
    SET purchase_price = v_purchase_price, selling_price = v_selling_price, updated_at = now()
    WHERE company_id = v_company_id AND product_id = v_product_id
      AND size = v_entry->>'size' AND color = v_color AND id <> v_product_size_id;

    IF v_current_barcode IS NULL OR v_current_barcode = '' THEN
      SELECT barcode INTO v_sibling_barcode
      FROM public.product_sizes
      WHERE company_id = v_company_id AND product_id = v_product_id
        AND size = v_entry->>'size' AND color = v_color AND id <> v_product_size_id
        AND barcode IS NOT NULL AND barcode <> ''
      LIMIT 1;

      v_generated_barcode := COALESCE(
        v_sibling_barcode,
        lpad(extract(epoch FROM now())::bigint::text, 13, '0') || lpad(v_product_size_id::text, 4, '0')
      );
      UPDATE public.product_sizes
      SET barcode = v_generated_barcode
      WHERE id = v_product_size_id AND (barcode IS NULL OR barcode = '');
    END IF;

    INSERT INTO public.stock_in_entries (
      company_id, product_id, product_name, category, size, color,
      quantity, unit_price, purchase_price, selling_price, total_amount,
      supplier, supplier_id, date, note, product_size_id
    ) VALUES (
      v_company_id,
      v_product_id,
      v_entry->>'product_name',
      v_entry->>'category',
      v_entry->>'size',
      v_color,
      v_quantity,
      v_purchase_price,
      v_purchase_price,
      v_selling_price,
      v_purchase_price * v_quantity,
      v_supplier_name,
      v_supplier_id,
      COALESCE((v_entry->>'date')::date, current_date),
      v_entry->>'note',
      v_product_size_id
    );
  END LOOP;
END;
$$;

-- ─── Permission whitelist: + 'yetkazuvchilar' ─────────────────────────────

CREATE OR REPLACE FUNCTION public.has_permission(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_role text;
  v_permissions jsonb;
  v_valid_keys text[] := ARRAY[
    'dashboard', 'pos', 'customers', 'inventory', 'kirim', 'chiqim', 'brak',
    'mahsulotlar', 'mahsulot_guruhi', 'reports', 'xarajatlar', 'marketing',
    'requests', 'hr', 'sozlamalar', 'jamoa', 'arxiv', 'nasiya',
    'reports_moliya', 'reports_foyda', 'reports_sotuvlar', 'reports_mijozlar',
    'reports_yetkazuvchilar', 'reports_kirim', 'reports_spisaniya',
    'reports_xarajatlar', 'reports_inventar',
    'peremeshenie', 'reports_peremeshenie',
    'yetkazuvchilar'
  ];
BEGIN
  IF NOT (p_key = ANY(v_valid_keys)) THEN
    RETURN false;
  END IF;

  SELECT role, permissions INTO v_role, v_permissions
  FROM public.users
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
    RETURN true;
  END IF;

  RETURN COALESCE((v_permissions->>p_key)::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;
