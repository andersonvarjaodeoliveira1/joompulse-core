-- =====================================================================
-- 002_metrics.sql — onde o dado bruto vira produto
--
-- Toda a inteligência do software está aqui. As telas do Lovable são
-- só SELECT nestas views.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Um ponto por anúncio por dia (o último snapshot do dia).
-- ---------------------------------------------------------------------
create or replace view item_daily as
select distinct on (item_id, captured_date)
  item_id,
  captured_date,
  captured_at,
  price,
  sold_quantity,
  available_quantity,
  seller_id,
  search_position
from item_snapshots
order by item_id, captured_date, captured_at desc;

-- ---------------------------------------------------------------------
-- 2) VENDAS ESTIMADAS — o cálculo central.
--
-- units_sold = sold_quantity(hoje) - sold_quantity(dia anterior).
--
-- Dois cuidados que quase todo mundo erra:
--   a) sold_quantity pode CAIR (anúncio republicado zera o contador).
--      Nesse caso a diferença não é venda negativa, é reset -> 0.
--   b) Se você ficou 5 dias sem coletar, a diferença inteira cai em um
--      único dia. gap_days registra isso para você poder diluir ou
--      descartar o ponto na hora de fazer gráfico.
-- ---------------------------------------------------------------------
drop materialized view if exists item_daily_sales cascade;
create materialized view item_daily_sales as
select
  item_id,
  captured_date,
  price,
  sold_quantity,
  case
    when lag(sold_quantity) over w is null                 then null   -- primeiro ponto
    when sold_quantity < lag(sold_quantity) over w         then 0      -- republicado
    else sold_quantity - lag(sold_quantity) over w
  end as units_sold,
  (captured_date - lag(captured_date) over w) as gap_days
from item_daily
window w as (partition by item_id order by captured_date);

create unique index item_daily_sales_pk on item_daily_sales(item_id, captured_date);
create index item_daily_sales_date_idx   on item_daily_sales(captured_date);

-- ---------------------------------------------------------------------
-- 3) Métricas por anúncio: 30 dias, 30 anteriores e tendência.
--
-- Receita usa o preço DAQUELE dia, não a média do período.
-- Se o vendedor deu 40% de desconto numa semana, isso aparece.
-- ---------------------------------------------------------------------
drop materialized view if exists item_metrics cascade;
create materialized view item_metrics as
select
  item_id,
  coalesce(sum(units_sold) filter (where captured_date > current_date - 30), 0)              as units_30d,
  coalesce(sum(units_sold * price) filter (where captured_date > current_date - 30), 0)      as revenue_30d,
  coalesce(sum(units_sold) filter (where captured_date > current_date - 60
                                     and captured_date <= current_date - 30), 0)             as units_prev_30d,
  coalesce(sum(units_sold) filter (where captured_date > current_date - 7), 0)               as units_7d,
  avg(price) filter (where captured_date > current_date - 30)                                as avg_price_30d,
  min(price) filter (where captured_date > current_date - 90)                                as min_price_90d,
  max(price) filter (where captured_date > current_date - 90)                                as max_price_90d,
  count(*) filter (where captured_date > current_date - 30 and units_sold > 0)               as days_with_sales_30d,
  count(*) filter (where captured_date > current_date - 30)                                  as days_observed_30d,
  max(captured_date)                                                                          as last_captured_date
from item_daily_sales
where captured_date > current_date - 90
  and units_sold is not null
group by item_id;

create unique index item_metrics_pk on item_metrics(item_id);
create index item_metrics_revenue_idx on item_metrics(revenue_30d desc);

-- Tendência: crescimento dos últimos 30d contra os 30d anteriores.
-- Menos de 20 dias de observação = 'insuficiente'. Não invente número
-- para quem acabou de entrar no seu banco.
create or replace view item_trend as
select
  m.item_id,
  m.units_30d,
  m.units_prev_30d,
  case
    when m.days_observed_30d < 20 then null
    when m.units_prev_30d = 0 and m.units_30d = 0 then 0
    when m.units_prev_30d = 0 then 1.0
    else round((m.units_30d - m.units_prev_30d)::numeric / m.units_prev_30d, 4)
  end as growth_ratio,
  case
    when m.days_observed_30d < 20 then 'insuficiente'
    when m.units_prev_30d = 0 and m.units_30d = 0 then 'sem_vendas'
    when m.units_prev_30d = 0 then 'crescente'
    when (m.units_30d - m.units_prev_30d)::numeric / m.units_prev_30d >  0.15 then 'crescente'
    when (m.units_30d - m.units_prev_30d)::numeric / m.units_prev_30d < -0.15 then 'queda'
    else 'estavel'
  end as trend
from item_metrics m;

-- ---------------------------------------------------------------------
-- 4) Visão gorda de anúncio — é o que a tela "Busca de produtos" lê.
-- ---------------------------------------------------------------------
create or replace view item_search_view as
select
  i.id,
  i.title,
  i.thumbnail,
  i.permalink,
  i.brand,
  i.condition,
  i.shipping_free,
  i.shipping_logistic_type = 'fulfillment' as is_full,
  i.is_catalog_listing,
  i.official_store_id is not null          as is_official_store,
  i.category_id,
  c.name                                   as category_name,
  c.path_names                             as category_path,
  i.seller_id,
  s.nickname                               as seller_nickname,
  s.state                                  as seller_state,
  s.registration_date                      as seller_since,
  m.units_30d,
  m.revenue_30d,
  m.avg_price_30d,
  m.min_price_90d,
  m.max_price_90d,
  m.days_with_sales_30d,
  t.growth_ratio,
  t.trend,
  i.ml_date_created,
  i.last_seen_at
from items i
left join categories c on c.id = i.category_id
left join sellers    s on s.id = i.seller_id
left join item_metrics m on m.item_id = i.id
left join item_trend   t on t.item_id = i.id
where i.status = 'active';

-- ---------------------------------------------------------------------
-- 5) MÉTRICAS DE CATEGORIA
--
-- Aqui moram os dois números que o JoomPulse vende como diferencial:
--
--   monopolizacao  = fatia de receita do maior vendedor da categoria.
--                    Alta = um player domina, não entre.
--   hhi            = índice Herfindahl-Hirschman (soma dos quadrados das
--                    fatias). 0 = pulverizado, 1 = monopólio puro.
--                    É a métrica honesta; a monopolização é a legível.
-- ---------------------------------------------------------------------
drop materialized view if exists category_metrics cascade;
create materialized view category_metrics as
with per_item as (
  select i.category_id, i.seller_id, m.units_30d, m.revenue_30d, m.avg_price_30d
  from items i
  join item_metrics m on m.item_id = i.id
  where i.category_id is not null and i.status = 'active'
),
per_seller as (
  select category_id, seller_id, sum(revenue_30d) as seller_revenue
  from per_item
  group by 1, 2
),
totals as (
  select
    category_id,
    sum(seller_revenue)                     as total_revenue,
    count(distinct seller_id)               as seller_count,
    max(seller_revenue)                     as top_seller_revenue,
    sum(power(seller_revenue, 2))           as sum_sq
  from per_seller
  group by 1
),
item_side as (
  select
    category_id,
    sum(units_30d)                          as total_units,
    count(*)                                as item_count,
    percentile_cont(0.5) within group (order by avg_price_30d) as median_price,
    count(*) filter (where units_30d > 0)   as items_with_sales
  from per_item
  group by 1
)
select
  t.category_id,
  t.total_revenue,
  i.total_units,
  t.seller_count,
  i.item_count,
  i.items_with_sales,
  i.median_price,
  case when t.total_revenue > 0
       then round(t.top_seller_revenue / t.total_revenue, 4) end            as top_seller_share,
  case when t.total_revenue > 0
       then round(t.sum_sq / power(t.total_revenue, 2), 4) end              as hhi,
  case when i.item_count > 0
       then round(i.items_with_sales::numeric / i.item_count, 4) end        as sell_through_rate,
  case when t.seller_count > 0
       then round(t.total_revenue / t.seller_count, 2) end                  as revenue_per_seller,
  now() as computed_at
from totals t
join item_side i using (category_id);

create unique index category_metrics_pk on category_metrics(category_id);

-- ---------------------------------------------------------------------
-- 6) SCORE DE OPORTUNIDADE
--
-- Não existe fórmula "certa" — existe fórmula defensável. Esta pondera
-- quatro sinais, cada um normalizado por percentil DENTRO DO MESMO NÍVEL
-- da árvore (comparar "Celulares" com "Kefir" em valor absoluto não diz
-- nada; comparar por posição relativa diz).
--
--   +35%  demanda        (receita)
--   +25%  crescimento    (vendas 30d vs 30d anteriores da categoria)
--   +25%  espaço livre   (1 - concentração)
--   +15%  liquidez       (% de anúncios que efetivamente vendem)
--
-- Mexa nos pesos. É o parâmetro mais importante do seu produto e é
-- exatamente onde dá pra ficar melhor que o concorrente.
-- ---------------------------------------------------------------------
create or replace view category_opportunity as
with growth as (
  select i.category_id,
         sum(m.units_30d)      as u30,
         sum(m.units_prev_30d) as u60
  from items i join item_metrics m on m.item_id = i.id
  where i.category_id is not null
  group by 1
),
base as (
  select
    cm.*,
    c.name, c.level, c.parent_id, c.root_id, c.path_names,
    case when g.u60 > 0 then (g.u30 - g.u60)::numeric / g.u60
         when g.u30 > 0 then 1.0 else 0 end as growth_ratio
  from category_metrics cm
  join categories c on c.id = cm.category_id
  left join growth g on g.category_id = cm.category_id
),
ranked as (
  select
    b.*,
    percent_rank() over (partition by b.level order by b.total_revenue)              as p_revenue,
    percent_rank() over (partition by b.level order by b.growth_ratio)               as p_growth,
    percent_rank() over (partition by b.level order by coalesce(b.hhi, 1) desc)      as p_free,
    percent_rank() over (partition by b.level order by coalesce(b.sell_through_rate, 0)) as p_liquidity
  from base b
)
select
  category_id,
  name,
  path_names,
  level,
  parent_id,
  total_revenue,
  total_units,
  seller_count,
  item_count,
  median_price,
  top_seller_share,
  hhi,
  sell_through_rate,
  round(growth_ratio, 4) as growth_ratio,
  round((0.35 * p_revenue + 0.25 * p_growth + 0.25 * p_free + 0.15 * p_liquidity)::numeric, 4)
    as opportunity_score,
  case
    when (0.35 * p_revenue + 0.25 * p_growth + 0.25 * p_free + 0.15 * p_liquidity) >= 0.70 then 'alta'
    when (0.35 * p_revenue + 0.25 * p_growth + 0.25 * p_free + 0.15 * p_liquidity) >= 0.40 then 'media'
    else 'baixa'
  end as opportunity_label,
  computed_at
from ranked;

-- ---------------------------------------------------------------------
-- 7) SAZONALIDADE — mês de pico por categoria.
-- Só devolve resultado com 12+ meses de histórico. Antes disso a coluna
-- mostra "sem período de pico", igual ao concorrente faz.
-- ---------------------------------------------------------------------
create or replace view category_seasonality as
with monthly as (
  select
    i.category_id,
    date_trunc('month', s.captured_date)::date as month,
    sum(s.units_sold) as units
  from item_daily_sales s
  join items i on i.id = s.item_id
  where s.units_sold is not null and i.category_id is not null
  group by 1, 2
),
agg as (
  select
    category_id,
    count(distinct month)                                as months_observed,
    avg(units)                                           as avg_units,
    max(units)                                           as peak_units,
    (array_agg(extract(month from month) order by units desc))[1] as peak_month
  from monthly
  group by 1
)
select
  category_id,
  months_observed,
  peak_month,
  case
    when months_observed < 12 then null
    when avg_units > 0 then round((peak_units / avg_units)::numeric, 2)
  end as peak_index,
  case
    when months_observed < 12                              then 'sem_periodo_de_pico'
    when avg_units > 0 and peak_units / avg_units >= 1.8   then 'alta'
    when avg_units > 0 and peak_units / avg_units >= 1.3   then 'media'
    else 'baixa'
  end as seasonality_label
from agg;

-- ---------------------------------------------------------------------
-- 8) Refresh. Chame depois de cada rodada de coleta.
-- ---------------------------------------------------------------------
create or replace function refresh_metrics(concurrent boolean default true)
returns void
language plpgsql
as $$
begin
  if concurrent then
    refresh materialized view concurrently item_daily_sales;
    refresh materialized view concurrently item_metrics;
    refresh materialized view concurrently category_metrics;
  else
    refresh materialized view item_daily_sales;
    refresh materialized view item_metrics;
    refresh materialized view category_metrics;
  end if;
end;
$$;

-- Na primeira execução as matviews estão vazias: use concurrent = false.
-- select refresh_metrics(false);
