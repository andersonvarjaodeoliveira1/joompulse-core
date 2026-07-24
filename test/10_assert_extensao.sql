\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('77777777-7777-7777-7777-777777777777','e@t.com') on conflict do nothing;
insert into categories (id,name,is_leaf,root_id,path_ids,path_names,level)
  values ('MLB_EX','Cat Ext',true,'MLB_EX','{MLB_EX}','{Ext}',0) on conflict do nothing;
insert into catalog_products (id,name,category_id) values ('P_EXT','Produto da extensão','MLB_EX') on conflict do nothing;
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position)
select 'P_EXT','MLB_EX', now()-make_interval(days=>d), current_date-d,
       case when d>=7 then 12 else 5 end from generate_series(0,15) d on conflict do nothing;
insert into sellers (id,nickname) values (9700,'LOJA_X') on conflict do nothing;
insert into items (id,title,category_id,seller_id,catalog_product_id,status) values
  ('MLB111','x','MLB_EX',9700,'P_EXT','active'),
  ('MLB222','sem produto','MLB_EX',9700,null,'active') on conflict do nothing;
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id)
  values ('MLB111',now(),current_date,149.90,9700) on conflict do nothing;
select refresh_rank_metrics(false);

set role authenticated;
set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';

do $$
declare j jsonb; n int;
begin
  -- anúncio conhecido e rankeado
  j := resolver_anuncio('MLB111');
  if j->>'status' <> 'encontrado' then raise exception 'esperado encontrado, veio %', j->>'status'; end if;
  if (j->>'posicao')::int <> 5 then raise exception 'posição errada: %', j->>'posicao'; end if;
  if (j->>'delta_7d')::int <> 7 then raise exception 'delta errado: %', j->>'delta_7d'; end if;
  raise notice 'OK  anúncio resolvido: % · posição %º · subiu % · % concorrente(s)',
    j->>'nome', j->>'posicao', j->>'delta_7d', j->>'concorrentes';

  -- anúncio conhecido mas sem produto de catálogo
  j := resolver_anuncio('MLB222');
  if j->>'status' <> 'sem_ranking' then raise exception 'esperado sem_ranking, veio %', j->>'status'; end if;
  raise notice 'OK  anúncio sem produto de catálogo devolve "%"', j->>'status';

  -- anúncio nunca visto
  j := resolver_anuncio('MLB999999');
  if j->>'status' <> 'desconhecido' then raise exception 'esperado desconhecido, veio %', j->>'status'; end if;
  raise notice 'OK  anúncio fora da cobertura devolve "%"', j->>'status';

  -- cota separada: 25 no gratuito, e não toca na de buscas
  select (quota_status()->'features'->'extension_view'->>'limit')::int into n;
  if n <> 25 then raise exception 'cota da extensão deveria ser 25, veio %', n; end if;
  select (quota_status()->'features'->'product_search'->>'used')::int into n;
  if n <> 0 then raise exception 'a extensão consumiu quota de BUSCA: %', n; end if;
  raise notice 'OK  cota própria de 25 visualizações, sem tocar nas 5 buscas';

  -- pedido de coleta não gasta nada e acumula
  j := solicitar_coleta('MLB999999','MLB_EX','https://x');
  if (j->>'pedidos')::int <> 1 then raise exception 'pedidos deveria ser 1'; end if;
  j := solicitar_coleta('MLB999999','MLB_EX','https://x');
  if (j->>'pedidos')::int <> 2 then raise exception 'pedidos deveria acumular para 2, veio %', j->>'pedidos'; end if;
  raise notice 'OK  pedido de coleta acumula (% pedidos) sem consumir quota', j->>'pedidos';

  -- monitorado aparece no retorno
  perform monitorar_produto('P_EXT');
  j := resolver_anuncio('MLB111');
  if not (j->>'monitorado')::boolean then raise exception 'deveria indicar que está monitorado'; end if;
  raise notice 'OK  a extensão sabe que o produto já está no seu monitor';
end $$;
reset role;
do $$ begin raise notice '--- extensão: todos os casos passaram ---'; end $$;
