-- Rename public.requests.mode values from English to Uzbek terminology:
--   'general' -> 'shikoyat'  (complaint; page renamed "So'rovlar" -> "Shikoyatlar")
--   'chat'    -> 'murojat'   (customer's Murojatlar chat tab)
--
-- Same two states, same semantics - this is a value rename, not a new state
-- or a business-logic change. See 20260730000002_requests_mode.sql for the
-- column's original definition (added inline as
-- `mode text DEFAULT 'general' CHECK (mode IN ('general', 'chat'))`).
--
-- Not RLS/grant-related: public.requests already has "Company isolation" RLS
-- (20260612090011_requests.sql), direct INSERT/UPDATE/DELETE from
-- `authenticated` is already revoked (20260723000009_expenses_requests_hr_
-- security.sql), and public.update_request() (the only RPC that mutates this
-- table) never touches `mode` - it only updates `notes`/`status`. The
-- Telegram webhook writes `mode` via the service-role client
-- (supabaseServer), which bypasses RLS/grants entirely. So this migration is
-- purely a data + constraint change; no policy, grant, or RPC changes are
-- needed here.
--
-- Constraint-name handling: the original CHECK was added inline via
-- `ALTER TABLE ... ADD COLUMN mode text ... CHECK (...)` with no explicit
-- name, so Postgres auto-generated it. For a table's first (and only) CHECK
-- constraint on a given column, Postgres's naming convention produces
-- `<table>_<column>_check`, i.e. `requests_mode_check` here - but rather
-- than hardcode that assumption, the DO block below looks the constraint up
-- dynamically via pg_constraint/pg_attribute (matching on contype = 'c' and
-- a conkey entry pointing at the `mode` column) and drops whatever name it
-- actually finds. This is the robust equivalent of checking
-- information_schema.check_constraints against the live schema, and avoids
-- a hardcoded-name migration failing if the live name ever differs from the
-- expected convention. If nothing is found (e.g. already dropped by a prior
-- partial run), the block is a no-op rather than erroring, so this migration
-- is safely re-runnable.
--
-- Ordering: drop the old CHECK first (a plain rename in place would violate
-- it), then backfill data, then flip the column DEFAULT, then add the new
-- CHECK last. Adding the new CHECK after the data is already conformant
-- means Postgres's validation scan (run automatically when a CHECK is
-- added) always passes - there is no window where a row violates either
-- constraint, since between steps 1 and 4 there is temporarily no CHECK at
-- all on this column (acceptable here: `mode` is not referenced by any FK,
-- RPC, or RLS policy, and the table is not written to by `authenticated`
-- directly, so nothing else can insert a stray value in that gap in
-- practice).

-- 1. Drop the existing (auto-named) CHECK constraint on `mode`.
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT con.conname INTO v_conname
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid
   AND att.attnum = ANY (con.conkey)
  WHERE con.conrelid = 'public.requests'::regclass
    AND con.contype = 'c'
    AND att.attname = 'mode';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.requests DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

-- 2. Backfill existing data to the new vocabulary.
UPDATE public.requests SET mode = 'shikoyat' WHERE mode = 'general';
UPDATE public.requests SET mode = 'murojat' WHERE mode = 'chat';

-- 3. Flip the column default so new rows (e.g. future webhook inserts made
--    before app code is updated) still land in a valid state.
ALTER TABLE public.requests ALTER COLUMN mode SET DEFAULT 'shikoyat';

-- 4. Re-add the CHECK constraint with the new allowed values, explicitly
--    named this time for predictable future lookups.
ALTER TABLE public.requests
  ADD CONSTRAINT requests_mode_check CHECK (mode IN ('shikoyat', 'murojat'));
