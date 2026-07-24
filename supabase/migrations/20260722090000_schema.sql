-- =====================================================================
-- 001_schema.sql — núcleo de dados de mercado
-- Rode este arquivo primeiro, no SQL Editor do Supabase.
-- =====================================================================

-- pg_trgm alimenta os índices de busca por texto em nomes de categoria,
-- título de anúncio e nickname de vendedor.
--
-- Não declaramos pg_cron aqui de propósito: a rodada diária roda num
-- worker externo (ver README), e pedir uma extensão que não é usada só
-- cria um ponto de falha na hora do db push.
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------
-- CATEGORIAS
-- Árvore de categorias do marketplace. path_ids permite consultar
-- "tudo abaixo de MLB1276" sem recursão em tempo de query.
-- ---------------------------------------------------------------------
create table if not exists categories (
  id              text primary key,                 -- MLB1276
  site_id         text not null default 'MLB',
  name            text not null,
  parent_id       text references categories(id),
  root_id         text,                             -- ancestral de nível 0
  path_ids        text[] not null default '{}',     -- [MLB1276, MLB1234, ...]
  path_names      text[] not null default '{}',
  level           int  not null default 0,
  is_leaf         boolean not null default false,
  total_items_ml  bigint,                           -- contagem que o próprio ML reporta
  last_synced_at  timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists categories_parent_idx on categories(parent_id);
create index if not exists categories_root_idx   on categories(root_id);
create index if not exists categories_path_idx   on categories using gin(path_ids);
create index if not exists categories_name_trgm  on categories using gin(name gin_trgm_ops);

-- ---------------------------------------------------------------------
-- VENDEDORES
-- ---------------------------------------------------------------------
create table if not exists sellers (
  id                bigint primary key,             -- seller_id do ML
  site_id           text not null default 'MLB',
  nickname          text,
  city              text,
  state             text,
  country           text default 'BR',
  registration_date timestamptz,
  official_store_id int,
  is_official_store boolean not null default false,
  permalink         text,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  last_synced_at    timestamptz
);
create index if not exists sellers_nickname_trgm on sellers using gin(nickname gin_trgm_ops);
create index if not exists sellers_state_idx     on sellers(state);
create index if not exists sellers_reg_idx       on sellers(registration_date);

-- ---------------------------------------------------------------------
-- ANÚNCIOS (dimensão — muda pouco)
-- ---------------------------------------------------------------------
create table if not exists items (
  id                      text primary key,         -- MLB1234567890
  site_id                 text not null default 'MLB',
  title                   text not null,
  category_id             text references categories(id),
  seller_id               bigint references sellers(id),
  brand                   text,
  model                   text,
  catalog_product_id      text,
  is_catalog_listing      boolean not null default false,
  listing_type_id         text,                     -- gold_special, gold_pro
  condition               text,                     -- new, used
  shipping_free           boolean not null default false,
  shipping_logistic_type  text,                     -- fulfillment = Full
  official_store_id       int,
  permalink               text,
  thumbnail               text,
  ml_date_created         timestamptz,
  status                  text not null default 'active',
  -- prioridade de coleta: 0 = long tail, 1 = categoria quente, 2 = monitorado
  collect_priority        smallint not null default 0,
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now()
);
create index if not exists items_category_idx  on items(category_id);
create index if not exists items_seller_idx    on items(seller_id);
create index if not exists items_brand_idx     on items(brand);
create index if not exists items_priority_idx  on items(collect_priority desc, last_seen_at asc);
create index if not exists items_title_trgm    on items using gin(title gin_trgm_ops);

-- ---------------------------------------------------------------------
-- SNAPSHOTS DE ANÚNCIO  <<< A TABELA MAIS IMPORTANTE DO SISTEMA
-- Toda métrica de venda nasce da diferença de sold_quantity entre
-- dois snapshots. Particionada por mês porque cresce rápido:
-- 200k anúncios x 1 coleta/dia = 6 M linhas/mês.
-- ---------------------------------------------------------------------
create table if not exists item_snapshots (
  item_id            text not null,
  captured_at        timestamptz not null default now(),
  captured_date      date not null,                 -- preenchido pelo coletor (fuso BRT)
  price              numeric(12,2),
  original_price     numeric(12,2),
  sold_quantity      bigint,
  available_quantity int,
  health             numeric(4,3),
  seller_id          bigint,
  search_position    int,                           -- posição na busca da categoria
  primary key (item_id, captured_at)
) partition by range (captured_at);

create index if not exists item_snapshots_item_idx on item_snapshots(item_id, captured_at desc);
create index if not exists item_snapshots_date_idx on item_snapshots(captured_date);

-- ---------------------------------------------------------------------
-- SNAPSHOTS DE VENDEDOR
-- ---------------------------------------------------------------------
create table if not exists seller_snapshots (
  seller_id             bigint not null,
  captured_at           timestamptz not null default now(),
  captured_date         date not null,
  reputation_level      text,                       -- 5_green, 4_light_green...
  power_seller_status   text,                       -- platinum, gold, silver
  transactions_total    bigint,
  transactions_canceled bigint,
  claims_rate           numeric(6,4),
  delayed_rate          numeric(6,4),
  items_active          int,
  primary key (seller_id, captured_at)
) partition by range (captured_at);

create index if not exists seller_snapshots_seller_idx on seller_snapshots(seller_id, captured_at desc);

-- ---------------------------------------------------------------------
-- Criação automática de partições mensais.
-- Rode ensure_partitions() uma vez agora e deixe no cron.
-- ---------------------------------------------------------------------
create or replace function ensure_partitions(months_ahead int default 3)
returns void
language plpgsql
as $$
declare
  tbl   text;
  start date := date_trunc('month', now())::date;
  i     int;
  pname text;
  lo    date;
  hi    date;
begin
  foreach tbl in array array['item_snapshots','seller_snapshots'] loop
    for i in -1..months_ahead loop
      lo := (start + make_interval(months => i))::date;
      hi := (start + make_interval(months => i + 1))::date;
      pname := tbl || '_' || to_char(lo, 'YYYY_MM');
      if not exists (select 1 from pg_class where relname = pname) then
        execute format(
          'create table %I partition of %I for values from (%L) to (%L)',
          pname, tbl, lo, hi
        );
      end if;
    end loop;
  end loop;
end;
$$;

select ensure_partitions(3);

-- ---------------------------------------------------------------------
-- CONTROLE DO COLETOR
-- Fila de trabalho + log. Sem isso você não sabe o que já coletou,
-- o que falhou, nem consegue retomar depois de um crash.
-- ---------------------------------------------------------------------
create table if not exists collect_jobs (
  id           bigserial primary key,
  job_type     text not null,          -- sync_categories | discover_items | refresh_items | sync_sellers
  target       text,                   -- id da categoria, ou lote
  payload      jsonb not null default '{}'::jsonb,
  priority     smallint not null default 0,
  status       text not null default 'pending',  -- pending | running | done | failed
  attempts     int not null default 0,
  last_error   text,
  scheduled_for timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists collect_jobs_queue_idx
  on collect_jobs(status, priority desc, scheduled_for)
  where status = 'pending';

create table if not exists collect_log (
  id          bigserial primary key,
  job_type    text not null,
  target      text,
  ok          boolean not null,
  items_seen  int default 0,
  snapshots   int default 0,
  api_calls   int default 0,
  duration_ms int,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists collect_log_created_idx on collect_log(created_at desc);

-- Pega o próximo job de forma segura com múltiplos workers.
create or replace function claim_job()
returns collect_jobs
language plpgsql
as $$
declare j collect_jobs;
begin
  update collect_jobs
     set status = 'running', started_at = now(), attempts = attempts + 1
   where id = (
     select id from collect_jobs
      where status = 'pending' and scheduled_for <= now()
      order by priority desc, scheduled_for
      for update skip locked
      limit 1
   )
  returning * into j;
  return j;
end;
$$;
