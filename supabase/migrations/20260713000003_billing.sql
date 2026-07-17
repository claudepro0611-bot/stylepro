-- Note: companies.status already exists (account active/inactive toggle used
-- throughout the admin panel). The new billing tri-state lives in a separate
-- billing_status column to avoid colliding with it.
ALTER TABLE public.companies
ADD COLUMN IF NOT EXISTS monthly_fee numeric(14,2) DEFAULT 150000,
ADD COLUMN IF NOT EXISTS next_payment_date date DEFAULT (now() + interval '30 days'),
ADD COLUMN IF NOT EXISTS billing_status text DEFAULT 'active'
  CHECK (billing_status IN ('active', 'warning', 'blocked'));
