-- Hisob-fakturalar (invoices) va ularning tarkibidagi mahsulotlar

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  subtotal numeric(14, 2) not null default 0,
  discount numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  status text not null default 'pending' check (status in ('paid', 'pending', 'overdue')),
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index invoices_company_id_idx on public.invoices(company_id);
create index invoices_customer_id_idx on public.invoices(customer_id);

create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

alter table public.invoices enable row level security;

create policy "Company isolation" on public.invoices
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());

-- Now that invoices exists, link transactions to it
alter table public.transactions
  add constraint transactions_invoice_id_fkey
  foreign key (invoice_id) references public.invoices(id) on delete set null;


create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text,
  quantity integer not null default 1,
  price numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0
);

create index invoice_items_company_id_idx on public.invoice_items(company_id);
create index invoice_items_invoice_id_idx on public.invoice_items(invoice_id);

alter table public.invoice_items enable row level security;

create policy "Company isolation" on public.invoice_items
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());
