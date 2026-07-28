-- Mini-grafico do Monitor > Acompanhando so tinha posicao (1 linha,
-- fraco). Junta preco mediano do dia, mesma fonte que historico_produto
-- ja usa (product_price_daily) -- returns table muda de forma, precisa
-- dropar.
drop function if exists historico_monitorados(int);

create or replace function historico_monitorados(p_dias int default 21)
returns table (product_id text, dia date, posicao int, preco numeric)
language sql
security definer set search_path = public
as $$
  select r.product_id, r.captured_date, r.position, pd.preco_mediano
    from product_rank_daily r
    join tracked_products t on t.product_id = r.product_id and t.user_id = auth.uid()
    left join product_price_daily pd
      on pd.product_id = r.product_id and pd.dia = r.captured_date
   where r.captured_date >= current_date - p_dias
   order by r.product_id, r.captured_date
$$;

grant execute on function historico_monitorados(int) to authenticated;
