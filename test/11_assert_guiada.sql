\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('88888888-8888-8888-8888-888888888888','g@t.com') on conflict do nothing;
update profiles set plan='pro' where id='88888888-8888-8888-8888-888888888888';
insert into categories (id,name,is_leaf,root_id,path_ids,path_names,level)
  values ('MLB_G','Cat guiada',true,'MLB_G','{MLB_G}','{G}',0) on conflict do nothing;
insert into catalog_products (id,name,category_id) values
  ('G_NOVO','Produto novo no ranking','MLB_G'),
  ('G_FIRME','Produto comprovado','MLB_G'),
  ('G_MEIO','Produto consolidando','MLB_G') on conflict do nothing;

-- G_NOVO: 5 dias de histórico
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position)
select 'G_NOVO','MLB_G', now()-make_interval(days=>d), current_date-d, 8
from generate_series(0,4) d on conflict do nothing;
-- G_FIRME: 30 dias sempre no top 10 -> consolidado
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position)
select 'G_FIRME','MLB_G', now()-make_interval(days=>d), current_date-d, 3
from generate_series(0,29) d on conflict do nothing;
-- G_MEIO: 25 dias, metade no top 10 -> recorrente
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position)
select 'G_MEIO','MLB_G', now()-make_interval(days=>d), current_date-d,
       case when d % 2 = 0 then 7 else 16 end
from generate_series(0,24) d on conflict do nothing;

insert into sellers (id,nickname) select 9800+g,'S'||g from generate_series(1,30) g on conflict do nothing;
-- G_FIRME: 3 concorrentes, preços 100/105/110 -> dispersão baixa
insert into items (id,title,category_id,seller_id,catalog_product_id,status)
select 'GF'||g,'x','MLB_G',9800+g,'G_FIRME','active' from generate_series(1,3) g on conflict do nothing;
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id)
select 'GF'||g, now(), current_date, 100+(g-1)*5, 9800+g from generate_series(1,3) g on conflict do nothing;
-- G_MEIO: 25 concorrentes, preços 50..290 -> dispersão alta
insert into items (id,title,category_id,seller_id,catalog_product_id,status)
select 'GM'||g,'y','MLB_G',9800+g,'G_MEIO','active' from generate_series(4,28) g on conflict do nothing;
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id)
select 'GM'||g, now(), current_date, 50+(g-4)*10, 9800+g from generate_series(4,28) g on conflict do nothing;
select refresh_rank_metrics(false);

set role authenticated;
set request.jwt.claim.sub = '88888888-8888-8888-8888-888888888888';

do $$
declare n int; j jsonb; r record;
begin
  -- referência por link de anúncio
  j := buscar_por_referencia('https://produto.mercadolivre.com.br/MLB-4881406189-x-_JM');
  if j->>'tipo' <> 'nao_encontrado' then raise exception 'esperado nao_encontrado, veio %', j; end if;
  raise notice 'OK  link de anúncio desconhecido devolve "%"', j->>'tipo';

  j := buscar_por_referencia('https://www.mercadolivre.com.br/x/p/G_FIRME');
  raise notice 'OK  link de catálogo reconhecido: tipo=%', j->>'tipo';

  j := buscar_por_referencia('balança digital');
  if j->>'tipo' <> 'texto' then raise exception 'texto livre deveria virar busca por nome'; end if;
  raise notice 'OK  texto livre vira busca por nome';

  -- maturidade
  select count(*) into n from buscar_produtos(p_raiz := 'MLB_G', p_maturidade := 'nova');
  if n <> 1 then raise exception 'maturidade nova esperava 1, veio %', n; end if;
  raise notice 'OK  maturidade "nova": % produto com até 14 dias', n;

  select product_id into r from buscar_produtos(p_raiz := 'MLB_G', p_maturidade := 'comprovado') limit 1;
  if r.product_id <> 'G_FIRME' then raise exception 'comprovado deveria trazer G_FIRME, veio %', r.product_id; end if;
  raise notice 'OK  maturidade "comprovado" traz o consolidado há 30 dias';

  select product_id into r from buscar_produtos(p_raiz := 'MLB_G', p_maturidade := 'consolidando') limit 1;
  if r.product_id <> 'G_MEIO' then raise exception 'consolidando deveria trazer G_MEIO, veio %', r.product_id; end if;
  raise notice 'OK  maturidade "consolidando" traz o recorrente';

  -- nível de concorrência
  select count(*) into n from buscar_produtos(p_raiz := 'MLB_G', p_nivel_conc := 'baixa');
  if n <> 1 then raise exception 'concorrência baixa esperava 1, veio %', n; end if;
  raise notice 'OK  concorrência "baixa": até 5 disputantes';

  select product_id into r from buscar_produtos(p_raiz := 'MLB_G', p_nivel_conc := 'alta') limit 1;
  if r.product_id <> 'G_MEIO' then raise exception 'alta deveria trazer G_MEIO'; end if;
  raise notice 'OK  concorrência "alta": 21 ou mais disputantes';

  -- estabilidade de preço
  select product_id into r from buscar_produtos(p_raiz := 'MLB_G', p_estabilidade := 'estavel') limit 1;
  if r.product_id <> 'G_FIRME' then raise exception 'estável deveria trazer G_FIRME, veio %', r.product_id; end if;
  raise notice 'OK  estabilidade "estável": dispersão até 25%%';

  select product_id into r from buscar_produtos(p_raiz := 'MLB_G', p_estabilidade := 'volatil') limit 1;
  if r.product_id <> 'G_MEIO' then raise exception 'volátil deveria trazer G_MEIO'; end if;
  raise notice 'OK  estabilidade "volátil": dispersão acima de 60%%';

  -- combinação guiada
  select count(*) into n from buscar_produtos(p_raiz := 'MLB_G', p_maturidade := 'comprovado', p_nivel_conc := 'baixa');
  if n <> 1 then raise exception 'combinação esperava 1, veio %', n; end if;
  raise notice 'OK  combinação comprovado + baixa concorrência';

  -- contagem guiada sem gastar quota
  select (quota_status()->'features'->'product_search'->>'used')::int into n;
  perform contar_produtos(p_raiz := 'MLB_G', p_maturidade := 'comprovado');
  select (quota_status()->'features'->'product_search'->>'used')::int - n into n;
  if n <> 0 then raise exception 'contagem guiada consumiu quota'; end if;
  raise notice 'OK  contagem com modos guiados não consome quota';
end $$;
reset role;
do $$ begin raise notice '--- busca guiada: todos os casos passaram ---'; end $$;
