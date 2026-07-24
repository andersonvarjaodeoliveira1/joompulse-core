-- Assertions. Cada bloco falha com exceção se o número não bater.
\set ON_ERROR_STOP on

select refresh_metrics(false);

do $$
declare v numeric; g int;
begin
  -- CASO 1: vendas somam 45, receita 2250
  select units_30d, revenue_30d into v, g from item_metrics where item_id='ITEM_NORMAL';
  select units_30d into v from item_metrics where item_id='ITEM_NORMAL';
  if v <> 45 then raise exception 'ITEM_NORMAL units esperado 45, veio %', v; end if;
  select revenue_30d into v from item_metrics where item_id='ITEM_NORMAL';
  if v <> 2250 then raise exception 'ITEM_NORMAL receita esperada 2250, veio %', v; end if;
  raise notice 'OK  caso normal: 45 unidades, R$ 2250';

  -- CASO 2: republicação não vira venda negativa
  select units_30d into v from item_metrics where item_id='ITEM_RESET';
  if v <> 20 then raise exception 'ITEM_RESET units esperado 20 (reset tratado), veio %', v; end if;
  select units_sold into v from item_daily_sales
    where item_id='ITEM_RESET' and captured_date = current_date - 1;
  if v <> 0 then raise exception 'ITEM_RESET dia do reset deveria ser 0, veio %', v; end if;
  raise notice 'OK  republicação: 20 unidades, dia do reset = 0 (não negativo)';

  -- CASO 3: buraco registrado
  select gap_days into g from item_daily_sales
    where item_id='ITEM_GAP' and captured_date = current_date - 1;
  if g <> 5 then raise exception 'ITEM_GAP gap_days esperado 5, veio %', g; end if;
  select units_sold into v from item_daily_sales
    where item_id='ITEM_GAP' and captured_date = current_date - 1;
  if v <> 50 then raise exception 'ITEM_GAP units esperado 50, veio %', v; end if;
  raise notice 'OK  buraco de coleta: 50 unidades marcadas com gap_days = 5';

  -- CASO 4: receita usa o preço do dia, não a média
  select revenue_30d into v from item_metrics where item_id='ITEM_PROMO';
  if v <> 3800 then raise exception 'ITEM_PROMO receita esperada 3800 (preço do dia), veio %', v; end if;
  raise notice 'OK  promoção: R$ 3800 usando preço diário (média daria 4333)';

  -- CASO 5: concentração de mercado
  select top_seller_share into v from category_metrics where category_id='MLB_CONC';
  if abs(v - 0.9091) > 0.001 then raise exception 'top_seller_share esperado 0.9091, veio %', v; end if;
  select hhi into v from category_metrics where category_id='MLB_CONC';
  if abs(v - 0.8347) > 0.001 then raise exception 'HHI esperado 0.8347, veio %', v; end if;
  raise notice 'OK  monopolização: líder com 90.9%% da receita, HHI 0.8347';

  raise notice '--- métricas: todos os casos passaram ---';
end $$;
