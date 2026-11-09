-- Returns to supplier ("Yetkazuvchiga qaytarish" / Возврат поставщику).
--
-- Goods sent back to a supplier: stock of the chosen warehouse rows goes
-- down and the supplier balance goes down by the returned value:
--
--   balance = opening_balance + purchases − returns − payments
--
-- Kept in their own tables rather than as stock_out_entries rows, so the
-- write-off (brak) and financial reports — which read stock_out_entries —
-- are unaffected. delete_supplier_return puts the stock back.

CREATE TABLE public.supplier_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id),
  date date NOT NULL DEFAULT current_date,
  note text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_returns_company_number_key UNIQUE (company_id, number)
);

CREATE INDEX supplier_returns_supplier_idx ON public.supplier_returns (supplier_id, date DESC);
CREATE INDEX supplier_returns_company_date_idx ON public.supplier_returns (company_id, date DESC);

CREATE TABLE public.supplier_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  return_id uuid NOT NULL REFERENCES public.supplier_returns(id) ON DELETE CASCADE,
  product_size_id uuid NULL REFERENCES public.product_sizes(id) ON DELETE SET NULL,
  product_id uuid NULL REFERENCES public.products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  category text NULL,
  size text NOT NULL,
  color text NOT NULL DEFAULT '',
  quantity integer NOT NULL CHECK (quantity > 0),
  price numeric NOT NULL CHECK (price >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX supplier_return_items_return_idx ON public.supplier_return_items (return_id);

ALTER TABLE public.supplier_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_return_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation (select)" ON public.supplier_returns
  FOR SELECT TO authenticated
  USING (company_id = public.get_company_id());

CREATE POLICY "Company isolation (select)" ON public.supplier_return_items
  FOR SELECT TO authenticated
  USING (company_id = public.get_company_id());

REVOKE ALL ON public.supplier_returns FROM authenticated, anon;
REVOKE ALL ON public.supplier_return_items FROM authenticated, anon;
GRANT SELECT ON public.supplier_returns TO authenticated;
GRANT SELECT ON public.supplier_return_items TO authenticated;

-- p_items: [{ "product_size_id": uuid, "quantity": int, "price": numeric }]
-- price = per-unit value credited back by the supplier (defaults to the
-- row's purchase price client-side). All-or-nothing.
CREATE OR REPLACE FUNCTION public.create_supplier_return(
  p_supplier_id uuid,
  p_warehouse_id uuid,
  p_items jsonb,
  p_note text DEFAULT NULL,
  p_date date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_return_id uuid;
  v_number integer;
  v_item jsonb;
  v_quantity integer;
  v_price numeric;
  v_src public.product_sizes%ROWTYPE;
  v_product_name text;
  v_category text;
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
  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE id = p_warehouse_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Invalid warehouse';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items to return';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('supplier_return:' || v_company_id::text));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.supplier_returns WHERE company_id = v_company_id;

  INSERT INTO public.supplier_returns (
    company_id, number, supplier_id, warehouse_id, date, note, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, p_supplier_id, p_warehouse_id, COALESCE(p_date, current_date),
    NULLIF(trim(p_note), ''), auth.uid(), (SELECT full_name FROM public.users WHERE id = auth.uid())
  )
  RETURNING id INTO v_return_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_quantity := (v_item->>'quantity')::integer;
    v_price := COALESCE((v_item->>'price')::numeric, 0);
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity: %', v_item;
    END IF;
    IF v_price < 0 THEN
      RAISE EXCEPTION 'Invalid price: %', v_item;
    END IF;

    SELECT * INTO v_src
    FROM public.product_sizes
    WHERE id = (v_item->>'product_size_id')::uuid
      AND company_id = v_company_id
      AND warehouse_id = p_warehouse_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid product_size_id: %', v_item->>'product_size_id';
    END IF;
    IF v_src.stock < v_quantity THEN
      RAISE EXCEPTION 'Insufficient stock for product_size %', v_src.id;
    END IF;

    UPDATE public.product_sizes SET stock = stock - v_quantity, updated_at = now() WHERE id = v_src.id;

    SELECT name, category INTO v_product_name, v_category FROM public.products WHERE id = v_src.product_id;

    INSERT INTO public.supplier_return_items (
      company_id, return_id, product_size_id, product_id, product_name, category, size, color, quantity, price
    ) VALUES (
      v_company_id, v_return_id, v_src.id, v_src.product_id, COALESCE(v_product_name, '—'), v_category,
      v_src.size, v_src.color, v_quantity, v_price
    );
  END LOOP;

  RETURN v_return_id;
END;
$$;

-- Undo a return: stock goes back to the original rows (skipped for a row
-- that no longer exists), then the return is deleted.
CREATE OR REPLACE FUNCTION public.delete_supplier_return(p_id uuid)
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

  IF NOT EXISTS (SELECT 1 FROM public.supplier_returns WHERE id = p_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Return not found';
  END IF;

  UPDATE public.product_sizes ps
  SET stock = ps.stock + i.qty, updated_at = now()
  FROM (
    SELECT product_size_id, sum(quantity) AS qty
    FROM public.supplier_return_items
    WHERE return_id = p_id AND product_size_id IS NOT NULL
    GROUP BY product_size_id
  ) i
  WHERE ps.id = i.product_size_id AND ps.company_id = v_company_id;

  DELETE FROM public.supplier_returns WHERE id = p_id AND company_id = v_company_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_supplier_return(uuid, uuid, jsonb, text, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.delete_supplier_return(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_supplier_return(uuid, uuid, jsonb, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_supplier_return(uuid) TO authenticated;

-- A supplier with returns has history too: refuse deletion.
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
     OR EXISTS (SELECT 1 FROM public.supplier_payments WHERE supplier_id = p_id AND company_id = v_company_id)
     OR EXISTS (SELECT 1 FROM public.supplier_returns WHERE supplier_id = p_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Supplier has history';
  END IF;

  DELETE FROM public.suppliers WHERE id = p_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier not found';
  END IF;
END;
$$;
