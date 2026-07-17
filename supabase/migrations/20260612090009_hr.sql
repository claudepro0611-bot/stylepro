-- HR Modul: bo'limlar, lavozimlar, xodimlar, mukofot/jarima turlari va yozuvlari

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  manager_id uuid,
  manager_name text,
  description text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index departments_company_id_idx on public.departments(company_id);

create trigger departments_set_updated_at
  before update on public.departments
  for each row execute function public.set_updated_at();

alter table public.departments enable row level security;

create policy "Company isolation" on public.departments
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.positions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  department_id uuid references public.departments(id) on delete set null,
  department_name text,
  description text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index positions_company_id_idx on public.positions(company_id);
create index positions_department_id_idx on public.positions(department_id);

create trigger positions_set_updated_at
  before update on public.positions
  for each row execute function public.set_updated_at();

alter table public.positions enable row level security;

create policy "Company isolation" on public.positions
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  phone text,
  birth_date date,
  address text,
  position_id uuid references public.positions(id) on delete set null,
  position_name text,
  department_id uuid references public.departments(id) on delete set null,
  department_name text,
  salary numeric(14, 2) not null default 0,
  start_date date not null default current_date,
  photo_url text,
  status text not null default 'active' check (status in ('active', 'on-leave', 'terminated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index employees_company_id_idx on public.employees(company_id);
create index employees_department_id_idx on public.employees(department_id);
create index employees_position_id_idx on public.employees(position_id);

create trigger employees_set_updated_at
  before update on public.employees
  for each row execute function public.set_updated_at();

alter table public.employees enable row level security;

create policy "Company isolation" on public.employees
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.position_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  date date not null default current_date,
  position_name text,
  department_name text,
  salary numeric(14, 2) not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create index position_history_company_id_idx on public.position_history(company_id);
create index position_history_employee_id_idx on public.position_history(employee_id);

alter table public.position_history enable row level security;

create policy "Company isolation" on public.position_history
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.reward_penalty_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  amount numeric(14, 2) not null default 0,
  kind text not null check (kind in ('fixed', 'percent', 'oneTime', 'perOccurrence', 'perDay')),
  category text not null check (category in ('reward', 'penalty')),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index reward_penalty_types_company_id_idx on public.reward_penalty_types(company_id);

create trigger reward_penalty_types_set_updated_at
  before update on public.reward_penalty_types
  for each row execute function public.set_updated_at();

alter table public.reward_penalty_types enable row level security;

create policy "Company isolation" on public.reward_penalty_types
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());


create table public.reward_penalty_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  employee_name text,
  department_name text,
  type text not null check (type in ('reward', 'penalty')),
  type_id uuid references public.reward_penalty_types(id) on delete set null,
  type_name text,
  amount numeric(14, 2) not null default 0,
  date date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create index reward_penalty_entries_company_id_idx on public.reward_penalty_entries(company_id);
create index reward_penalty_entries_employee_id_idx on public.reward_penalty_entries(employee_id);

alter table public.reward_penalty_entries enable row level security;

create policy "Company isolation" on public.reward_penalty_entries
  for all
  using (company_id = public.get_company_id())
  with check (company_id = public.get_company_id());
