-- balance and monthly_fee already exist (20260713000002_add_balance.sql,
-- 20260713000003_billing.sql) — these ADD COLUMN IF NOT EXISTS are no-ops.
-- last_payment_date is the only new column.
ALTER TABLE public.companies
ADD COLUMN IF NOT EXISTS balance numeric(14,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS monthly_fee numeric(14,2) DEFAULT 150000,
ADD COLUMN IF NOT EXISTS last_payment_date date;
