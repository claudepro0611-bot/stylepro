-- Smena (cashier shift) tracking for the POS module

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  cashier_id uuid references public.users(id) on delete set null,
  cashier_name text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  initial_cash numeric(14,2) default 0,
  total_sales integer default 0,
  total_amount numeric(14,2) default 0,
  cash_amount numeric(14,2) default 0,
  card_amount numeric(14,2) default 0,
  click_amount numeric(14,2) default 0,
  payme_amount numeric(14,2) default 0,
  status text default 'active' check (status in ('active','closed')),
  created_at timestamptz default now()
);

create index shifts_company_id_idx on public.shifts(company_id);
create index shifts_cashier_id_idx on public.shifts(cashier_id);

alter table public.shifts enable row level security;

create policy "Company isolation" on public.shifts
  for all using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());

-- Link each sale to the shift and cashier that recorded it, so the
-- shift closing report and the sales archive can be filtered by cashier.
alter table public.transactions
  add column if not exists shift_id uuid references public.shifts(id) on delete set null,
  add column if not exists cashier_id uuid references public.users(id) on delete set null,
  add column if not exists cashier_name text;

create index if not exists transactions_shift_id_idx on public.transactions(shift_id);
