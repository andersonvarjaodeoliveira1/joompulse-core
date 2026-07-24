\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('44444444-4444-4444-4444-444444444444','m@t.com') on conflict do nothing;
insert into categories (id,name,is_leaf,root_id,path_ids,path_names,level)
  values ('MLB_MON','Cat Monitor',true,'MLB_MON','{MLB_MON}','{Mon}',0) on conflict do nothing;
insert into catalog_products (id,name,category_id) values
  ('P_SOBE','Produto que sobe','MLB_MON'),('P_CAI','Produto que cai','MLB_MON'),
  ('P_PRECO','Produto com preço móvel','MLB_MON') on conflict do nothing;

-- ontem 14 -> hoje 4  (subiu 10, entrou no top 10)
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position) values
  ('P_SOBE','MLB_MON', now()-interval '1 day', current_date-1, 14),
  ('P_SOBE','MLB_MON', now(),                 current_date,    4),
  ('P_CAI', 'MLB_MON', now()-interval '1 day', current_date-1,  6),
  ('P_CAI', 'MLB_MON', now(),                 current_date,   15)
on conflict do nothing;

-- preço: ontem 100, hoje 80 (queda de 20%) e um concorrente a mais
insert into sellers (id,nickname) values (8001,'S1'),(8002,'S2'),(8003,'S3') on conflict do nothing;
insert into items (id,title,category_id,seller_id,catalog_product_id,status) values
  ('I1','a','MLB_MON',8001,'P_PRECO','active'),
  ('I2','b','MLB_MON',8002,'P_PRECO','active'),
  ('I3','c','MLB_MON',8003,'P_PRECO','active') on conflict do nothing;
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id) values
  ('I1', now()-interval '1 day', current_date-1, 100, 8001),
  ('I2', now()-interval '1 day', current_date-1, 100, 8002),
  ('I1', now(), current_date,  80, 8001),
  ('I2', now(), current_date,  80, 8002),
  ('I3', now(), current_date,  80, 8003)
on conflict do nothing;
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position) values
  ('P_PRECO','MLB_MON', now(), current_date, 7) on conflict do nothing;
select refresh_rank_metrics(false);

set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';

do $$
declare r jsonb; n int; a record;
begin
  r := monitorar_produto('P_SOBE');
  if not (r->>'ok')::boolean then raise exception 'não monitorou: %', r; end if;
  raise notice 'OK  monitorou P_SOBE (posição inicial %)', r->>'pos_inicial';

  perform monitorar_produto('P_CAI');
  perform monitorar_produto('P_PRECO');

  -- plano gratuito tem teto de 4
  perform monitorar_produto('P_SOBE');   -- repetido não conta
  select count(*) into n from tracked_products;
  if n <> 3 then raise exception 'esperado 3 monitorados, veio %', n; end if;
  raise notice 'OK  monitorar duas vezes o mesmo produto não duplica (% no total)', n;
end $$;

reset role;
select gerar_alertas() as gerados;

set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';

do $$
declare n int; a record;
begin
  select count(*) into n from listar_alertas();
  if n = 0 then raise exception 'nenhum alerta gerado'; end if;
  raise notice 'OK  % alerta(s) gerado(s)', n;

  select titulo, tipo into a from listar_alertas() where product_id='P_SOBE' and tipo='entrou_top10';
  if a.titulo is null then raise exception 'faltou alerta de entrada no top 10'; end if;
  raise notice 'OK  P_SOBE: %', a.titulo;

  select titulo into a from listar_alertas() where product_id='P_CAI' and tipo='saiu_top10';
  if a.titulo is null then raise exception 'faltou alerta de saída do top 10'; end if;
  raise notice 'OK  P_CAI: %', a.titulo;

  select titulo, detalhe into a from listar_alertas() where product_id='P_PRECO' and tipo='preco_caiu';
  if a.titulo is null then raise exception 'faltou alerta de queda de preço'; end if;
  raise notice 'OK  P_PRECO: % (%)', a.titulo, a.detalhe;

  select titulo into a from listar_alertas() where product_id='P_PRECO' and tipo='concorrencia';
  raise notice 'OK  concorrência: %', coalesce(a.titulo,'sem mudança relevante');
end $$;

-- rodar de novo não pode duplicar
reset role;
select gerar_alertas();
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$
declare n int;
begin
  select count(*) into n from listar_alertas();
  if n <> 3 then raise exception 'após rodar duas vezes deveria haver 3, veio %', n; end if;
  raise notice 'OK  rodar gerar_alertas duas vezes mantém % — sem duplicata', n;
end $$;

do $$
declare n int; m record;
begin
  select * into m from listar_monitorados() where product_id='P_SOBE';
  if m.delta_desde_inicio is null then raise exception 'delta desde o início não calculado'; end if;
  raise notice 'OK  listar_monitorados: % · posição % · % alerta(s) novo(s)',
    m.nome, m.pos_atual, m.alertas_novos;

  perform marcar_alertas_lidos();
  select count(*) into n from listar_alertas() where not lido;
  if n <> 0 then raise exception 'ainda restam % não lidos', n; end if;
  raise notice 'OK  marcar_alertas_lidos zera os não lidos';

  perform desmonitorar_produto('P_CAI');
  select count(*) into n from listar_monitorados();
  if n <> 2 then raise exception 'esperado 2 após remover, veio %', n; end if;
  raise notice 'OK  desmonitorar remove da lista (% restantes)', n;
end $$;
reset role;
do $$ begin raise notice '--- monitor: todos os casos passaram ---'; end $$;
