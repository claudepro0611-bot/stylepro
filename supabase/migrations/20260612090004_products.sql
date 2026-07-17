-- Mahsulotlar (products) va mahsulot guruhlari (product groups)

create table public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  sku text,
  category text,
  price numeric(14, 2) not null default 0,
  description text,
  sizes text[] not null default '{}',
  colors text[] not null default '{}',
  stock integer not null default 0,
  min_stock integer not null default 0,
  image_url text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index products_company_id_idx on public.products(company_id);
create unique index products_company_sku_idx on public.products(company_id, sku) where sku is not null;

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

alter table public.products enable row level security;

create policy "Company isolation" on public.products
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.product_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index product_groups_company_id_idx on public.product_groups(company_id);

create trigger product_groups_set_updated_at
  before update on public.product_groups
  for each row execute function public.set_updated_at();

alter table public.product_groups enable row level security;

create policy "Company isolation" on public.product_groups
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());
