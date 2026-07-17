-- So'rovlar (requests): shikoyat, savol, qaytarish

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  type text not null check (type in ('complaint', 'inquiry', 'return')),
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status text not null default 'new' check (status in ('new', 'in-progress', 'resolved')),
  message text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index requests_company_id_idx on public.requests(company_id);
create index requests_customer_id_idx on public.requests(customer_id);

create trigger requests_set_updated_at
  before update on public.requests
  for each row execute function public.set_updated_at();

alter table public.requests enable row level security;

create policy "Company isolation" on public.requests
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());
