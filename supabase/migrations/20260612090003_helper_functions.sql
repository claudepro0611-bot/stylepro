-- Shared helper functions, triggers and base policies for companies/users

-- Returns the company_id of the currently authenticated user.
-- security definer + fixed search_path lets this read public.users even though
-- the caller's RLS policy on public.users would otherwise block the lookup.
create or replace function public.get_company_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select company_id from public.users where id = auth.uid()
$$;

-- Generic updated_at maintenance trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Auto-provision a public.users row whenever a new auth user signs up.
-- company_id starts as null - the app assigns it during onboarding.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- companies policies
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

create policy "Users can view own company" on public.companies
  for select using (id = public.get_company_id());

create policy "Authenticated users can create a company" on public.companies
  for insert with check (auth.uid() is not null);

create policy "Users can update own company" on public.companies
  for update using (id = public.get_company_id())
  with check (id = public.get_company_id());

-- users policies
create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

create policy "Users can view colleagues" on public.users
  for select using (company_id = public.get_company_id());

create policy "Users can update own profile" on public.users
  for update using (id = auth.uid())
  with check (id = auth.uid());
