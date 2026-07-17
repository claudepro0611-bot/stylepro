ALTER TABLE public.companies
ADD COLUMN IF NOT EXISTS payment_due_date date;
