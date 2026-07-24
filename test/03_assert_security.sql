-- =====================================================================
-- Testes de segurança: quota e isolamento entre usuários.
-- Roda como o papel "authenticated", não como superusuário — senão a
-- RLS é ignorada e o teste não prova nada.
-- =====================================================================
\set ON_ERROR_STOP on

-- Dois usuários. O trigger on_auth_user_created deve criar os perfis.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ana@teste.com'),
  ('22222222-2222-2222-2222-222222222222', 'bruno@teste.com');

do $$
declare n int;
begin
  select count(*) into n from profiles;
  if n <> 2 then raise exception 'trigger de perfil falhou: esperado 2, veio %', n; end if;
  raise notice 'OK  trigger criou % perfis automaticamente', n;
end $$;

-- ---------------------------------------------------------------------
-- QUOTA: plano gratuito tem 5 buscas. A sexta precisa ser negada.
-- ---------------------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare r jsonb; i int;
begin
  for i in 1..5 loop
    r := consume_quota('product_search');
    if not (r ->> 'allowed')::boolean then
      raise exception 'busca % deveria passar, veio %', i, r;
    end if;
  end loop;
  raise notice 'OK  5 buscas consumidas, restam %', r ->> 'remaining';

  r := consume_quota('product_search');
  if (r ->> 'allowed')::boolean then
    raise exception 'a 6ª busca passou! quota não está bloqueando: %', r;
  end if;
  if (r ->> 'reason') <> 'quota_exceeded' then
    raise exception 'motivo esperado quota_exceeded, veio %', r ->> 'reason';
  end if;
  raise notice 'OK  6ª busca negada com motivo %', r ->> 'reason';

  -- Recurso com limite 0 no plano gratuito: nem chega a contar
  r := consume_quota('competitor_analysis');
  if (r ->> 'reason') <> 'plan_upgrade_required' then
    raise exception 'esperado plan_upgrade_required, veio %', r;
  end if;
  raise notice 'OK  recurso bloqueado no plano devolve %', r ->> 'reason';
end $$;

-- A quota da Ana não pode ter afetado a do Bruno.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare r jsonb;
begin
  r := quota_status();
  if (r -> 'features' -> 'product_search' ->> 'used')::int <> 0 then
    raise exception 'quota vazou entre usuários: %', r -> 'features' -> 'product_search';
  end if;
  raise notice 'OK  quota do segundo usuário intacta (used = 0)';
end $$;

-- ---------------------------------------------------------------------
-- RLS: Bruno não pode enxergar nem apagar o monitor da Ana.
-- ---------------------------------------------------------------------
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into tracked_items (user_id, item_id) values
  ('11111111-1111-1111-1111-111111111111', 'ITEM_NORMAL');

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare n int;
begin
  select count(*) into n from tracked_items;
  if n <> 0 then raise exception 'RLS furada: usuário B enxerga % item(ns) do A', n; end if;
  raise notice 'OK  RLS: usuário B não enxerga o monitor do usuário A';

  delete from tracked_items;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RLS furada: usuário B apagou % linha(s) do A', n; end if;
  raise notice 'OK  RLS: usuário B não consegue apagar dados do usuário A';
end $$;

-- Monitorar um item precisa ter subido a prioridade de coleta.
reset role;
do $$
declare p smallint;
begin
  select collect_priority into p from items where id = 'ITEM_NORMAL';
  if p <> 2 then raise exception 'trigger de prioridade falhou: esperado 2, veio %', p; end if;
  raise notice 'OK  item monitorado subiu para collect_priority = 2';
end $$;

-- ---------------------------------------------------------------------
-- EXPOSIÇÃO: o papel anônimo não pode ter nenhum privilégio.
-- ---------------------------------------------------------------------
do $$
declare n int; lista text;
begin
  select count(*), coalesce(string_agg(distinct table_name, ', '), '')
    into n, lista
    from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public';
  if n > 0 then raise exception 'anon tem % privilégio(s) em: %', n, lista; end if;
  raise notice 'OK  papel anon sem nenhum privilégio no schema public';
end $$;

-- Tabelas que nunca podem sair do servidor.
do $$
declare n int; lista text;
begin
  select count(*), coalesce(string_agg(distinct table_name, ', '), '')
    into n, lista
    from information_schema.role_table_grants
   where grantee = 'authenticated'
     and table_name in ('item_snapshots','seller_snapshots','collect_jobs','collect_log','ml_credentials');
  if n > 0 then raise exception 'authenticated alcança tabela interna: %', lista; end if;
  raise notice 'OK  snapshots, fila e credenciais fora do alcance do front';
end $$;

do $$ begin raise notice '--- segurança: todos os casos passaram ---'; end $$;
