-- R4b RLS 修正
-- 1) members 自引用 policy 会触发 PostgreSQL "infinite recursion detected in policy"：
--    改为 security definer 助手函数 is_member/is_owner（绕过 RLS，无递归）。
-- 2) 私有组原本无法加入：members 仅 owner 可写、非成员读不到组。
--    新增「凭 gid 自助加入」insert policy（邀约链接即授权）：user_id = auth.uid() 且 role='member'。

create or replace function public.is_member(gid text)
  returns boolean language sql security definer stable
  set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.members m where m.group_id = gid and m.user_id = auth.uid()
    );
  $$;

create or replace function public.is_owner(gid text)
  returns boolean language sql security definer stable
  set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.groups g where g.id = gid and g.owner_id = auth.uid()
    );
  $$;

grant execute on function public.is_member(text) to authenticated;
grant execute on function public.is_member(text) to anon;
grant execute on function public.is_owner(text) to authenticated;

-- groups：公开组匿名/任何人可读；否则须是成员
drop policy if exists groups_read on public.groups;
create policy groups_read on public.groups for select
  using (visibility = 'public' or public.is_member(id));

-- members：成员可读本组；owner 可增删改；登录用户可凭 gid 把自己加入（role=member）
drop policy if exists members_read on public.members;
create policy members_read on public.members for select
  using (public.is_member(group_id));

drop policy if exists members_write on public.members;
create policy members_write on public.members for all
  using (public.is_owner(group_id)) with check (public.is_owner(group_id));

drop policy if exists members_self_join on public.members;
create policy members_self_join on public.members for insert
  with check (user_id = auth.uid() and role = 'member');

-- packs：公开组任何人可读，或本组成员可读；成员可写
drop policy if exists packs_read on public.packs;
create policy packs_read on public.packs for select
  using (exists (
    select 1 from public.groups g
    where g.id = packs.group_id
      and (g.visibility = 'public' or public.is_member(g.id))
  ));

drop policy if exists packs_write on public.packs;
create policy packs_write on public.packs for all
  using (public.is_member(group_id)) with check (public.is_member(group_id));
