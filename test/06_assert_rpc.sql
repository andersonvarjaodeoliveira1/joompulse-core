\set ON_ERROR_STOP on
-- fixture mínima
insert into auth.users (id,email) values ('33333333-3333-3333-3333-333333333333','c@t.com') on conflict do nothing;
insert into categories (id,name,is_leaf,root_id,path_ids,path_names,level)
  values ('MLB_RPC','Cat RPC',true,'MLB_RPC','{MLB_RPC}','{RPC}',0) on conflict do nothing;
insert into catalog_products (id,name,category_id) values ('P_RPC','Produto RPC','MLB_RPC') on conflict do nothing;
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position)
  select 'P_RPC','MLB_RPC', now()-make_interval(days=>d), current_date-d,
         case when d>=7 then 14 else 4 end from generate_series(0,10) d
  on conflict do nothing;
insert into sellers (id,nickname,state) values (7001,'V1','SP') on conflict do nothing;
insert into items (id,title,category_id,seller_id,catalog_product_id,status,shipping_logistic_type)
  values ('IT_RPC','A','MLB_RPC',7001,'P_RPC','active','fulfillment') on conflict do nothing;
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id)
  values ('IT_RPC',now(),current_date,299.90,7001) on conflict do nothing;
select refresh_rank_metrics(false);

set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

do $$
declare n int; e text; r record;
begin
  -- a RPC devolve dado e consome quota
  select count(*) into n from buscar_produtos();
  if n < 1 then raise exception 'buscar_produtos não devolveu nada'; end if;
  raise notice 'OK  buscar_produtos devolveu % produto(s)', n;

  -- 5 buscas no plano gratuito: a 1ª já foi, faltam 4
  perform buscar_produtos(); perform buscar_produtos();
  perform buscar_produtos(); perform buscar_produtos();
  begin
    perform buscar_produtos();
    raise exception 'a 6ª busca passou — a quota não bloqueou na RPC';
  exception when sqlstate 'P0001' then
    raise notice 'OK  6ª chamada bloqueada pela quota dentro do banco';
  end;

  -- categorias pela RPC (a matview direta está fechada, como deve ser)
  select produtos_rankeados, rotatividade_7d, oportunidade into r
    from listar_categorias() limit 1;
  if r.produtos_rankeados is null then raise exception 'listar_categorias não devolveu nada'; end if;
  raise notice 'OK  listar_categorias via RPC: % produto(s), rotatividade %, oportunidade %',
    r.produtos_rankeados, coalesce(r.rotatividade_7d::text,'sem base'), r.oportunidade;

  select count(*) into n from historico_produto('P_RPC');
  if n <> 11 then raise exception 'histórico esperado 11 dias, veio %', n; end if;
  raise notice 'OK  histórico do produto: % dias, sem gastar quota', n;

  select count(*) into n from concorrentes_produto('P_RPC');
  if n <> 1 then raise exception 'esperado 1 concorrente, veio %', n; end if;
  raise notice 'OK  concorrentes do produto: %', n;
end $$;

-- a porta velha tem que estar fechada
do $$
declare n int;
begin
  begin
    select count(*) into n from product_search_view;
    raise exception 'FURO: authenticated ainda lê product_search_view direto';
  exception when insufficient_privilege then
    raise notice 'OK  select direto na view negado — só via RPC';
  end;
end $$;
reset role;
do $$ begin raise notice '--- RPC: todos os casos passaram ---'; end $$;
