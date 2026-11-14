-- Well Closure Field App v0.3: shared data and logins.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Roles: manager sees and edits everything; crew sees and edits only the
-- sites in packages assigned to them. Anyone not on the team sees nothing.

-- Team members: who may use the app, and their role.
create table if not exists public.team (
  email text primary key check (email = lower(email)),
  name  text not null,
  role  text not null check (role in ('manager','crew')),
  added_at timestamptz not null default now()
);

-- Work packages. data holds the app's package record (name, dates, notes, wells in visit order).
create table if not exists public.packages (
  id text primary key,
  data jsonb not null,
  crew_email text references public.team(email) on update cascade on delete set null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Site records, one per well licence. data holds the app's site record, with photo details but not the image files.
create table if not exists public.sites (
  licence text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

create index if not exists packages_updated on public.packages(updated_at);
create index if not exists sites_updated on public.sites(updated_at);

-- Server sets updated_at and updated_by, so clocks on phones don't matter for syncing.
create or replace function public.stamp() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := lower(coalesce(auth.jwt()->>'email', 'system'));
  return new;
end $$;
drop trigger if exists stamp on public.packages;
create trigger stamp before insert or update on public.packages for each row execute function public.stamp();
drop trigger if exists stamp on public.sites;
create trigger stamp before insert or update on public.sites for each row execute function public.stamp();

-- Who is signed in, and what may they do.
create or replace function public.my_email() returns text language sql stable as $$
  select lower(coalesce(auth.jwt()->>'email', ''))
$$;
create or replace function public.my_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.team where email = public.my_email()
$$;
create or replace function public.can_site(lic text) returns boolean language sql stable security definer set search_path = public as $$
  select public.my_role() = 'manager'
      or (public.my_role() = 'crew' and exists (
            select 1 from public.packages p
            where p.crew_email = public.my_email() and not p.deleted and p.data->'wells' ? lic))
$$;

alter table public.team enable row level security;
alter table public.packages enable row level security;
alter table public.sites enable row level security;

drop policy if exists team_read on public.team;
create policy team_read on public.team for select to authenticated using (public.my_role() is not null);
drop policy if exists team_manage on public.team;
create policy team_manage on public.team for all to authenticated using (public.my_role() = 'manager') with check (public.my_role() = 'manager');

drop policy if exists packages_read on public.packages;
create policy packages_read on public.packages for select to authenticated
  using (public.my_role() = 'manager' or (public.my_role() = 'crew' and crew_email = public.my_email()));
drop policy if exists packages_write on public.packages;
create policy packages_write on public.packages for all to authenticated
  using (public.my_role() = 'manager') with check (public.my_role() = 'manager');

drop policy if exists sites_read on public.sites;
create policy sites_read on public.sites for select to authenticated using (public.can_site(licence));
drop policy if exists sites_insert on public.sites;
create policy sites_insert on public.sites for insert to authenticated with check (public.can_site(licence));
drop policy if exists sites_update on public.sites;
create policy sites_update on public.sites for update to authenticated using (public.can_site(licence)) with check (public.can_site(licence));

-- The app reads and writes these tables through the Data API.
grant select on public.team to authenticated;
grant insert, update, delete on public.team to authenticated;
grant select, insert, update on public.packages, public.sites to authenticated;
grant execute on function public.my_role(), public.my_email(), public.can_site(text) to authenticated;

-- Live updates for the office.
do $$ begin
  begin alter publication supabase_realtime add table public.packages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.sites; exception when duplicate_object then null; end;
end $$;

-- Private photo storage. Files are stored as <licence>/<photo id>.jpg.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists photos_obj_read on storage.objects;
create policy photos_obj_read on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.can_site(split_part(name, '/', 1)));
drop policy if exists photos_obj_insert on storage.objects;
create policy photos_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.can_site(split_part(name, '/', 1)));
drop policy if exists photos_obj_update on storage.objects;
create policy photos_obj_update on storage.objects for update to authenticated
  using (bucket_id = 'photos' and public.can_site(split_part(name, '/', 1)));

-- First team members. Add more later from the app's Team screen (managers only).
insert into public.team (email, name, role) values
  ('rbp@shaw.ca', 'Bob Parkinson', 'manager')
on conflict (email) do update set name = excluded.name, role = excluded.role;
