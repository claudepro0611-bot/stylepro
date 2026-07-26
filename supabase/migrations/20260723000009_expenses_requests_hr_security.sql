-- Close a permission-bypass gap on the expenses, requests and HR tables.
-- Same class of finding as 20260715000004 / 20260718000001: RLS on these
-- tables only ever checked company_id, never the app's role/permission
-- model, and Supabase's schema-level default privileges hand `authenticated`
-- full CRUD regardless of policy. Every legitimate write now goes through the
-- has_permission()-gated SECURITY DEFINER RPCs below; the REVOKE block at the
-- end removes the direct-write grants. SELECT is left untouched (pages still
-- read these tables — or their _safe views — directly, company_id-scoped by
-- RLS exactly as before). service_role bypasses grants and is unaffected.
--
-- Frontend rewire for these RPCs has already shipped to app/(dashboard)/
-- xarajatlar, requests, and hr/* pages (uncommitted alongside this migration).

-- ═══════════════════════════════════════════════════════════════════════════
-- DOMAIN: expenses  (permission key: 'xarajatlar')
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── create_expense ────────────────────────────────────────────────────────
-- created_by is derived from auth.uid() server-side; the client-sent
-- created_by is ignored. category_id, when present, is validated to belong to
-- the caller's company. amount must be > 0.
CREATE OR REPLACE FUNCTION public.create_expense(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_category_id uuid;
  v_amount numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('xarajatlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  v_amount := NULLIF(p_data->>'amount', '')::numeric;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  v_category_id := NULLIF(p_data->>'category_id', '')::uuid;
  IF v_category_id IS NOT NULL THEN
    PERFORM 1 FROM public.expense_categories
    WHERE id = v_category_id AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Expense category not found';
    END IF;
  END IF;

  INSERT INTO public.expenses (
    company_id, category_id, amount, payment_method, date, note, created_by
  ) VALUES (
    v_company_id,
    v_category_id,
    v_amount,
    COALESCE(NULLIF(p_data->>'payment_method', ''), 'cash'),
    COALESCE(NULLIF(p_data->>'date', '')::date, CURRENT_DATE),
    NULLIF(trim(p_data->>'note'), ''),
    auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_expense(jsonb) TO authenticated;

-- ─── delete_expense ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_expense(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('xarajatlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.expenses WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_expense(uuid) TO authenticated;

-- ─── create_expense_category ───────────────────────────────────────────────
-- The UNIQUE (company_id, name) constraint is left to raise unique_violation
-- (SQLSTATE 23505) on a duplicate name, which the page already surfaces as a
-- "category already exists" toast — so no ON CONFLICT swallowing here.
CREATE OR REPLACE FUNCTION public.create_expense_category(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('xarajatlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL OR NULLIF(trim(p_data->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'Category name is required';
  END IF;

  INSERT INTO public.expense_categories (company_id, name, color)
  VALUES (
    v_company_id,
    trim(p_data->>'name'),
    COALESCE(NULLIF(p_data->>'color', ''), '#6366f1')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_expense_category(jsonb) TO authenticated;

-- ─── delete_expense_category ───────────────────────────────────────────────
-- expenses.category_id REFERENCES expense_categories(id) with the default
-- NO ACTION, so deleting a category that still has expenses raises a
-- foreign_key_violation — this is the DB-level enforcement of the page's
-- "can only delete a category with zero expenses" rule; preserved as-is.
CREATE OR REPLACE FUNCTION public.delete_expense_category(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('xarajatlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.expense_categories
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense category not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_expense_category(uuid) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- DOMAIN: requests  (permission key: 'requests')
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── update_request ────────────────────────────────────────────────────────
-- Only path the app uses (saveRequest sends {notes, status}). Partial-update
-- so a caller can send either or both. Invalid status values are rejected by
-- the table's CHECK (status IN ('new','in-progress','resolved')). No create
-- or delete RPC: nothing in the app creates or deletes a request.
CREATE OR REPLACE FUNCTION public.update_request(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('requests') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  UPDATE public.requests SET
    notes = CASE WHEN p_data ? 'notes' THEN p_data->>'notes' ELSE notes END,
    status = CASE WHEN p_data ? 'status' THEN p_data->>'status' ELSE status END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_request(uuid, jsonb) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- DOMAIN: HR  (single permission key: 'hr' — covers all 5 HR pages)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── create_department ─────────────────────────────────────────────────────
-- manager_id, when present, is validated to reference an employee in the same
-- company (the table has no FK on it, so this is enforced here instead).
CREATE OR REPLACE FUNCTION public.create_department(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_manager_id uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL OR NULLIF(trim(p_data->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'Department name is required';
  END IF;

  v_manager_id := NULLIF(p_data->>'manager_id', '')::uuid;
  IF v_manager_id IS NOT NULL THEN
    PERFORM 1 FROM public.employees
    WHERE id = v_manager_id AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Manager not found';
    END IF;
  END IF;

  INSERT INTO public.departments (
    company_id, name, manager_id, manager_name, description, status
  ) VALUES (
    v_company_id,
    trim(p_data->>'name'),
    v_manager_id,
    NULLIF(p_data->>'manager_name', ''),
    p_data->>'description',
    COALESCE(NULLIF(p_data->>'status', ''), 'active')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_department(jsonb) TO authenticated;

-- ─── update_department ──────────────────────────────────────────────────────
-- Partial-update: saveDepartment sends all fields, toggleStatus sends {status}
-- only — both route through here.
CREATE OR REPLACE FUNCTION public.update_department(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_manager_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data ? 'manager_id' THEN
    v_manager_id := NULLIF(p_data->>'manager_id', '')::uuid;
    IF v_manager_id IS NOT NULL THEN
      PERFORM 1 FROM public.employees
      WHERE id = v_manager_id AND company_id = v_company_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Manager not found';
      END IF;
    END IF;
  END IF;

  UPDATE public.departments SET
    name = CASE WHEN p_data ? 'name' THEN trim(p_data->>'name') ELSE name END,
    manager_id = CASE WHEN p_data ? 'manager_id' THEN NULLIF(p_data->>'manager_id', '')::uuid ELSE manager_id END,
    manager_name = CASE WHEN p_data ? 'manager_name' THEN NULLIF(p_data->>'manager_name', '') ELSE manager_name END,
    description = CASE WHEN p_data ? 'description' THEN p_data->>'description' ELSE description END,
    status = CASE WHEN p_data ? 'status' THEN p_data->>'status' ELSE status END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Department not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_department(uuid, jsonb) TO authenticated;

-- ─── delete_department ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_department(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.departments WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Department not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_department(uuid) TO authenticated;

-- ─── create_position ────────────────────────────────────────────────────────
-- department_id is required by the form and validated to belong to the company.
CREATE OR REPLACE FUNCTION public.create_position(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_department_id uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL OR NULLIF(trim(p_data->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'Position name is required';
  END IF;

  v_department_id := NULLIF(p_data->>'department_id', '')::uuid;
  IF v_department_id IS NOT NULL THEN
    PERFORM 1 FROM public.departments
    WHERE id = v_department_id AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Department not found';
    END IF;
  END IF;

  INSERT INTO public.positions (
    company_id, name, department_id, department_name, description, status
  ) VALUES (
    v_company_id,
    trim(p_data->>'name'),
    v_department_id,
    NULLIF(p_data->>'department_name', ''),
    p_data->>'description',
    COALESCE(NULLIF(p_data->>'status', ''), 'active')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_position(jsonb) TO authenticated;

-- ─── update_position ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_position(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_department_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data ? 'department_id' THEN
    v_department_id := NULLIF(p_data->>'department_id', '')::uuid;
    IF v_department_id IS NOT NULL THEN
      PERFORM 1 FROM public.departments
      WHERE id = v_department_id AND company_id = v_company_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Department not found';
      END IF;
    END IF;
  END IF;

  UPDATE public.positions SET
    name = CASE WHEN p_data ? 'name' THEN trim(p_data->>'name') ELSE name END,
    department_id = CASE WHEN p_data ? 'department_id' THEN NULLIF(p_data->>'department_id', '')::uuid ELSE department_id END,
    department_name = CASE WHEN p_data ? 'department_name' THEN NULLIF(p_data->>'department_name', '') ELSE department_name END,
    description = CASE WHEN p_data ? 'description' THEN p_data->>'description' ELSE description END,
    status = CASE WHEN p_data ? 'status' THEN p_data->>'status' ELSE status END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Position not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_position(uuid, jsonb) TO authenticated;

-- ─── delete_position ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_position(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.positions WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Position not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_position(uuid) TO authenticated;

-- ─── create_employee ────────────────────────────────────────────────────────
-- ATOMICITY IMPROVEMENT over the current two-client-call flow: inserts the
-- employee row AND its initial position_history ("hire") row in one
-- transaction, so you can never end up with an employee lacking a hire record.
-- position_id / department_id, when present, are validated to belong to the
-- company. salary is a user-entered figure (validated >= 0), not a derived
-- transaction total.
CREATE OR REPLACE FUNCTION public.create_employee(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_position_id uuid;
  v_department_id uuid;
  v_salary numeric;
  v_start_date date;
  v_position_name text;
  v_department_name text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL
     OR NULLIF(trim(p_data->>'first_name'), '') IS NULL
     OR NULLIF(trim(p_data->>'last_name'), '') IS NULL THEN
    RAISE EXCEPTION 'First and last name are required';
  END IF;

  v_salary := COALESCE(NULLIF(p_data->>'salary', '')::numeric, 0);
  IF v_salary < 0 THEN
    RAISE EXCEPTION 'Salary cannot be negative';
  END IF;

  v_start_date := COALESCE(NULLIF(p_data->>'start_date', '')::date, CURRENT_DATE);
  v_position_name := NULLIF(p_data->>'position_name', '');
  v_department_name := NULLIF(p_data->>'department_name', '');

  v_position_id := NULLIF(p_data->>'position_id', '')::uuid;
  IF v_position_id IS NOT NULL THEN
    PERFORM 1 FROM public.positions
    WHERE id = v_position_id AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Position not found';
    END IF;
  END IF;

  v_department_id := NULLIF(p_data->>'department_id', '')::uuid;
  IF v_department_id IS NOT NULL THEN
    PERFORM 1 FROM public.departments
    WHERE id = v_department_id AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Department not found';
    END IF;
  END IF;

  INSERT INTO public.employees (
    company_id, first_name, last_name, phone, birth_date, address,
    position_id, position_name, department_id, department_name,
    salary, start_date, status
  ) VALUES (
    v_company_id,
    trim(p_data->>'first_name'),
    trim(p_data->>'last_name'),
    NULLIF(p_data->>'phone', ''),
    NULLIF(p_data->>'birth_date', '')::date,
    NULLIF(p_data->>'address', ''),
    v_position_id,
    v_position_name,
    v_department_id,
    v_department_name,
    v_salary,
    v_start_date,
    COALESCE(NULLIF(p_data->>'status', ''), 'active')
  )
  RETURNING id INTO v_id;

  INSERT INTO public.position_history (
    company_id, employee_id, date, position_name, department_name, salary, note
  ) VALUES (
    v_company_id,
    v_id,
    v_start_date,
    v_position_name,
    v_department_name,
    v_salary,
    'Ishga qabul qilindi'
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_employee(jsonb) TO authenticated;

-- ─── create_reward_penalty_type ─────────────────────────────────────────────
-- kind and category are validated by the table's CHECK constraints. amount is
-- a config figure (validated >= 0).
CREATE OR REPLACE FUNCTION public.create_reward_penalty_type(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_amount numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL OR NULLIF(trim(p_data->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'Name is required';
  END IF;

  v_amount := COALESCE(NULLIF(p_data->>'amount', '')::numeric, 0);
  IF v_amount < 0 THEN
    RAISE EXCEPTION 'Amount cannot be negative';
  END IF;

  INSERT INTO public.reward_penalty_types (
    company_id, name, amount, kind, category, description
  ) VALUES (
    v_company_id,
    trim(p_data->>'name'),
    v_amount,
    p_data->>'kind',
    p_data->>'category',
    p_data->>'description'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_reward_penalty_type(jsonb) TO authenticated;

-- ─── update_reward_penalty_type ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_reward_penalty_type(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  UPDATE public.reward_penalty_types SET
    name = CASE WHEN p_data ? 'name' THEN trim(p_data->>'name') ELSE name END,
    amount = CASE WHEN p_data ? 'amount' THEN COALESCE(NULLIF(p_data->>'amount', '')::numeric, amount) ELSE amount END,
    kind = CASE WHEN p_data ? 'kind' THEN p_data->>'kind' ELSE kind END,
    category = CASE WHEN p_data ? 'category' THEN p_data->>'category' ELSE category END,
    description = CASE WHEN p_data ? 'description' THEN p_data->>'description' ELSE description END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reward/penalty type not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_reward_penalty_type(uuid, jsonb) TO authenticated;

-- ─── delete_reward_penalty_type ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_reward_penalty_type(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.reward_penalty_types
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reward/penalty type not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_reward_penalty_type(uuid) TO authenticated;

-- ─── create_reward_penalty_entry ────────────────────────────────────────────
-- Replaces both saveReward and savePenalty. The entry's `type` and all
-- denormalized display fields (employee_name, department_name, type_name) are
-- DERIVED server-side from employee_id + type_id rather than trusted from the
-- client. Both ids are validated to belong to the company. `amount` remains
-- client-supplied by design (the UI lets the manager override the
-- auto-computed value) — validated >= 0.
CREATE OR REPLACE FUNCTION public.create_reward_penalty_entry(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_employee_id uuid;
  v_type_id uuid;
  v_amount numeric;
  v_employee_name text;
  v_department_name text;
  v_type_name text;
  v_category text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('hr') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  v_employee_id := NULLIF(p_data->>'employee_id', '')::uuid;
  v_type_id := NULLIF(p_data->>'type_id', '')::uuid;
  IF v_employee_id IS NULL OR v_type_id IS NULL THEN
    RAISE EXCEPTION 'Employee and type are required';
  END IF;

  v_amount := NULLIF(p_data->>'amount', '')::numeric;
  IF v_amount IS NULL OR v_amount < 0 THEN
    RAISE EXCEPTION 'Amount must be zero or greater';
  END IF;

  -- Derive employee display fields + confirm same-company ownership.
  SELECT (first_name || ' ' || last_name), department_name
  INTO v_employee_name, v_department_name
  FROM public.employees
  WHERE id = v_employee_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  -- Derive type name + category (drives the entry's `type`) + ownership.
  SELECT name, category
  INTO v_type_name, v_category
  FROM public.reward_penalty_types
  WHERE id = v_type_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reward/penalty type not found';
  END IF;

  INSERT INTO public.reward_penalty_entries (
    company_id, employee_id, employee_name, department_name,
    type, type_id, type_name, amount, date, note
  ) VALUES (
    v_company_id,
    v_employee_id,
    v_employee_name,
    v_department_name,
    v_category,            -- 'reward' or 'penalty', server-derived
    v_type_id,
    v_type_name,
    v_amount,
    COALESCE(NULLIF(p_data->>'date', '')::date, CURRENT_DATE),
    NULLIF(p_data->>'note', '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_reward_penalty_entry(jsonb) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVOKE direct client writes — the only remaining write paths are the RPCs
-- above. SELECT is intentionally NOT revoked (pages read these tables, or
-- their employees_safe / position_history_safe views, directly).
-- ═══════════════════════════════════════════════════════════════════════════

-- Domain: expenses
REVOKE INSERT, UPDATE, DELETE ON public.expenses FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.expense_categories FROM authenticated;

-- Domain: requests
REVOKE INSERT, UPDATE, DELETE ON public.requests FROM authenticated;

-- Domain: HR
REVOKE INSERT, UPDATE, DELETE ON public.departments FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.positions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.employees FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.position_history FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.reward_penalty_types FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.reward_penalty_entries FROM authenticated;
