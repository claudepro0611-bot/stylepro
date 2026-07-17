-- Mijozlar (customers) va ularning xaridlari (purchases)

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  full_name text not null,
  phone text,
  email text,
  address text,
  status text not null default 'New' check (status in ('VIP', 'Regular', 'New')),
  total_purchases numeric(14, 2) not null default 0,
  last_purchase_date date,
  complaints text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index customers_company_id_idx on public.customers(company_id);

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

alter table public.customers enable row level security;

create policy "Company isolation" on public.customers
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  date date not null default current_date,
  amount numeric(14, 2) not null default 0,
  items text[] not null default '{}',
  payment_method text,
  created_at timestamptz not null default now()
);

create index purchases_company_id_idx on public.purchases(company_id);
create index purchases_customer_id_idx on public.purchases(customer_id);

alter table public.purchases enable row level security;

create policy "Company isolation" on public.purchases
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());
