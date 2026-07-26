-- =====================================================================
-- 090_excluir_pedido.sql
--
-- A aba "Aguardando coleta" do Monitor nao tinha jeito de tirar um
-- pedido da fila -- pediu sem querer, ou nao interessa mais, e ficava
-- preso ali pra sempre. collect_requests tem "revoke all from
-- authenticated" (so RPC mexe nela), entao precisa de uma funcao nova.
--
-- mlb nao e unico por usuario (e unico pra tabela inteira -- ver
-- solicitar_coleta), e user_id fica travado no primeiro que pediu.
-- meus_pedidos() ja filtra por user_id = auth.uid(), entao quem
-- consegue VER o pedido na propria fila e, por definicao, o dono —
-- a mesma checagem entra aqui.
-- =====================================================================
create or replace function excluir_pedido(p_mlb text)
returns void
language sql
security definer set search_path = public
as $$
  delete from collect_requests where user_id = auth.uid() and mlb = p_mlb
$$;

grant execute on function excluir_pedido(text) to authenticated;
