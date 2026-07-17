ALTER TABLE public.companies
ADD COLUMN IF NOT EXISTS balance numeric(14,2) DEFAULT 0;
