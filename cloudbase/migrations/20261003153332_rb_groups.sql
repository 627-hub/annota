create table if not exists public.groups (
  id           text primary key,
  name         text not null,
  owner_id     text not null default auth.uid(),
  visibility   text not null default 'private',
  content_list jsonb not null default '{"items":[]}'::jsonb,
  pack_index   jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.members (
  group_id  text not null references public.groups(id) on delete cascade,
  user_id   text not null,
  role      text not null default 'member',
  name      text,
  added_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.packs (
  group_id   text not null references public.groups(id) on delete cascade,
  media_key  text not null,
  media      jsonb not null default '{}'::jsonb,
  entries    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (group_id, media_key)
);

create index if not exists members_user_idx on public.members (user_id);
create index if not exists packs_group_idx on public.packs (group_id);

grant select, insert, update, delete on public.groups  to authenticated;
grant select, insert, update, delete on public.members to authenticated;
grant select, insert, update, delete on public.packs   to authenticated;
grant select on public.groups to anon;
grant select on public.packs  to anon;

alter table public.groups  enable row level security;
alter table public.members enable row level security;
alter table public.packs   enable row level security;

create policy groups_read on public.groups for select
  using (visibility = 'public'
     or exists (select 1 from public.members m where m.group_id = id and m.user_id = auth.uid()));
create policy groups_insert on public.groups for insert
  with check (owner_id = auth.uid());
create policy groups_update on public.groups for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy members_read on public.members for select
  using (exists (select 1 from public.members m where m.group_id = members.group_id and m.user_id = auth.uid()));
create policy members_write on public.members for all
  using (exists (select 1 from public.groups g where g.id = members.group_id and g.owner_id = auth.uid()))
  with check (exists (select 1 from public.groups g where g.id = members.group_id and g.owner_id = auth.uid()));
create policy packs_read on public.packs for select
  using (exists (select 1 from public.groups g where g.id = packs.group_id
    and (g.visibility = 'public'
      or exists (select 1 from public.members m where m.group_id = g.id and m.user_id = auth.uid()))));
create policy packs_write on public.packs for all
  using (exists (select 1 from public.members m where m.group_id = packs.group_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.members m where m.group_id = packs.group_id and m.user_id = auth.uid()));
