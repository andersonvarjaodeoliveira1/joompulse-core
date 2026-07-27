-- =====================================================================
-- 110_buscar_vendedores.sql
--
-- A feature 'seller_search' já existia em plans.limits desde o começo
-- (3/50/300/ilimitado por plano) mas nunca teve RPC nenhuma por trás --
-- não dava pra achar vendedor pra acompanhar de jeito nenhum.
--
-- tracked_sellers já tinha grant direto (select/insert/update/delete
-- to authenticated) desde a criação -- não precisa de RPC pra
-- acompanhar/soltar, só pra achar quem acompanhar.
-- =====================================================================
create or replace function buscar_vendedores(p_texto text, p_limite int default 20)
returns table (
  id bigint, nickname text, city text, state text, is_official_store boolean,
  permalink text, reputation_level text, power_seller_status text, anuncios_vistos bigint
)
language plpgsql
security definer set search_path = public
as $$
declare q jsonb;
begin
  q := consume_quota('seller_search');
  if not (q ->> 'allowed')::boolean then
    raise exception 'quota esgotada' using errcode = 'P0001', detail = q::text;
  end if;

  return query
    select s.id, s.nickname, s.city, s.state, s.is_official_store, s.permalink,
           r.reputation_level, r.power_seller_status,
           (select count(*) from items i where i.seller_id = s.id) as anuncios_vistos
      from sellers s
      left join lateral (
        select reputation_level, power_seller_status
          from seller_snapshots ss
         where ss.seller_id = s.id
         order by ss.captured_at desc limit 1
      ) r on true
     where s.nickname ilike '%' || p_texto || '%'
     order by (select count(*) from items i where i.seller_id = s.id) desc, s.nickname
     limit least(p_limite, 50);
end;
$$;

grant execute on function buscar_vendedores(text, int) to authenticated;

-- Contagem sem gastar quota, pra pré-visualizar antes de gastar chamada.
create or replace function contar_vendedores(p_texto text)
returns bigint
language sql
security definer set search_path = public
as $$
  select count(*) from sellers where nickname ilike '%' || p_texto || '%'
$$;

grant execute on function contar_vendedores(text) to authenticated;
