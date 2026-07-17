-- Tranzaksiyalar (transactions) va ularning tarkibidagi mahsulotlar

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  total_amount numeric(14, 2) not null default 0,
  date date not null default current_date,
  payment_method text,
  invoice_id uuid,
  status text not null default 'completed' check (status in ('completed', 'pending', 'cancelled')),
  created_at timestamptz not null default now()
);

create index transactions_company_id_idx on public.transactions(company_id);
create index transactions_customer_id_idx on public.transactions(customer_id);

alter table public.transactions enable row level security;

create policy "Company isolation" on public.transactions
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.transaction_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text,
  quantity integer not null default 1,
  price numeric(14, 2) not null default 0
);

create index transaction_items_company_id_idx on public.transaction_items(company_id);
create index transaction_items_transaction_id_idx on public.transaction_items(transaction_id);

alter table public.transaction_items enable row level security;

create policy "Company isolation" on public.transaction_items
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());
