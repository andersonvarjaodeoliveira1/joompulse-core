\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('88888888-8888-8888-8888-888888888888','fi@t.com') on conflict do nothing;
insert into categories (id,name,is_leaf,root_id,path_ids,path_names,level)
  values ('CF','Cat ficha',true,'CF','{CF}','{F}',0) on conflict do nothing;
insert into catalog_products (id,name,category_id,brand,tipo)
  values ('PF','Produto ficha','CF','MarcaZ','PRODUCT') on conflict do nothing;

-- ranking: 20 dias, oscilando de 12 até 4 (entra no top 10 no dia 10)
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position,tipo)
select 'PF','CF', now()-make_interval(days=>d), current_date-d,
       case when d >= 10 then 12 else 4 end, 'PRODUCT'
from generate_series(0,19) d on conflict do nothing;

-- 4 concorrentes com preços diferentes; o líder cobra 80, mediana 100
insert into sellers (id,nickname,state) values
 (9801,'LIDER','SP'),(9802,'B','RJ'),(9803,'C','MG'),(9804,'D','PR') on conflict do nothing;
insert into seller_snapshots (seller_id,captured_at,captured_date,reputation_level,power_seller_status,transactions_total)
  values (9801,now(),current_date,'5_green','platinum',5400) on conflict do nothing;
insert into items (id,title,category_id,seller_id,catalog_product_id,status,shipping_logistic_type,official_store_id)
values ('IF1','a','CF',9801,'PF','active','fulfillment',7),
       ('IF2','b','CF',9802,'PF','active','drop_off',null),
       ('IF3','c','CF',9803,'PF','active','drop_off',null),
       ('IF4','d','CF',9804,'PF','active','fulfillment',null) on conflict do nothing;

-- série de preço: começou em 150, caiu para 100 (desconto máximo 33%)
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id)
select 'IF1', now()-make_interval(days=>d), current_date-d,
       case when d >= 10 then 150 else 80 end, 9801 from generate_series(0,19) d
on conflict do nothing;
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id)
select i, now()-make_interval(days=>d), current_date-d,
       case when d >= 10 then 160 else 110 end, s
from generate_series(0,19) d, (values ('IF2',9802),('IF3',9803),('IF4',9804)) v(i,s)
on conflict do nothing;
select refresh_rank_metrics(false);

set role authenticated;
set request.jwt.claim.sub = '88888888-8888-8888-8888-888888888888';

do $$
declare j jsonb; r record;
begin
  j := ficha_produto('PF');
  if j is null then raise exception 'ficha vazia'; end if;
  raise notice 'OK  ficha montada: % (%)', j->'produto'->>'nome', j->'produto'->>'marca';

  -- ranking
  if (j->'ranking'->>'posicao_atual')::int <> 4 then
    raise exception 'posição atual errada: %', j->'ranking'->>'posicao_atual'; end if;
  if (j->'ranking'->>'dias_ate_top10')::int <> 10 then
    raise exception 'dias até top10 esperado 10, veio %', j->'ranking'->>'dias_ate_top10'; end if;
  raise notice 'OK  ranking: % hoje, melhor %, levou % dias para entrar no top 10, estabilidade %',
    j->'ranking'->>'posicao_atual', j->'ranking'->>'melhor_posicao',
    j->'ranking'->>'dias_ate_top10', j->'ranking'->>'estabilidade';

  -- preço: máximo 160/150 -> mediana histórica; mínimo 80
  if (j->'preco'->>'preco_minimo')::numeric <> 80 then
    raise exception 'preço mínimo esperado 80, veio %', j->'preco'->>'preco_minimo'; end if;
  raise notice 'OK  preço: atual %, mínimo %, máximo %',
    j->'preco'->>'preco_atual', j->'preco'->>'preco_minimo', j->'preco'->>'preco_maximo';
  raise notice 'OK  desconto máximo já praticado: %%%',
    round((j->'preco'->>'desconto_maximo')::numeric*100);
  raise notice 'OK  momento de preço: % (posição na faixa %)',
    j->'preco'->>'momento_de_preco', j->'preco'->>'posicao_na_faixa';

  -- líder
  if (j->'lider'->>'vendedor') <> 'LIDER' then
    raise exception 'líder errado: %', j->'lider'->>'vendedor'; end if;
  if (j->'lider'->>'menor_preco')::numeric <> 80 then
    raise exception 'menor preço errado: %', j->'lider'->>'menor_preco'; end if;
  raise notice 'OK  líder: % (%) cobra R$ %', j->'lider'->>'vendedor',
    j->'lider'->>'estado', j->'lider'->>'menor_preco';
  raise notice 'OK  está %%% abaixo da mediana, medalha %',
    round((j->'lider'->>'abaixo_da_mediana')::numeric*100), j->'lider'->>'medalha';

  -- concorrência
  if (j->'concorrencia'->>'anuncios')::int <> 4 then
    raise exception 'esperado 4 anúncios, veio %', j->'concorrencia'->>'anuncios'; end if;
  raise notice 'OK  concorrência: % anúncios, % vendedores, dispersão %',
    j->'concorrencia'->>'anuncios', j->'concorrencia'->>'vendedores',
    j->'concorrencia'->>'dispersao';

  raise notice 'OK  ficha completa sem consumir quota';
end $$;
reset role;
do $$ begin raise notice '--- ficha do produto: todos os casos passaram ---'; end $$;
