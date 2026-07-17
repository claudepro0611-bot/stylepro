-- Add the "arxiv" (archive) page permission

alter table public.users
alter column permissions set default '{
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
  "jamoa": true,
  "arxiv": true
}'::jsonb;

update public.users
set permissions = permissions || '{"arxiv": true}'::jsonb
where not (permissions ? 'arxiv');
