-- customers.total_purchases / last_purchase_date were never maintained: no
-- RPC or trigger wrote them, so every customer card showed 0 / empty even
-- after sales. Keep them in sync from transactions (net of returns) with
-- triggers, and backfill existing customers.

-- ─── Recompute one customer's stats ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_customer_purchase_stats(p_customer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_customer_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.customers c
  SET total_purchases = s.total,
      last_purchase_date = s.last_date
  FROM (
    SELECT
      COALESCE(sum(t.total_amount - COALESCE(r.returned, 0)), 0) AS total,
      max(t.date) AS last_date
    FROM public.transactions t
    LEFT JOIN (
      SELECT ret.transaction_id, sum(ri.refund_amount) AS returned
      FROM public.returns ret
      JOIN public.return_items ri ON ri.return_id = ret.id
      GROUP BY ret.transaction_id
    ) r ON r.transaction_id = t.id
    WHERE t.customer_id = p_customer_id
      AND t.status = 'completed'
  ) s
  WHERE c.id = p_customer_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refresh_customer_purchase_stats(uuid) FROM PUBLIC, anon, authenticated;

-- ─── Trigger: transactions ───────────────────────────────────────────────
-- sell_cart inserts with a placeholder total_amount and corrects it with an
-- UPDATE, so updates of total_amount must re-run the recompute too.
CREATE OR REPLACE FUNCTION public.trg_transactions_customer_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.refresh_customer_purchase_stats(NEW.customer_id);
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.customer_id IS DISTINCT FROM NEW.customer_id) THEN
    PERFORM public.refresh_customer_purchase_stats(OLD.customer_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS transactions_customer_stats ON public.transactions;
CREATE TRIGGER transactions_customer_stats
  AFTER INSERT OR DELETE OR UPDATE OF customer_id, status, total_amount, date
  ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.trg_transactions_customer_stats();

-- ─── Trigger: return_items (refunds lower the customer's net total) ──────
CREATE OR REPLACE FUNCTION public.trg_return_items_customer_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_customer_id uuid;
BEGIN
  SELECT t.customer_id INTO v_customer_id
  FROM public.returns ret
  JOIN public.transactions t ON t.id = ret.transaction_id
  WHERE ret.id = COALESCE(NEW.return_id, OLD.return_id);

  PERFORM public.refresh_customer_purchase_stats(v_customer_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS return_items_customer_stats ON public.return_items;
CREATE TRIGGER return_items_customer_stats
  AFTER INSERT OR UPDATE OR DELETE ON public.return_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_return_items_customer_stats();

-- ─── Backfill every existing customer ────────────────────────────────────
DO $$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM public.customers LOOP
    PERFORM public.refresh_customer_purchase_stats(v_id);
  END LOOP;
END
$$;
