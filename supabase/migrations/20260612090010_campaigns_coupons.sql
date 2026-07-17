-- Aksiyalar (campaigns) va kuponlar (coupons)

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  type text not null check (type in ('coupon', 'discount', 'promo')),
  status text not null default 'active' check (status in ('active', 'inactive', 'ended')),
  discount numeric(6, 2) not null default 0,
  start_date date,
  end_date date,
  usage_count integer not null default 0,
  usage_limit integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index campaigns_company_id_idx on public.campaigns(company_id);

create trigger campaigns_set_updated_at
  before update on public.campaigns
  for each row execute function public.set_updated_at();

alter table public.campaigns enable row level security;

create policy "Company isolation" on public.campaigns
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null,
  discount numeric(6, 2) not null default 0,
  usage_limit integer not null default 0,
  used_count integer not null default 0,
  expiry_date date,
  status text not null default 'active' check (status in ('active', 'inactive', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index coupons_company_id_idx on public.coupons(company_id);
create unique index coupons_company_code_idx on public.coupons(company_id, code);

create trigger coupons_set_updated_at
  before update on public.coupons
  for each row execute function public.set_updated_at();

alter table public.coupons enable row level security;

create policy "Company isolation" on public.coupons
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());
