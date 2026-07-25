-- =====================================================================
-- 080_tipo_na_busca.sql
--
-- product_search_view nao expunha catalog_products.tipo. Sem isso o
-- front nao tem como distinguir "ainda nao sincronizado" (PRODUCT/ITEM,
-- resolve sozinho quando sincronizarProdutos/sincronizarItens rodar) de
-- "nunca vai ter nome nem foto" (USER_PRODUCT -- variacao de vendedor,
-- a API do ML nao expoe ficha pra isso, so o /highlights devolve o id).
--
-- Mostrar os dois casos com o mesmo codigo cru MLBU... passava a
-- impressao de bug quando na verdade e limite de plataforma -- o mesmo
-- principio que ja levou a etiqueta "Fora do alcance da coleta" em
-- collect_requests.
--
-- So acrescenta p.tipo (no fim da lista -- create or replace view so
-- aceita coluna nova como ultima posicao, tentar inserir no meio troca
-- nome de coluna existente e o Postgres recusa). Resto copiado
-- exatamente de 20260723100100_rank_metrics.sql para nao perder o
-- "where status = active" nem trocar join por engano.
-- =====================================================================
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
  k.official_share,
  p.tipo
from catalog_products p
left join categories        c on c.id = p.category_id
left join product_momentum  m on m.product_id = p.id
left join product_competition k on k.product_id = p.id
where p.status = 'active';
