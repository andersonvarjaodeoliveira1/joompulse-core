-- =====================================================================
-- 007_rank_metrics.sql — o que o ranking permite afirmar
--
-- Regra que guiou este arquivo: separar o que é MEDIDO do que é
-- ESTIMADO, e nunca misturar os dois na mesma coluna.
--
-- Medido (não precisa de calibração nenhuma):
--   posição, movimento, persistência, nº de concorrentes, preços
--
-- Estimado (precisa de calibration_points):
--   unidades por mês — fica em view separada, com faixa e confiança
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Uma posição por produto por dia.
-- ---------------------------------------------------------------------
create or replace view product_rank_daily as
select distinct on (product_id, category_id, captured_date)
  product_id, category_id, captured_date, position
from product_rank_snapshots
order by product_id, category_id, captured_date, captured_at desc;

-- ---------------------------------------------------------------------
-- 2) MÉTRICAS DE RANKING — tudo medido.
--
-- position_delta_7d: positivo significa que SUBIU (número menor é
-- melhor no ranking, então invertemos o sinal para a leitura ficar
-- intuitiva na tela).
--
-- days_in_top10 sobre days_observed é o sinal mais subestimado aqui:
-- separa produto consolidado de viralizada de uma semana.
-- ---------------------------------------------------------------------
drop materialized view if exists product_rank_metrics cascade;
create materialized view product_rank_metrics as
with base as (
  select
    product_id,
    category_id,
    captured_date,
    position,
    row_number() over (partition by product_id, category_id order by captured_date desc) as recencia
  from product_rank_daily
  where captured_date > current_date - 90
)
select
  product_id,
  category_id,
  max(position) filter (where recencia = 1)                                as position_now,
  max(captured_date)                                                       as last_ranked_date,
  min(position)                                                            as best_position,
  round(avg(position), 1)                                                  as avg_position,
  count(*)                                                                 as days_observed,
  count(*) filter (where position <= 3)                                    as days_in_top3,
  count(*) filter (where position <= 10)                                   as days_in_top10,
  min(captured_date)                                                       as first_ranked_date,
  -- posição há 7 e 30 dias, para medir movimento
  (array_agg(position order by captured_date desc)
     filter (where captured_date <= current_date - 7))[1]                  as position_7d_ago,
  (array_agg(position order by captured_date desc)
     filter (where captured_date <= current_date - 30))[1]                 as position_30d_ago
from base
group by product_id, category_id;

create unique index product_rank_metrics_pk on product_rank_metrics(product_id, category_id);
create index product_rank_metrics_pos_idx on product_rank_metrics(category_id, position_now);

-- ---------------------------------------------------------------------
-- 3) Leitura humana do movimento.
-- ---------------------------------------------------------------------
create or replace view product_momentum as
select
  m.*,
  -- sinal invertido: subir no ranking = número menor = delta positivo
  case when m.position_7d_ago  is not null then m.position_7d_ago  - m.position_now end as delta_7d,
  case when m.position_30d_ago is not null then m.position_30d_ago - m.position_now end as delta_30d,
  case
    when m.days_observed < 5                                     then 'novo'
    when m.position_7d_ago is null                               then 'sem_historico'
    when m.position_7d_ago - m.position_now >=  3                then 'subindo'
    when m.position_7d_ago - m.position_now <= -3                then 'caindo'
    else 'estavel'
  end as momentum,
  case
    when m.days_observed < 14                                    then 'insuficiente'
    when m.days_in_top10::numeric / m.days_observed >= 0.80      then 'consolidado'
    when m.days_in_top10::numeric / m.days_observed >= 0.40      then 'recorrente'
    else 'passageiro'
  end as consistencia,
  round(m.days_in_top10::numeric / nullif(m.days_observed, 0), 3) as top10_rate
from product_rank_metrics m;

-- ---------------------------------------------------------------------
-- 4) CONCORRÊNCIA — quem disputa cada produto e por quanto.
--
-- Esta é a peça que o /products/{id}/items entrega de graça e que o
-- endpoint bloqueado nunca daria tão limpa: todos os vendedores do
-- mesmo produto, lado a lado.
-- ---------------------------------------------------------------------
drop materialized view if exists product_competition cascade;
create materialized view product_competition as
with ultimo as (
  select distinct on (i.id)
    i.id                        as item_id,
    i.catalog_product_id        as product_id,
    i.seller_id,
    i.shipping_logistic_type,
    i.official_store_id,
    i.shipping_free,
    s.price
  from items i
  join item_snapshots s on s.item_id = i.id
  where i.catalog_product_id is not null
    and i.status = 'active'
    and s.price is not null
  order by i.id, s.captured_at desc
)
select
  product_id,
  count(*)                                                          as listings,
  count(distinct seller_id)                                         as sellers,
  min(price)                                                        as min_price,
  max(price)                                                        as max_price,
  round(percentile_cont(0.5) within group (order by price)::numeric, 2) as median_price,
  round(avg(price)::numeric, 2)                                     as avg_price,
  -- dispersão relativa: mercado apertado vs bagunçado
  case when avg(price) > 0
       then round(((max(price) - min(price)) / avg(price))::numeric, 3) end as price_spread,
  round(count(*) filter (where shipping_logistic_type = 'fulfillment')::numeric
        / nullif(count(*), 0), 3)                                   as full_share,
  round(count(*) filter (where official_store_id is not null)::numeric
        / nullif(count(*), 0), 3)                                   as official_share,
  round(count(*) filter (where shipping_free)::numeric
        / nullif(count(*), 0), 3)                                   as free_shipping_share,
  now()                                                             as computed_at
from ultimo
group by product_id;

create unique index product_competition_pk on product_competition(product_id);

-- ---------------------------------------------------------------------
-- 5) A VIEW QUE A TELA LÊ — só fato medido, nada estimado.
-- ---------------------------------------------------------------------
create or replace view product_search_view as
select
  p.id                    as product_id,
  p.name,
  p.picture,
  p.permalink,
  p.brand,
  p.category_id,
  c.name                  as category_name,
  c.path_names            as category_path,
  m.position_now,
  m.best_position,
  m.avg_position,
  m.days_observed,
  m.days_in_top10,
  m.top10_rate,
  m.delta_7d,
  m.delta_30d,
  m.momentum,
  m.consistencia,
  m.first_ranked_date,
  m.last_ranked_date,
  k.listings,
  k.sellers,
  k.min_price,
  k.max_price,
  k.median_price,
  k.price_spread,
  k.full_share,
  k.official_share
from catalog_products p
left join categories        c on c.id = p.category_id
left join product_momentum  m on m.product_id = p.id
left join product_competition k on k.product_id = p.id
where p.status = 'active';

-- ---------------------------------------------------------------------
-- 6) ESTIMATIVA DE UNIDADES — separada de propósito.
--
-- A curva é uma lei de potência:  unidades = A * posicao^(-alfa)
--
-- alfa vem do formato da curva, que é parecido entre categorias.
-- A é a ESCALA, e muda em ordens de grandeza: 3º lugar em Celulares
-- não é 3º lugar em Kefir.
--
-- A só sai de calibration_points. Sem eles esta view devolve null em
-- vez de inventar número — e é assim que tem que ser. Estimativa com
-- cara de precisão é pior que nenhuma estimativa.
-- ---------------------------------------------------------------------
create or replace view category_calibration as
select
  category_id,
  count(*)                                        as pontos,
  -- ajuste log-log: log(unidades) = log(A) - alfa * log(posicao)
  -- com poucos pontos usamos alfa fixo (0.9, típico de e-commerce)
  -- e derivamos A da média geométrica dos pontos observados.
  0.9::numeric                                    as alfa,
  round(exp(avg(ln(nullif(units_sold, 0)::numeric)
        + 0.9 * ln(nullif(position, 0)::numeric)))::numeric, 2) as escala_a,
  case
    when count(*) >= 30 then 'alta'
    when count(*) >= 10 then 'media'
    when count(*) >= 3  then 'baixa'
    else 'insuficiente'
  end                                             as confianca
from calibration_points
where position is not null and position > 0 and units_sold > 0
group by category_id;

create or replace view product_units_estimate as
select
  m.product_id,
  m.category_id,
  m.position_now,
  cal.pontos                                      as calibration_points,
  cal.confianca,
  case when cal.escala_a is not null and m.position_now > 0
       then round(cal.escala_a * power(m.position_now, -cal.alfa)) end     as units_mid,
  -- faixa: metade e dobro do central. Larga de propósito enquanto a
  -- confiança é baixa. Estreita conforme a calibração cresce.
  case when cal.escala_a is not null and m.position_now > 0
       then round(cal.escala_a * power(m.position_now, -cal.alfa)
                  * case cal.confianca when 'alta' then 0.75
                                       when 'media' then 0.5
                                       else 0.33 end) end                  as units_low,
  case when cal.escala_a is not null and m.position_now > 0
       then round(cal.escala_a * power(m.position_now, -cal.alfa)
                  * case cal.confianca when 'alta' then 1.35
                                       when 'media' then 2.0
                                       else 3.0 end) end                   as units_high
from product_rank_metrics m
left join category_calibration cal on cal.category_id = m.category_id;

comment on view product_units_estimate is
  'ESTIMATIVA, não medição. Devolve null onde não há calibração. Nunca exibir como número exato — sempre faixa.';

-- ---------------------------------------------------------------------
-- 7) Refresh.
-- ---------------------------------------------------------------------
create or replace function refresh_rank_metrics(concurrent boolean default true)
returns void
language plpgsql
as $$
begin
  if concurrent then
    refresh materialized view concurrently product_rank_metrics;
    refresh materialized view concurrently product_competition;
  else
    refresh materialized view product_rank_metrics;
    refresh materialized view product_competition;
  end if;
end;
$$;

grant select on product_search_view    to authenticated;
grant select on product_momentum       to authenticated;
grant select on product_rank_metrics   to authenticated;
grant select on product_competition    to authenticated;
grant select on product_units_estimate to authenticated;
grant select on category_calibration   to authenticated;
revoke all on function refresh_rank_metrics(boolean) from public, anon, authenticated;
