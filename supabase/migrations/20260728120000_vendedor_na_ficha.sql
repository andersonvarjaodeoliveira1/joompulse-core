-- =====================================================================
-- Vendedor real no detalhe do produto
--
-- A coleta (syncSellers → /users/{id}) já grava reputação em
-- seller_snapshots (~62k sellers com snapshot). O que faltava era
-- devolver isso em concorrentes_produto() e mostrar na UI.
--
-- Seguidores: /users/{id} NÃO devolve followers/followers_count
-- (confirmado ao vivo 28/07/2026 — top_keys sem nenhum campo de
-- seguidor). Não inventar; a UI explica o porquê.
--
-- DROP obrigatório: RETURNS TABLE muda → create or replace criaria
-- overload ambíguo (armadilha documentada no handoff).
-- =====================================================================

drop function if exists concorrentes_produto(text);

create function concorrentes_produto(p_produto text)
returns table (
  item_id text,
  seller_id bigint,
  nickname text,
  estado text,
  cidade text,
  preco numeric,
  full boolean,
  oficial boolean,
  frete_gratis boolean,
  permalink text,
  reputacao text,
  medalha text,
  transacoes bigint
)
language sql
security definer set search_path = public
as $$
  select distinct on (i.id)
    i.id,
    i.seller_id,
    s.nickname,
    s.state,
    s.city,
    sn.price,
    i.shipping_logistic_type = 'fulfillment',
    i.official_store_id is not null,
    i.shipping_free,
    s.permalink,
    rep.reputation_level,
    rep.power_seller_status,
    rep.transactions_total
  from items i
  join item_snapshots sn on sn.item_id = i.id
  left join sellers s on s.id = i.seller_id
  left join lateral (
    select reputation_level, power_seller_status, transactions_total
      from seller_snapshots ss
     where ss.seller_id = i.seller_id
     order by ss.captured_at desc
     limit 1
  ) rep on true
  where i.catalog_product_id = p_produto and i.status = 'active'
  order by i.id, sn.captured_at desc
$$;

grant execute on function concorrentes_produto(text) to authenticated;
