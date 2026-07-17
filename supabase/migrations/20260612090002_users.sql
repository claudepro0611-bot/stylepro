-- Foydalanuvchilar (users) - linked 1:1 with auth.users, scoped to a company
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  full_name text not null default '',
  email text not null,
  phone text,
  role text not null default 'staff' check (role in ('owner', 'admin', 'manager', 'staff')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_company_id_idx on public.users(company_id);

alter table public.users enable row level security;
