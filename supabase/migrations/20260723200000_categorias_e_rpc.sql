-- =====================================================================
-- 008_categorias_e_rpc.sql
--
-- Duas coisas:
--
-- 1) MÉTRICAS DE CATEGORIA sobre ranking. As antigas
--    (category_opportunity) foram calculadas em cima de sold_quantity e
--    morreram no pivô de 23/07. Estas usam posição e concorrência.
--
-- 2) FUNÇÕES RPC que consomem quota DENTRO do banco. Até agora a quota
--    era checada no front, e front não é confiável: bastava alguém com
--    a chave pública paginar as views por fora. Com isso resolvido, as
--    views saem do alcance direto e só as funções ficam expostas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) ROTATIVIDADE DO TOP 20
--
-- A métrica mais reveladora que o ranking permite e que ninguém publica.
--
-- Categoria onde o top 20 muda toda semana é categoria onde dá para
-- entrar. Categoria congelada há meses é território de quem já está lá.
-- Receita alta com rotatividade zero é armadilha — parece oportunidade
-- e é muro.
-- ---------------------------------------------------------------------
drop materialized view if exists category_rank_metrics cascade;
create materialized view category_rank_metrics as
with ultima_data as (
  select category_id, max(captured_date) as dia
  from product_rank_daily group by category_id
),
agora as (
  select d.category_id, d.product_id, d.position
  from product_rank_daily d
  join ultima_data u on u.category_id = d.category_id and u.dia = d.captured_date
),
antes as (
  select distinct on (d.category_id, d.product_id)
    d.category_id, d.product_id
  from product_rank_daily d
  join ultima_data u on u.category_id = d.category_id
  where d.captured_date <= u.dia - 7
  order by d.category_id, d.product_id, d.captured_date desc
),
churn as (
  select
    a.category_id,
    count(*)                                                   as no_top,
    count(*) filter (where b.product_id is null)               as entrantes,
    -- só faz sentido se houver leitura de 7 dias atrás
    (select count(*) from antes x where x.category_id = a.category_id) as base_antes
  from agora a
  left join antes b on b.category_id = a.category_id and b.product_id = a.product_id
  group by a.category_id
),
precos as (
  select
    a.category_id,
    round(percentile_cont(0.5) within group (order by k.median_price)::numeric, 2) as preco_mediano,
    round(avg(k.listings)::numeric, 1)                          as concorrentes_medio,
    round(avg(k.price_spread)::numeric, 3)                      as dispersao_media,
    round(avg(k.full_share)::numeric, 3)                        as full_medio,
    sum(k.listings)                                             as anuncios_totais,
    count(distinct k.product_id)                                as produtos_com_dados
  from agora a
  join product_competition k on k.product_id = a.product_id
  group by a.category_id
),
historico as (
  select category_id,
         count(distinct captured_date) as dias_observados,
         min(captured_date)            as primeira_leitura
  from product_rank_daily group by category_id
)
select
  c.category_id,
  cat.name                                                      as categoria,
  cat.path_names,
  c.no_top                                                      as produtos_rankeados,
  c.entrantes,
  case when c.base_antes > 0
       then round(c.entrantes::numeric / nullif(c.no_top, 0), 3) end as rotatividade_7d,
  p.preco_mediano,
  p.concorrentes_medio,
  p.dispersao_media,
  p.full_medio,
  p.anuncios_totais,
  p.produtos_com_dados,
  h.dias_observados,
  h.primeira_leitura,
  now()                                                         as computed_at
from churn c
join categories cat on cat.id = c.category_id
left join precos p    on p.category_id = c.category_id
left join historico h on h.category_id = c.category_id;

create unique index category_rank_metrics_pk on category_rank_metrics(category_id);

-- ---------------------------------------------------------------------
-- 2) LEITURA DE OPORTUNIDADE
--
-- Sem sold_quantity não dá para falar em receita. O que dá para afirmar
-- com honestidade é ESTRUTURA de mercado:
--
--   rotatividade alta  -> dá para entrar
--   poucos concorrentes por produto -> menos briga
--   dispersão de preço alta -> mercado desorganizado, espaço para
--                              posicionamento
--
-- Normalizado por percentil, como antes. Quem tem menos de 7 dias de
-- histórico não recebe nota — recebe "coletando".
-- ---------------------------------------------------------------------
create or replace view category_opportunity_rank as
with r as (
  select
    m.*,
    percent_rank() over (order by coalesce(m.rotatividade_7d, 0))          as p_rotatividade,
    percent_rank() over (order by coalesce(m.concorrentes_medio, 999) desc) as p_espaco,
    percent_rank() over (order by coalesce(m.dispersao_media, 0))          as p_dispersao,
    percent_rank() over (order by coalesce(m.anuncios_totais, 0))          as p_tamanho
  from category_rank_metrics m
)
select
  category_id,
  categoria,
  path_names,
  produtos_rankeados,
  entrantes,
  rotatividade_7d,
  preco_mediano,
  concorrentes_medio,
  dispersao_media,
  full_medio,
  anuncios_totais,
  dias_observados,
  case when dias_observados >= 7
       then round((0.35 * p_rotatividade + 0.25 * p_espaco
                 + 0.20 * p_dispersao + 0.20 * p_tamanho)::numeric, 3) end as score,
  case
    when dias_observados < 7 then 'coletando'
    when (0.35 * p_rotatividade + 0.25 * p_espaco
        + 0.20 * p_dispersao + 0.20 * p_tamanho) >= 0.70 then 'alta'
    when (0.35 * p_rotatividade + 0.25 * p_espaco
        + 0.20 * p_dispersao + 0.20 * p_tamanho) >= 0.40 then 'media'
    else 'baixa'
  end as oportunidade,
  computed_at
from r;

-- ---------------------------------------------------------------------
-- 3) RPC COM QUOTA NO SERVIDOR
--
-- Cada função consome quota ANTES de devolver linha. Se a quota
-- acabou, levanta exceção com SQLSTATE próprio para o front distinguir
-- "acabou" de "deu erro".
--
-- security definer para poder ler as views mesmo depois de revogarmos
-- o select direto do papel authenticated.
-- ---------------------------------------------------------------------
create or replace function buscar_produtos(
  p_categoria     text default null,
  p_texto         text default null,
  p_preco_min     numeric default null,
  p_preco_max     numeric default null,
  p_momentum      text default null,
  p_max_pos       int default null,
  p_limite        int default 50,
  p_offset        int default 0
)
returns setof product_search_view
language plpgsql
security definer set search_path = public
as $$
declare q jsonb;
begin
  q := consume_quota('product_search');
  if not (q ->> 'allowed')::boolean then
    raise exception 'quota esgotada' using errcode = 'P0001',
      detail = q::text;
  end if;

  return query
    select * from product_search_view v
     where (p_categoria is null or v.category_id = p_categoria)
       and (p_texto     is null or v.name ilike '%' || p_texto || '%')
       and (p_preco_min is null or v.median_price >= p_preco_min)
       and (p_preco_max is null or v.median_price <= p_preco_max)
       and (p_momentum  is null or v.momentum = p_momentum)
       and (p_max_pos   is null or v.position_now <= p_max_pos)
       and v.position_now is not null
     order by v.position_now nulls last, v.listings desc nulls last
     limit least(p_limite, 200) offset p_offset;
end;
$$;

create or replace function listar_categorias(
  p_texto  text default null,
  p_limite int default 50
)
returns setof category_opportunity_rank
language plpgsql
security definer set search_path = public
as $$
declare q jsonb;
begin
  q := consume_quota('category_view');
  if not (q ->> 'allowed')::boolean then
    raise exception 'quota esgotada' using errcode = 'P0001', detail = q::text;
  end if;

  return query
    select * from category_opportunity_rank c
     where (p_texto is null or c.categoria ilike '%' || p_texto || '%')
       and c.produtos_rankeados > 0
     order by c.score desc nulls last
     limit least(p_limite, 200);
end;
$$;

/**
 * Histórico de posição de um produto. Não consome quota: quem já gastou
 * uma busca para achar o produto não deve pagar de novo para abrir.
 */
create or replace function historico_produto(p_produto text)
returns table (dia date, posicao int)
language sql
security definer set search_path = public
as $$
  select captured_date, position
    from product_rank_daily
   where product_id = p_produto
   order by captured_date
$$;

/** Concorrentes de um produto, com preço de cada um. */
create or replace function concorrentes_produto(p_produto text)
returns table (
  item_id text, seller_id bigint, nickname text, estado text,
  preco numeric, full boolean, oficial boolean, frete_gratis boolean
)
language sql
security definer set search_path = public
as $$
  select distinct on (i.id)
    i.id, i.seller_id, s.nickname, s.state,
    sn.price,
    i.shipping_logistic_type = 'fulfillment',
    i.official_store_id is not null,
    i.shipping_free
  from items i
  join item_snapshots sn on sn.item_id = i.id
  left join sellers s on s.id = i.seller_id
  where i.catalog_product_id = p_produto and i.status = 'active'
  order by i.id, sn.captured_at desc
$$;

-- ---------------------------------------------------------------------
-- 4) Fechar a porta que estava aberta.
--
-- O front passa a chamar só as funções. As views saem do alcance
-- direto, então não dá mais para paginar a base inteira por fora
-- gastando zero de quota.
-- ---------------------------------------------------------------------
revoke select on product_search_view       from authenticated;
revoke select on product_rank_metrics      from authenticated;
revoke select on product_competition       from authenticated;
revoke select on product_momentum          from authenticated;

grant execute on function buscar_produtos(text,text,numeric,numeric,text,int,int,int) to authenticated;
grant execute on function listar_categorias(text,int)      to authenticated;
grant execute on function historico_produto(text)          to authenticated;
grant execute on function concorrentes_produto(text)       to authenticated;

revoke all on function refresh_rank_metrics(boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) Refresh inclui as métricas de categoria.
-- ---------------------------------------------------------------------
create or replace function refresh_rank_metrics(concurrent boolean default true)
returns void
language plpgsql
as $$
begin
  if concurrent then
    refresh materialized view concurrently product_rank_metrics;
    refresh materialized view concurrently product_competition;
    refresh materialized view concurrently category_rank_metrics;
  else
    refresh materialized view product_rank_metrics;
    refresh materialized view product_competition;
    refresh materialized view category_rank_metrics;
  end if;
end;
$$;

revoke all on function refresh_rank_metrics(boolean) from public, anon, authenticated;
