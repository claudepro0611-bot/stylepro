-- Ombor harakatlari: kirim (stock in) va chiqim (stock out)

create table public.stock_in_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text,
  category text,
  size text,
  color text,
  quantity integer not null default 0,
  unit_price numeric(14, 2) not null default 0,
  total_amount numeric(14, 2) not null default 0,
  supplier text,
  date date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create index stock_in_entries_company_id_idx on public.stock_in_entries(company_id);
create index stock_in_entries_product_id_idx on public.stock_in_entries(product_id);

alter table public.stock_in_entries enable row level security;

create policy "Company isolation" on public.stock_in_entries
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.stock_out_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text,
  category text,
  size text,
  color text,
  quantity integer not null default 0,
  sell_price numeric(14, 2) not null default 0,
  total_amount numeric(14, 2) not null default 0,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  payment_method text,
  date date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create index stock_out_entries_company_id_idx on public.stock_out_entries(company_id);
create index stock_out_entries_product_id_idx on public.stock_out_entries(product_id);
create index stock_out_entries_customer_id_idx on public.stock_out_entries(customer_id);

alter table public.stock_out_entries enable row level security;

create policy "Company isolation" on public.stock_out_entries
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());
