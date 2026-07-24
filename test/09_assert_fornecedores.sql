\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('66666666-6666-6666-6666-666666666666','p@t.com') on conflict do nothing;
insert into categories (id,name,is_leaf,root_id,path_ids,path_names,level)
  values ('MLB_FR','Balanças',true,'MLB_FR','{MLB_FR}','{Balanças}',0) on conflict do nothing;
insert into catalog_products (id,name,category_id) values ('P_BAL','Balança Bioimpedância','MLB_FR') on conflict do nothing;
insert into product_rank_snapshots (product_id,category_id,captured_at,captured_date,position)
  values ('P_BAL','MLB_FR',now(),current_date,3) on conflict do nothing;
insert into sellers (id,nickname) values (9500,'V') on conflict do nothing;
insert into items (id,title,category_id,seller_id,catalog_product_id,status)
  values ('I_BAL','x','MLB_FR',9500,'P_BAL','active') on conflict do nothing;
insert into item_snapshots (item_id,captured_at,captured_date,price,seller_id)
  values ('I_BAL',now(),current_date,65.10,9500) on conflict do nothing;
select refresh_rank_metrics(false);

insert into suppliers (id,nome,telefone,email,site,cidade,estado,tipo,verificado,origem) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Utimix Importadora','11953007505','contato@utimix.com','utimix.com','São Paulo','SP','importador',true,'parceria'),
  ('aaaaaaaa-0000-0000-0000-000000000002','Fornecedor B','1199999','b@b.com','b.com','Curitiba','PR','distribuidor',false,'planilha')
on conflict do nothing;
insert into supplier_products (supplier_id,nome,custo,sku,catalog_product_id,category_id,unidades_por_caixa) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Balança Digital Corporal Bioimpedância',28.00,'BAL01','P_BAL','MLB_FR',1),
  ('aaaaaaaa-0000-0000-0000-000000000002','Produto sem vínculo',10.00,'X1',null,'MLB_FR',1)
on conflict do nothing;

set role authenticated;
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';

do $$
declare r record; j jsonb; n int;
begin
  -- margem bruta: (65.10 - 28) / 65.10 = 0.5699
  select * into r from listar_produtos_locais() where nome ilike 'Balança%';
  if r.produto_id is null then raise exception 'produto local não apareceu'; end if;
  if abs(r.margem_bruta - 0.5699) > 0.001 then
    raise exception 'margem esperada 0.5699, veio %', r.margem_bruta; end if;
  raise notice 'OK  margem bruta: custo R$ % vs ML R$ % = %',
    r.custo, r.preco_medio_ml, round(r.margem_bruta*100)||'%';
  raise notice 'OK  vínculo com o catálogo traz posição % e % concorrente(s)',
    r.posicao_ml, r.concorrentes_ml;

  -- contato NÃO pode vir na listagem
  begin
    perform telefone from produtos_locais_view limit 1;
    raise exception 'FURO: telefone exposto na listagem';
  exception when undefined_column then
    raise notice 'OK  a listagem não expõe telefone nem e-mail';
  end;

  -- ler suppliers direto tem que ser negado
  begin
    select count(*) into n from suppliers;
    raise exception 'FURO: authenticated lê suppliers direto';
  exception when insufficient_privilege then
    raise notice 'OK  select direto em suppliers negado';
  end;

  -- desbloqueio consome quota
  j := desbloquear_fornecedor('aaaaaaaa-0000-0000-0000-000000000001');
  if not (j->>'ok')::boolean then raise exception 'desbloqueio falhou: %', j; end if;
  if j->>'telefone' <> '11953007505' then raise exception 'telefone errado: %', j->>'telefone'; end if;
  raise notice 'OK  desbloqueio revela contato: % · %', j->>'nome', j->>'telefone';

  -- segunda vez no MESMO fornecedor não cobra de novo
  j := desbloquear_fornecedor('aaaaaaaa-0000-0000-0000-000000000001');
  if not (j->>'ja_estava')::boolean then raise exception 'cobrou de novo pelo mesmo fornecedor'; end if;
  select (quota_status()->'features'->'supplier_unlock'->>'used')::int into n;
  if n <> 1 then raise exception 'esperado 1 desbloqueio usado, veio %', n; end if;
  raise notice 'OK  reabrir o mesmo fornecedor não consome quota de novo (usados: %)', n;

  -- plano gratuito: 4 desbloqueios
  select (quota_status()->'features'->'supplier_unlock'->>'limit')::int into n;
  if n <> 4 then raise exception 'limite do gratuito deveria ser 4, veio %', n; end if;
  raise notice 'OK  plano gratuito com % desbloqueios por mês', n;

  select count(*) into n from meus_desbloqueios();
  if n <> 1 then raise exception 'esperado 1 desbloqueio registrado, veio %', n; end if;
  raise notice 'OK  meus_desbloqueios lista o que já foi liberado';

  -- filtro por margem
  select count(*) into n from listar_produtos_locais(p_margem_min := 0.5);
  if n <> 1 then raise exception 'esperado 1 com margem>=50%%, veio %', n; end if;
  raise notice 'OK  filtro por margem mínima';

  select count(*) into n from listar_produtos_locais(p_so_vinculados := true);
  if n <> 1 then raise exception 'esperado 1 vinculado, veio %', n; end if;
  raise notice 'OK  filtro de só vinculados ao catálogo do ML';
end $$;
reset role;
do $$ begin raise notice '--- fornecedores: todos os casos passaram ---'; end $$;
