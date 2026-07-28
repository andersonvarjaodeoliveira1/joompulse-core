-- =====================================================================
-- Grafico do Monitor: funcionar sem depender so do ranking
--
-- historico_monitorados() so lia product_rank_daily. Produto monitorado
-- que nao esta no top 20 (ex.: veio da fila via /products/search) nao
-- tinha nenhuma linha → sparkMini mostrava "sem dado" pra sempre.
--
-- Agora une dias de ranking E de preco (product_price_daily). Preco
-- sozinho ja desenha a linha verde. Ranking sozinho, a roxa.
--
-- Tambem: um produto pode aparecer em 2 categorias no mesmo dia —
-- distinct on pega a MELHOR posicao (menor numero) pra nao ziguezaguear.
-- =====================================================================

drop function if exists historico_monitorados(int);

create function historico_monitorados(p_dias int default 21)
returns table (product_id text, dia date, posicao int, preco numeric)
language sql
security definer set search_path = public
as $$
  with meus as (
    select t.product_id
      from tracked_products t
     where t.user_id = auth.uid()
  ),
  -- Melhor posição do dia (um produto pode estar em N categorias)
  rank_dia as (
    select distinct on (r.product_id, r.captured_date)
           r.product_id, r.captured_date as dia, r.position as posicao
      from product_rank_daily r
      join meus m on m.product_id = r.product_id
     where r.captured_date >= current_date - p_dias
     order by r.product_id, r.captured_date, r.position asc
  ),
  preco_dia as (
    select p.product_id, p.dia, p.preco_mediano as preco
      from product_price_daily p
      join meus m on m.product_id = p.product_id
     where p.dia >= current_date - p_dias
  ),
  dias as (
    select product_id, dia from rank_dia
    union
    select product_id, dia from preco_dia
  )
  select d.product_id,
         d.dia,
         r.posicao,
         p.preco
    from dias d
    left join rank_dia  r on r.product_id = d.product_id and r.dia = d.dia
    left join preco_dia p on p.product_id = d.product_id and p.dia = d.dia
   order by d.product_id, d.dia
$$;

grant execute on function historico_monitorados(int) to authenticated;
