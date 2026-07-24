-- =====================================================================
-- 017_tipos_destaque.sql — CORREÇÃO URGENTE
--
-- Em 24/07/2026 o endpoint /highlights mudou o formato da resposta.
-- Até 23/07 devolvia:
--     {"id":"MLB54987753","type":"PRODUCT"}
-- A partir de 24/07 devolve:
--     {"id":"MLB4231771535","type":"ITEM"}
--     {"id":"MLBU3668109961","type":"USER_PRODUCT"}
--
-- O coletor filtrava só PRODUCT e descartava o resto. Resultado: 404
-- categorias devolveram 20 destaques cada e ZERO foi gravado — uma
-- varredura inteira perdida por um filtro estreito demais.
--
-- A lição embutida aqui: quando a fonte externa muda de formato, o
-- código não deve descartar em silêncio o que não reconhece. Melhor
-- guardar com um rótulo de "tipo desconhecido" e investigar depois do
-- que perder o dia de coleta.
--
-- O ranking continua válido para os três tipos: estar em 3º lugar numa
-- categoria significa a mesma coisa, seja o item um anúncio, um produto
-- de catálogo ou um agrupamento de variações.
-- =====================================================================

alter table catalog_products
  add column if not exists tipo text not null default 'PRODUCT';

comment on column catalog_products.tipo is
  'PRODUCT = produto de catálogo (tem /products/{id}/items) · ITEM = anúncio · USER_PRODUCT = variações de um vendedor';

create index if not exists catalog_products_tipo_idx on catalog_products(tipo);

alter table product_rank_snapshots
  add column if not exists tipo text not null default 'PRODUCT';

-- Só produtos de catálogo aceitam /products/{id}/items. Os outros dois
-- tipos entram no ranking, mas não têm lista de concorrentes — e a fila
-- de sincronização precisa saber disso para não gastar chamada à toa.
create or replace function marcar_tipo_produto(p_id text, p_tipo text)
returns void
language sql
as $$
  update catalog_products set tipo = p_tipo where id = p_id and tipo is distinct from p_tipo
$$;

-- ---------------------------------------------------------------------
-- Panorama por tipo, para acompanhar a mudança do Mercado Livre.
-- ---------------------------------------------------------------------
create or replace view destaques_por_tipo as
select
  s.captured_date                            as dia,
  s.tipo,
  count(*)                                   as posicoes,
  count(distinct s.product_id)               as entidades,
  count(distinct s.category_id)              as categorias
from product_rank_snapshots s
group by s.captured_date, s.tipo
order by s.captured_date desc, posicoes desc;

grant select on destaques_por_tipo to authenticated;
revoke all on function marcar_tipo_produto(text, text) from public, anon, authenticated;
