\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('55555555-5555-5555-5555-555555555555','f@t.com') on conflict do nothing;
insert into categories (id,name,is_leaf,root_id,path_ids,path_names,level) values
  ('RAIZ','Raiz',false,'RAIZ','{RAIZ}','{Raiz}',0),
  ('MLB_F1','Suplementos',true,'RAIZ','{RAIZ,MLB_F1}','{Raiz,Suplementos}',1),
  ('MLB_F2','Periféricos',true,'RAIZ','{RAIZ,MLB_F2}','{Raiz,Periféricos}',1)
on conflict do nothing;
insert into catalog_products (id,name,category_id) values
  ('F_SOBE','Creatina que sobe','MLB_F1'),
  ('F_CONC','Produto disputado','MLB_F1'),
  ('F_CALMO','Produto sem briga','MLB_F2')
on conflict do nothing;

-- F_SOBE: 14 -> 4 (subiu 10), no top10 há dias
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position)
select 'F_SOBE','MLB_F1', now()-make_interval(days=>d), current_date-d,
       case when d>=7 then 14 else 4 end from generate_series(0,20) d on conflict do nothing;
-- F_CONC: fixo em 2
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position)
select 'F_CONC','MLB_F1', now()-make_interval(days=>d), current_date-d, 2
from generate_series(0,20) d on conflict do nothing;
-- F_CALMO: fixo em 9, outra categoria
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position)
select 'F_CALMO','MLB_F2', now()-make_interval(days=>d), current_date-d, 9
from generate_series(0,20) d on conflict do nothing;

insert into sellers (id,nickname) select 9100+g, 'V'||g from generate_series(1,12) g on conflict do nothing;
-- F_CONC com 10 concorrentes, preços 100..190
insert into items (id,title,category_id,seller_id,catalog_product_id,status,shipping_logistic_type)
select 'IC'||g,'x','MLB_F1',9100+g,'F_CONC','active', case when g<=2 then 'fulfillment' else 'drop_off' end
from generate_series(1,10) g on conflict do nothing;
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id)
select 'IC'||g, now(), current_date, 100+(g-1)*10, 9100+g from generate_series(1,10) g on conflict do nothing;
-- F_CALMO com 2 concorrentes
insert into items (id,title,category_id,seller_id,catalog_product_id,status,shipping_logistic_type)
select 'IK'||g,'y','MLB_F2',9100+g,'F_CALMO','active','fulfillment' from generate_series(11,12) g on conflict do nothing;
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id)
select 'IK'||g, now(), current_date, 300, 9100+g from generate_series(11,12) g on conflict do nothing;
select refresh_rank_metrics(false);

-- o teste faz mais de 5 buscas; plano gratuito bloquearia no meio.
update profiles set plan = 'pro' where id = '55555555-5555-5555-5555-555555555555';

set role authenticated;
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';

do $$
declare n int; r record;
begin
  -- contar não gasta quota
  select contar_produtos(p_raiz := 'RAIZ') into n;
  if n < 3 then raise exception 'contagem esperada >=3, veio %', n; end if;
  select (quota_status()->'features'->'product_search'->>'used')::int into n;
  if n <> 0 then raise exception 'contar_produtos gastou quota! used=%', n; end if;
  raise notice 'OK  contar_produtos não consome quota';

  -- filtro por movimento
  select count(*) into n from buscar_produtos(p_raiz := 'RAIZ', p_momentum := 'subindo');
  if n <> 1 then raise exception 'esperado 1 subindo, veio %', n; end if;
  raise notice 'OK  filtro por movimento: 1 produto subindo';

  -- filtro por delta mínimo
  select count(*) into n from buscar_produtos(p_raiz := 'RAIZ', p_delta_min := 5);
  if n <> 1 then raise exception 'esperado 1 com delta>=5, veio %', n; end if;
  raise notice 'OK  filtro por delta mínimo de 5 posições';

  -- filtro por concorrência máxima
  select count(*) into n from buscar_produtos(p_raiz := 'RAIZ', p_conc_max := 3);
  if n < 1 then raise exception 'esperado ao menos 1 com <=3 concorrentes'; end if;
  raise notice 'OK  filtro por concorrência: % produto(s) com até 3 vendedores', n;

  -- filtro por categoria raiz
  select count(*) into n from buscar_produtos(p_raiz := 'RAIZ');
  if n <> 3 then raise exception 'esperado 3 na raiz, veio %', n; end if;
  raise notice 'OK  filtro pela categoria raiz alcança as subcategorias';

  -- combinação
  select count(*) into n from buscar_produtos(p_categoria := 'MLB_F1', p_pos_max := 5);
  if n <> 2 then raise exception 'esperado 2, veio %', n; end if;
  raise notice 'OK  combinação categoria + posição máxima';

  -- ordenação por concorrência devolve o menos disputado primeiro
  select product_id, listings into r from buscar_produtos(p_raiz := 'RAIZ', p_ordem := 'concorrencia') limit 1;
  if r.listings > 3 then raise exception 'ordenação por concorrência falhou: %', r.listings; end if;
  raise notice 'OK  ordenar por concorrência traz % primeiro (% anúncios)', r.product_id, r.listings;

  -- seletor de categorias
  select count(*) into n from buscar_categorias('supl');
  if n <> 1 then raise exception 'busca de categoria esperava 1, veio %', n; end if;
  raise notice 'OK  buscar_categorias encontra por texto parcial';

  select count(*) into n from categorias_raiz();
  if n < 1 then raise exception 'categorias_raiz vazia'; end if;
  raise notice 'OK  categorias_raiz devolve % raiz(es)', n;
end $$;
reset role;
do $$ begin raise notice '--- filtros: todos os casos passaram ---'; end $$;
