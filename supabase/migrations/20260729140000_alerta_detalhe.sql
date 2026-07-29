-- Detalhes do alerta: listar_alertas passa a devolver antes/depois
-- para a tela de clique no Monitor.

drop function if exists listar_alertas(int);

create or replace function listar_alertas(p_limite int default 50)
returns table (
  id bigint, product_id text, nome text, dia date, tipo text,
  titulo text, detalhe text, antes numeric, depois numeric,
  lido boolean, criado_em timestamptz
)
language sql
security definer set search_path = public
as $$
  select a.id, a.product_id, p.name, a.dia, a.tipo,
         a.titulo, a.detalhe, a.antes, a.depois, a.lido, a.criado_em
    from product_alerts a
    left join catalog_products p on p.id = a.product_id
   where a.user_id = auth.uid()
   order by a.criado_em desc
   limit least(p_limite, 200)
$$;

grant execute on function listar_alertas(int) to authenticated;

notify pgrst, 'reload schema';
