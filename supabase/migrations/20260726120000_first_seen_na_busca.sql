-- "Tempo de anuncio no ar" pedido pelo usuario. ML nao publica data de
-- criacao (ja documentado, extensao tenta e fica vazio quase sempre).
-- Unico dado real que temos: ha quanto tempo NOS monitoramos o produto
-- (catalog_products.first_seen_at). Honesto, nao "no ar" de verdade.
-- Coluna no fim -- create or replace view so aceita assim.
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
  p.tipo,
  p.first_seen_at
from catalog_products p
left join categories        c on c.id = p.category_id
left join product_momentum  m on m.product_id = p.id
left join product_competition k on k.product_id = p.id
where p.status = 'active';
