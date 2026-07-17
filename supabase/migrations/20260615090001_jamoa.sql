-- Jamoa (team) module: per-company user limits and per-user page permissions

alter table public.companies
add column if not exists user_limit integer not null default 1;

alter table public.users
add column if not exists permissions jsonb not null default '{
  "dashboard": true,
  "pos": true,
  "customers": true,
  "inventory": true,
  "kirim": true,
  "chiqim": true,
  "mahsulotlar": true,
  "mahsulot_guruhi": true,
  "reports": true,
  "marketing": true,
  "invoices": true,
  "requests": true,
  "hr": true,
  "sozlamalar": true,
  "jamoa": true
}'::jsonb;
