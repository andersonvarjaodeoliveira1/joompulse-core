-- =====================================================================
-- 003_users_quotas_rls.sql — usuários, planos, quotas e segurança
--
-- Construa isto AGORA, mesmo sem cobrar nada ainda. Enfiar controle de
-- quota num app já pronto obriga a tocar em todos os endpoints.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PLANOS
-- limits é jsonb: -1 = ilimitado, 0 = bloqueado, N = N usos por mês.
-- Mudar preço/limite vira UPDATE, não deploy.
-- ---------------------------------------------------------------------
create table if not exists plans (
  code        text primary key,
  name        text not null,
  price_cents int not null default 0,
  interval    text not null default 'month',
  sort_order  int not null default 0,
  is_public   boolean not null default true,
  limits      jsonb not null default '{}'::jsonb
);

insert into plans (code, name, price_cents, sort_order, limits) values
  ('free', 'Gratuito', 0, 0, '{
     "product_search": 5, "category_view": 3, "seller_search": 3,
     "calculator": 5, "tracked_items": 4, "competitor_analysis": 0,
     "ai_content": 0, "export_csv": 0
   }'::jsonb),
  ('starter', 'Starter', 9700, 1, '{
     "product_search": 100, "category_view": 50, "seller_search": 50,
     "calculator": -1, "tracked_items": 50, "competitor_analysis": 10,
     "ai_content": 5, "export_csv": 10
   }'::jsonb),
  ('pro', 'Pro', 19700, 2, '{
     "product_search": 500, "category_view": -1, "seller_search": 300,
     "calculator": -1, "tracked_items": 300, "competitor_analysis": 100,
     "ai_content": 30, "export_csv": -1
   }'::jsonb),
  ('business', 'Business', 39700, 3, '{
     "product_search": -1, "category_view": -1, "seller_search": -1,
     "calculator": -1, "tracked_items": 2000, "competitor_analysis": -1,
     "ai_content": 150, "export_csv": -1
   }'::jsonb)
on conflict (code) do update
  set name = excluded.name,
      price_cents = excluded.price_cents,
      limits = excluded.limits;

-- ---------------------------------------------------------------------
-- PERFIS
-- ---------------------------------------------------------------------
create table if not exists profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  email              text,
  full_name          text,
  plan               text not null default 'free' references plans(code),
  trial_ends_at      timestamptz,
  stripe_customer_id text,
  subscription_status text default 'none',   -- none | trialing | active | past_due | canceled
  onboarding_step    int not null default 0,
  created_at         timestamptz not null default now()
);

-- Cria o perfil sozinho quando alguém se cadastra.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, trial_ends_at)
  values (new.id, new.email,
          new.raw_user_meta_data ->> 'full_name',
          now() + interval '7 days')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------
-- CONTADORES DE USO
-- ---------------------------------------------------------------------
create table if not exists usage_counters (
  user_id      uuid not null references profiles(id) on delete cascade,
  feature      text not null,
  period_start date not null,
  used         int  not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (user_id, feature, period_start)
);

-- ---------------------------------------------------------------------
-- consume_quota() — o coração da monetização.
--
-- Checa e incrementa numa ÚNICA instrução UPDATE. Isso importa: se você
-- fizer SELECT e depois UPDATE, dois cliques simultâneos passam do
-- limite. A condição "used + amount <= limite" dentro do WHERE fecha
-- essa brecha sem precisar de lock explícito.
--
-- Chame do front SEMPRE antes de rodar a busca, nunca depois.
-- ---------------------------------------------------------------------
create or replace function consume_quota(p_feature text, p_amount int default 1)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_plan   text;
  v_limit  int;
  v_period date := date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date;
  v_used   int;
begin
  if v_user is null then
    raise exception 'nao autenticado' using errcode = '28000';
  end if;

  select plan into v_plan from profiles where id = v_user;
  select coalesce((limits ->> p_feature)::int, 0) into v_limit
    from plans where code = coalesce(v_plan, 'free');

  if v_limit = -1 then
    return jsonb_build_object('allowed', true, 'unlimited', true,
                              'remaining', null, 'limit', -1);
  end if;

  if v_limit <= 0 then
    return jsonb_build_object('allowed', false, 'unlimited', false,
                              'remaining', 0, 'limit', 0,
                              'reason', 'plan_upgrade_required');
  end if;

  insert into usage_counters (user_id, feature, period_start, used)
  values (v_user, p_feature, v_period, 0)
  on conflict (user_id, feature, period_start) do nothing;

  update usage_counters
     set used = used + p_amount, updated_at = now()
   where user_id = v_user
     and feature = p_feature
     and period_start = v_period
     and used + p_amount <= v_limit
  returning used into v_used;

  if v_used is null then
    select used into v_used from usage_counters
     where user_id = v_user and feature = p_feature and period_start = v_period;
    return jsonb_build_object('allowed', false, 'unlimited', false,
                              'remaining', greatest(v_limit - coalesce(v_used, 0), 0),
                              'limit', v_limit, 'reason', 'quota_exceeded');
  end if;

  return jsonb_build_object('allowed', true, 'unlimited', false,
                            'remaining', v_limit - v_used, 'limit', v_limit);
end;
$$;

-- Somente leitura — para desenhar o badge "Pesquisas restantes: N"
-- sem gastar quota ao renderizar a tela.
create or replace function quota_status()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_plan   text;
  v_limits jsonb;
  v_period date := date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date;
  v_out    jsonb := '{}'::jsonb;
  k        text;
  lim      int;
  used     int;
begin
  if v_user is null then
    raise exception 'nao autenticado' using errcode = '28000';
  end if;

  select plan into v_plan from profiles where id = v_user;
  select limits into v_limits from plans where code = coalesce(v_plan, 'free');

  for k in select jsonb_object_keys(v_limits) loop
    lim := (v_limits ->> k)::int;
    select coalesce(uc.used, 0) into used
      from usage_counters uc
     where uc.user_id = v_user and uc.feature = k and uc.period_start = v_period;
    used := coalesce(used, 0);
    v_out := v_out || jsonb_build_object(k, jsonb_build_object(
      'limit', lim,
      'used', used,
      'remaining', case when lim = -1 then null else greatest(lim - used, 0) end,
      'unlimited', lim = -1
    ));
  end loop;

  return jsonb_build_object('plan', v_plan, 'period_start', v_period, 'features', v_out);
end;
$$;

-- ---------------------------------------------------------------------
-- MONITOR — pastas e itens acompanhados
-- ---------------------------------------------------------------------
create table if not exists tracked_folders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  name       text not null,
  color      text default 'gray',
  created_at timestamptz not null default now()
);

create table if not exists tracked_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  folder_id    uuid references tracked_folders(id) on delete set null,
  item_id      text not null references items(id) on delete cascade,
  notify_price boolean not null default true,
  notify_stock boolean not null default false,
  price_at_add numeric(12,2),
  created_at   timestamptz not null default now(),
  unique (user_id, item_id)
);
create index if not exists tracked_items_user_idx on tracked_items(user_id);

-- Item monitorado por alguém vira prioridade máxima de coleta.
--
-- security definer é obrigatório aqui: o usuário logado tem apenas
-- SELECT em items (ver migration de grants), e este trigger faz UPDATE.
-- Sem isso, todo insert em tracked_items falha com "permission denied
-- for table items" e o Monitor inteiro para de funcionar.
create or replace function bump_item_priority()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update items set collect_priority = 2 where id = new.item_id;
  return new;
end $$;

drop trigger if exists on_track_item on tracked_items;
create trigger on_track_item
  after insert on tracked_items
  for each row execute function bump_item_priority();

create table if not exists tracked_sellers (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  seller_id  bigint not null references sellers(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, seller_id)
);

-- ---------------------------------------------------------------------
-- CALCULADORA — predefinições salvas
-- ---------------------------------------------------------------------
create table if not exists calculator_presets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  name       text not null,
  config     jsonb not null default '{}'::jsonb,  -- comissão, frete, imposto, custos fixos
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- RLS
-- Dado de mercado: qualquer usuário logado LÊ, ninguém escreve.
-- O coletor usa a service_role key, que ignora RLS.
-- Dado do usuário: só o dono.
-- ---------------------------------------------------------------------
alter table profiles           enable row level security;
alter table usage_counters     enable row level security;
alter table tracked_folders    enable row level security;
alter table tracked_items      enable row level security;
alter table tracked_sellers    enable row level security;
alter table calculator_presets enable row level security;
alter table items              enable row level security;
alter table categories         enable row level security;
alter table sellers            enable row level security;
alter table item_snapshots     enable row level security;
alter table plans              enable row level security;

drop policy if exists own_profile         on profiles;
drop policy if exists own_profile_update  on profiles;
create policy own_profile        on profiles for select using (id = auth.uid());
create policy own_profile_update on profiles for update using (id = auth.uid())
  with check (id = auth.uid() and plan = (select plan from profiles where id = auth.uid()));

drop policy if exists own_usage on usage_counters;
create policy own_usage on usage_counters for select using (user_id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['tracked_folders','tracked_items','tracked_sellers','calculator_presets'] loop
    execute format('drop policy if exists own_rows on %I', t);
    execute format(
      'create policy own_rows on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;

  foreach t in array array['items','categories','sellers','item_snapshots','plans'] loop
    execute format('drop policy if exists read_authenticated on %I', t);
    execute format(
      'create policy read_authenticated on %I for select to authenticated using (true)', t);
  end loop;
end $$;
