-- =====================================================================
-- 005_grants.sql — quem enxerga o quê pela API pública
--
-- Esta migration assume que "Automatically expose new tables" está
-- DESMARCADO na criação do projeto. Sem esse padrão automático, nada
-- fica acessível até ser liberado aqui — o que torna este arquivo a
-- fonte única da verdade sobre exposição.
--
-- Por que isso importa mais do que parece: RLS protege LINHAS de
-- tabelas. Materialized view não tem RLS. Se item_metrics e
-- category_metrics ficarem expostas ao papel anon, qualquer pessoa com
-- a chave pública do projeto (que vive no JavaScript do front, visível
-- no DevTools) baixa sua base inteira com um curl. É o produto indo
-- embora de graça.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Visitante não logado não enxerga nada.
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

-- ---------------------------------------------------------------------
-- 2) Usuário logado: só o necessário, e só leitura no dado de mercado.
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;

-- Dimensões de mercado (RLS já limita a SELECT em 003)
grant select on categories to authenticated;
grant select on items      to authenticated;
grant select on sellers    to authenticated;
grant select on plans      to authenticated;

-- Views de produto — é daqui que as telas leem
grant select on item_search_view      to authenticated;
grant select on item_trend            to authenticated;
grant select on category_opportunity  to authenticated;
grant select on category_seasonality  to authenticated;

-- Materialized views. Sem RLS por natureza: quem tem SELECT lê tudo.
-- Aceitável enquanto o app é seu; antes de abrir cadastro público,
-- troque por funções RPC que chamam consume_quota() antes de devolver
-- as linhas. Ver nota no fim deste arquivo.
grant select on item_daily_sales  to authenticated;
grant select on item_metrics      to authenticated;
grant select on category_metrics  to authenticated;

-- Dado do próprio usuário (RLS em 003 restringe às linhas dele)
grant select, insert, update, delete on tracked_items      to authenticated;
grant select, insert, update, delete on tracked_folders    to authenticated;
grant select, insert, update, delete on tracked_sellers    to authenticated;
grant select, insert, update, delete on calculator_presets to authenticated;

grant select         on usage_counters to authenticated;
grant select, update on profiles       to authenticated;

-- ---------------------------------------------------------------------
-- 3) Funções: só as duas que o front precisa chamar.
-- ---------------------------------------------------------------------
revoke all on function consume_quota(text, int)   from public, anon;
revoke all on function quota_status()             from public, anon;
grant execute on function consume_quota(text, int) to authenticated;
grant execute on function quota_status()           to authenticated;

-- Estas são do coletor. Nenhum usuário chama.
revoke all on function refresh_metrics(boolean)  from public, anon, authenticated;
revoke all on function ensure_partitions(int)    from public, anon, authenticated;
revoke all on function claim_job()               from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4) Tabelas que NUNCA saem do servidor.
--
-- item_snapshots é a matéria-prima: exposta, alguém reconstrói suas
-- séries históricas inteiras sem pagar. O front lê item_daily_sales,
-- que já vem agregada.
--
-- ml_credentials guarda o refresh_token da aplicação.
-- ---------------------------------------------------------------------
revoke all on item_snapshots   from anon, authenticated;
revoke all on seller_snapshots from anon, authenticated;
revoke all on collect_jobs     from anon, authenticated;
revoke all on collect_log      from anon, authenticated;
revoke all on ml_credentials   from anon, authenticated;

drop policy if exists read_authenticated on item_snapshots;

alter table seller_snapshots enable row level security;
alter table collect_jobs     enable row level security;
alter table collect_log      enable row level security;

-- ---------------------------------------------------------------------
-- 5) Conferência. Rode depois do db push:
--
--   select table_name, privilege_type
--     from information_schema.role_table_grants
--    where grantee = 'anon' and table_schema = 'public';
--
-- Tem que voltar VAZIO. Se aparecer qualquer linha, a opção
-- "Automatically expose new tables" ficou ligada — desligue em
-- Settings > API e rode esta migration de novo.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- PENDÊNCIA CONHECIDA, antes de abrir cadastro público
--
-- Hoje um usuário do plano gratuito consegue, via API, paginar
-- item_metrics inteira e levar a base sem gastar quota — porque a quota
-- é checada no front, e o front não é confiável.
--
-- A correção é trocar o SELECT direto por RPC:
--
--   create function search_items(filtros jsonb)
--   returns setof item_search_view
--   language plpgsql security definer as $$
--   begin
--     if not (consume_quota('product_search') ->> 'allowed')::boolean then
--       raise exception 'quota esgotada' using errcode = 'P0001';
--     end if;
--     return query select * from item_search_view where ...;
--   end $$;
--
-- Aí revoga-se o SELECT nas views e libera-se só o execute da função.
-- Fica para quando a tela de busca existir no Lovable.
-- ---------------------------------------------------------------------
