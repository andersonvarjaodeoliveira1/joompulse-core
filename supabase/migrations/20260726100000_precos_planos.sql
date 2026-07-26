-- =====================================================================
-- 100_precos_planos.sql
--
-- plans tinha limites (product_search, rows_full etc.) mas nenhum
-- preco -- nao dava pra montar uma tela de assinatura sem inventar
-- numero direto no front. Valores abaixo sao PLACEHOLDER (o usuario
-- pediu pra usar exemplo por agora) -- trocar quando o preco real for
-- decidido, e um update simples, sem migration nova.
--
-- price_annual_month = quanto cobra por mes se pagar o ano todo de uma
-- vez (os 50% de desconto do "Salvar 50%" da referencia). O total
-- cobrado uma vez por ano e price_annual_month * 12.
-- =====================================================================
alter table plans
  add column if not exists price_monthly numeric,
  add column if not exists price_annual_month numeric;

update plans set price_monthly = 0,   price_annual_month = 0   where code = 'free';
update plans set price_monthly = 97,  price_annual_month = 48.50  where code = 'starter';
update plans set price_monthly = 197, price_annual_month = 98.50  where code = 'pro';
update plans set price_monthly = 397, price_annual_month = 198.50 where code = 'business';

comment on column plans.price_monthly is 'Preco mensal, placeholder -- ver comentario no topo do arquivo.';
comment on column plans.price_annual_month is 'Preco mensal equivalente cobrando o ano todo de uma vez (com desconto).';

-- ---------------------------------------------------------------------
-- Lista os planos pra tela de assinatura. plans nao tinha nenhuma RPC
-- de leitura -- so grant select direto seria simples, mas manter o
-- padrao "front so le por RPC" evita ter que lembrar de revisar grant
-- de tabela se um dia plans ganhar coluna sensivel.
-- ---------------------------------------------------------------------
create or replace function listar_planos()
returns table (
  code text, price_monthly numeric, price_annual_month numeric, limits jsonb
)
language sql
security definer set search_path = public
as $$
  select code, price_monthly, price_annual_month, limits
    from plans
   where code <> 'free'
   order by price_monthly asc nulls first
$$;

grant execute on function listar_planos() to authenticated;
