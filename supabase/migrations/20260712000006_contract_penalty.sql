ALTER TABLE public.companies
ADD COLUMN IF NOT EXISTS has_contract boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS daily_penalty numeric(14,2) DEFAULT 33000,
ADD COLUMN IF NOT EXISTS penalty_days integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_penalty numeric(14,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS grace_period_start date,
ADD COLUMN IF NOT EXISTS max_grace_days integer DEFAULT 5;
