-- Pedidos de coleta visíveis para quem pediu.
-- collect_requests tem "revoke all from authenticated" de propósito: é uma
-- fila operacional e ninguém deve paginar os pedidos dos outros. Mas quem
-- pediu precisa acompanhar o próprio pedido.
create or replace function meus_pedidos()
returns table (
  mlb text, category_id text, categoria text, url text,
  status text, pedidos int, criado_em timestamptz,
  atendido_em timestamptz, produto text
)
language sql
security definer set search_path = public
as $$
  select r.mlb, r.category_id, c.name, r.url, r.status, r.pedidos,
         r.criado_em, r.atendido_em, i.catalog_product_id
    from collect_requests r
    left join categories c on c.id = r.category_id
    left join items i on i.id = r.mlb
   where r.user_id = auth.uid()
   order by r.criado_em desc
$$;

comment on function meus_pedidos is
  'Pedidos de coleta do proprio usuario. A tabela continua fechada para leitura direta.';

grant execute on function meus_pedidos() to authenticated;
