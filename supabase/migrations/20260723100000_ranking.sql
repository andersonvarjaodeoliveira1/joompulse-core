-- =====================================================================
-- 006_ranking.sql — o pivô
--
-- POR QUE ESTA MIGRATION EXISTE
--
-- O plano original media venda pela diferença de sold_quantity entre
-- dois dias. Em 23/07/2026 o diagnóstico provou que a API oficial
-- devolve 403 access_denied para qualquer anúncio de terceiro: o campo
-- é inalcançável, não ausente.
--
-- O que sobrou, e funciona:
--   /highlights/MLB/category/{cat}  -> top 20 produtos, COM a posição
--   /products/{id}/items            -> todos os anúncios que disputam
--                                      aquele produto, com preço
--
-- Então o sinal de demanda passa a ser ORDINAL em vez de CARDINAL.
-- Não sabemos quantas unidades saíram; sabemos que o produto está em
-- 3º hoje e estava em 11º semana passada. Para quem decide o que
-- importar, isso responde a mesma pergunta — e não exige inventar
-- número nenhum.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PRODUTOS DE CATÁLOGO
-- O Mercado Livre agrupa anúncios iguais sob um produto. É esse
-- agrupamento que os destaques devolvem, e é a unidade certa para
-- análise de concorrência: um produto, N vendedores disputando.
-- ---------------------------------------------------------------------
create table if not exists catalog_products (
  id             text primary key,          -- MLB54987753
  site_id        text not null default 'MLB',
  name           text,
  category_id    text references categories(id),
  brand          text,
  model          text,
  picture        text,
  permalink      text,
  status         text default 'active',
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  last_synced_at timestamptz
);
create index if not exists catalog_products_cat_idx  on catalog_products(category_id);
create index if not exists catalog_products_name_trgm on catalog_products using gin(name gin_trgm_ops);

-- Liga anúncio ao produto que ele disputa.
create index if not exists items_catalog_idx on items(catalog_product_id)
  where catalog_product_id is not null;

-- ---------------------------------------------------------------------
-- SNAPSHOTS DE POSIÇÃO  <<< A NOVA TABELA CENTRAL
--
-- Substitui item_snapshots.sold_quantity como fonte de sinal de demanda.
-- Uma linha por produto por coleta, guardando onde ele estava no
-- ranking daquela categoria.
--
-- Detalhe que importa: os destaques só mostram o top 20. Um produto que
-- sai do top 20 não vira "posição 21" — vira ausência. Por isso
-- registramos também as datas em que a categoria FOI coletada
-- (collect_log), para distinguir "caiu do ranking" de "não coletamos".
-- ---------------------------------------------------------------------
create table if not exists product_rank_snapshots (
  product_id    text not null,
  category_id   text not null,
  captured_at   timestamptz not null default now(),
  captured_date date not null,
  position      int not null,
  primary key (product_id, category_id, captured_at)
) partition by range (captured_at);

create index if not exists prs_prod_idx on product_rank_snapshots(product_id, captured_at desc);
create index if not exists prs_cat_idx  on product_rank_snapshots(category_id, captured_date);
create index if not exists prs_date_idx on product_rank_snapshots(captured_date);

-- ---------------------------------------------------------------------
-- CALIBRAÇÃO — o que transforma posição em estimativa de unidades
--
-- Cada linha é um par verdadeiro: "este anúncio, nesta posição, vendeu
-- tantas unidades neste período". Vem de contas conectadas, onde
-- /users/{id}/items/search devolve o sold_quantity REAL do dono.
--
-- Sem linhas aqui, a curva rank->unidades é chute teórico. Com algumas
-- dezenas espalhadas por categoria, vira ajuste com dado observado.
--
-- Cada usuário que conecta a conta melhora a estimativa vendida a todos
-- os outros. É a razão comercial de ter plano gratuito generoso.
-- ---------------------------------------------------------------------
create table if not exists calibration_points (
  id            bigserial primary key,
  item_id       text,
  product_id    text,
  category_id   text references categories(id),
  seller_id     bigint,
  observed_on   date not null,
  position      int,                 -- null = estava fora do top 20
  units_sold    int not null,        -- REAL, não estimado
  period_days   int not null,        -- em quantos dias
  price         numeric(12,2),
  source        text not null default 'own_account',  -- own_account | partner
  created_at    timestamptz not null default now()
);
create index if not exists calib_cat_idx on calibration_points(category_id, position);
create index if not exists calib_item_idx on calibration_points(item_id, observed_on);

comment on table calibration_points is
  'Pares reais (posição, unidades) vindos de contas conectadas. Alimenta a curva de estimativa.';

-- ---------------------------------------------------------------------
-- Partições para a tabela nova.
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
  foreach tbl in array array['item_snapshots','seller_snapshots','product_rank_snapshots'] loop
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
-- Segurança: mesma regra das outras tabelas de mercado.
-- ---------------------------------------------------------------------
alter table catalog_products        enable row level security;
alter table product_rank_snapshots  enable row level security;
alter table calibration_points      enable row level security;

drop policy if exists read_authenticated on catalog_products;
create policy read_authenticated on catalog_products for select to authenticated using (true);

grant select on catalog_products to authenticated;

-- Snapshots de posição e calibração são matéria-prima: o front lê as
-- views agregadas, nunca a tabela crua.
revoke all on product_rank_snapshots from anon, authenticated;
revoke all on calibration_points     from anon, authenticated;
