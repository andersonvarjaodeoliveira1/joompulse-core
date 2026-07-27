-- Grafico do detalhe so tinha posicao (1 linha). Junta preco mediano
-- do dia (product_price_daily ja existe) na mesma serie. returns table
-- muda de forma -> precisa dropar.
drop function if exists historico_produto(text);

create or replace function historico_produto(p_produto text)
returns table (dia date, posicao int, preco numeric)
language sql
security definer set search_path = public
as $$
  select r.captured_date, r.position, pd.preco_mediano
    from product_rank_daily r
    left join product_price_daily pd
      on pd.product_id = r.product_id and pd.dia = r.captured_date
   where r.product_id = p_produto
   order by r.captured_date
$$;

grant execute on function historico_produto(text) to authenticated;

-- ---------------------------------------------------------------------
-- Mini-grafico por linha na aba "Acompanhando": 1 chamada busca o
-- historico de TODOS os produtos monitorados de uma vez (em vez de N
-- chamadas, uma por produto).
-- ---------------------------------------------------------------------
create or replace function historico_monitorados(p_dias int default 21)
returns table (product_id text, dia date, posicao int)
language sql
security definer set search_path = public
as $$
  select r.product_id, r.captured_date, r.position
    from product_rank_daily r
    join tracked_products t on t.product_id = r.product_id and t.user_id = auth.uid()
   where r.captured_date >= current_date - p_dias
   order by r.product_id, r.captured_date
$$;

grant execute on function historico_monitorados(int) to authenticated;
