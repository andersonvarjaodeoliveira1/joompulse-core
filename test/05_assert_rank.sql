\set ON_ERROR_STOP on
select refresh_rank_metrics(false);

do $$
declare v numeric; t text; r record;
begin
  -- CASO 1: movimento
  select position_now, position_7d_ago, delta_7d, momentum into r
    from product_momentum where product_id = 'PROD_SOBE';
  if r.position_now <> 3 then raise exception 'PROD_SOBE posição atual esperada 3, veio %', r.position_now; end if;
  if r.position_7d_ago <> 11 then raise exception 'PROD_SOBE posição de 7d atrás esperada 11, veio %', r.position_7d_ago; end if;
  if r.delta_7d <> 8 then raise exception 'PROD_SOBE delta esperado +8, veio %', r.delta_7d; end if;
  if r.momentum <> 'subindo' then raise exception 'PROD_SOBE momentum esperado subindo, veio %', r.momentum; end if;
  raise notice 'OK  ascensão: 11 -> 3, delta +8, classificado como subindo';

  -- CASO 2: persistência
  select days_observed, days_in_top10, top10_rate, consistencia, delta_7d into r
    from product_momentum where product_id = 'PROD_TOP';
  if r.days_in_top10 <> r.days_observed then
    raise exception 'PROD_TOP deveria estar no top10 todos os dias: % de %', r.days_in_top10, r.days_observed; end if;
  if r.consistencia <> 'consolidado' then raise exception 'PROD_TOP esperado consolidado, veio %', r.consistencia; end if;
  if r.delta_7d <> 0 then raise exception 'PROD_TOP delta esperado 0, veio %', r.delta_7d; end if;
  raise notice 'OK  persistência: % de % dias no top 10, consolidado', r.days_in_top10, r.days_observed;

  -- CASO 3: passageiro
  select days_observed, days_in_top10, consistencia into r
    from product_momentum where product_id = 'PROD_PASSA';
  if r.days_in_top10 <> 3 then raise exception 'PROD_PASSA esperado 3 dias no top10, veio %', r.days_in_top10; end if;
  if r.consistencia <> 'passageiro' then raise exception 'PROD_PASSA esperado passageiro, veio %', r.consistencia; end if;
  raise notice 'OK  passageiro: só 3 de % dias no top 10', r.days_observed;

  -- CASO 4: concorrência
  select listings, sellers, min_price, max_price, median_price, price_spread, full_share into r
    from product_competition where product_id = 'PROD_TOP';
  if r.listings <> 4 then raise exception 'esperado 4 anúncios, veio %', r.listings; end if;
  if r.sellers <> 4 then raise exception 'esperado 4 vendedores, veio %', r.sellers; end if;
  if r.median_price <> 135 then raise exception 'mediana esperada 135, veio %', r.median_price; end if;
  if r.min_price <> 100 or r.max_price <> 200 then
    raise exception 'faixa esperada 100-200, veio %-%', r.min_price, r.max_price; end if;
  if abs(r.price_spread - 0.702) > 0.002 then
    raise exception 'dispersão esperada 0.702, veio %', r.price_spread; end if;
  if r.full_share <> 0.5 then raise exception 'share de Full esperado 0.5, veio %', r.full_share; end if;
  raise notice 'OK  concorrência: 4 vendedores, mediana R$ 135, faixa 100-200, dispersão 70%%';

  -- CASO 5: calibração
  select pontos, confianca, escala_a into r from category_calibration where category_id = 'MLB_R1';
  if r.pontos <> 3 then raise exception 'esperados 3 pontos de calibração, veio %', r.pontos; end if;
  if r.confianca <> 'baixa' then raise exception 'com 3 pontos a confiança deve ser baixa, veio %', r.confianca; end if;
  if abs(r.escala_a - 1030) > 40 then raise exception 'escala esperada ~1030, veio %', r.escala_a; end if;
  raise notice 'OK  calibração: 3 pontos, escala ~%, confiança baixa', round(r.escala_a);

  -- estimativa deriva da calibração
  select units_mid, units_low, units_high, confianca into r
    from product_units_estimate where product_id = 'PROD_SOBE';
  if r.units_mid is null then raise exception 'estimativa não deveria ser nula com calibração presente'; end if;
  if r.units_low >= r.units_mid or r.units_high <= r.units_mid then
    raise exception 'faixa incoerente: % / % / %', r.units_low, r.units_mid, r.units_high; end if;
  raise notice 'OK  estimativa 3º lugar: % a % un/mês (central %), confiança %',
    r.units_low, r.units_high, r.units_mid, r.confianca;

  -- A regra mais importante: sem calibração, NÃO inventa número.
  insert into categories (id, name, root_id, path_ids, path_names, level, is_leaf)
    values ('MLB_SEMCAL','Sem calibração','MLB_SEMCAL','{MLB_SEMCAL}','{Sem}',0,true)
    on conflict (id) do nothing;
  insert into catalog_products (id, name, category_id) values ('PROD_SC','Produto','MLB_SEMCAL')
    on conflict (id) do nothing;
  insert into product_rank_snapshots (product_id, category_id, captured_at, captured_date, position)
    values ('PROD_SC','MLB_SEMCAL', now(), current_date, 2)
    on conflict do nothing;
  refresh materialized view product_rank_metrics;

  select units_mid into v from product_units_estimate where product_id = 'PROD_SC';
  if v is not null then
    raise exception 'sem calibração a estimativa TEM que ser nula, veio %', v; end if;
  raise notice 'OK  categoria sem calibração devolve null em vez de inventar número';

  raise notice '--- ranking: todos os casos passaram ---';
end $$;
