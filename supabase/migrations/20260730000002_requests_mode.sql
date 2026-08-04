-- Telegram bot integration: persist the customer's mode selection.
--
-- The webhook (app/api/telegram/webhook/route.ts) offers a linked customer
-- two classification buttons - "So'rov yuborish" (general request) vs
-- "Do'kon bilan muloqot" (personal chat with the store) - but requests.type
-- has a hard CHECK (type IN ('complaint','inquiry','return')) constraint
-- (20260612090011_requests.sql) that is staff-facing and cannot be
-- repurposed without breaking existing semantics. A dedicated `mode` column
-- is added instead so the customer's choice can be persisted.
--
-- Not RLS/grant-related: requests already has "Company isolation" RLS
-- (20260612090011_requests.sql) and direct INSERT/UPDATE/DELETE from
-- `authenticated` is already revoked (20260723000009_expenses_requests_hr_
-- security.sql). The Telegram webhook writes via the service-role client
-- (supabaseServer, see app/api/telegram/webhook/route.ts), which bypasses
-- RLS and grants entirely - so a plain ADD COLUMN needs no policy or grant
-- changes here, and no new RPC is needed for this column alone.
ALTER TABLE public.requests ADD COLUMN IF NOT EXISTS mode text DEFAULT 'general' CHECK (mode IN ('general', 'chat'));

-- Update existing telegram requests to 'general' by default
UPDATE public.requests SET mode = 'general' WHERE source = 'telegram' AND mode IS NULL;
