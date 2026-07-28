-- =====================================================================
-- historico_produto: mesma união ranking+preço do Monitor
--
-- Antes só lia product_rank_daily. Dia com preço mas sem ranking
-- (comum fora do top 20, ou preço coletado noutro dia) não entrava —
-- o gráfico ficava só com a linha roxa, sem verde.
-- =====================================================================

drop function if exists historico_produto(text);

create function historico_produto(p_produto text)
returns table (dia date, posicao int, preco numeric)
language sql
security definer set search_path = public
as $$
  with rank_dia as (
    select distinct on (r.captured_date)
           r.captured_date as dia, r.position as posicao
      from product_rank_daily r
     where r.product_id = p_produto
     order by r.captured_date, r.position asc
  ),
  preco_dia as (
    select p.dia, p.preco_mediano as preco
      from product_price_daily p
     where p.product_id = p_produto
  ),
  dias as (
    select dia from rank_dia
    union
    select dia from preco_dia
  )
  select d.dia, r.posicao, p.preco
    from dias d
    left join rank_dia  r on r.dia = d.dia
    left join preco_dia p on p.dia = d.dia
   order by d.dia
$$;

grant execute on function historico_produto(text) to authenticated;
