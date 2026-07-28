-- =====================================================================
-- Corrige "Fora do alcance da coleta" falso-negativo
--
-- atenderPedidos() marcava sem_item porque /items?ids= dá 403 pra
-- terceiro (confirmado 25/07). Desde 28/07 sabemos que
-- /products/search funciona — o coletor passa a resolver o produto de
-- catálogo por esse caminho e grava product_id no pedido.
--
-- product_id na fila: permite "Monitorar" mesmo quando o MLB do anúncio
-- específico não entra em items (API de anúncio bloqueada). O que
-- monitoramos é o produto de catálogo — é o que o ranking cobre.
-- =====================================================================

alter table collect_requests
  add column if not exists product_id text references catalog_products(id);

create index if not exists creq_product_idx on collect_requests(product_id)
  where product_id is not null;

-- Pedidos já marcados sem_item voltam pra fila pra serem reprocessados
-- pelo caminho novo. Quem já tem product_id (se algum) fica.
update collect_requests
   set status = 'pendente', atendido_em = null
 where status = 'sem_item';

-- Re-pedir pela extensão reabre a fila (antes ficava preso em sem_item).
drop function if exists solicitar_coleta(text, text, text, jsonb);

create function solicitar_coleta(
  p_mlb text, p_categoria text default null,
  p_url text default null, p_snapshot jsonb default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare v_pedidos int;
begin
  if auth.uid() is null then raise exception 'nao autenticado' using errcode = '28000'; end if;
  insert into collect_requests (user_id, mlb, category_id, url, snapshot, status)
  values (auth.uid(), p_mlb, p_categoria, p_url, p_snapshot, 'pendente')
  on conflict (mlb) do update set
    pedidos = collect_requests.pedidos + 1,
    category_id = coalesce(excluded.category_id, collect_requests.category_id),
    snapshot = coalesce(excluded.snapshot, collect_requests.snapshot),
    url = coalesce(excluded.url, collect_requests.url),
    -- Reabrir: se estava sem_item/sem_destaque, tenta de novo.
    status = case
      when collect_requests.status in ('sem_item', 'sem_destaque') then 'pendente'
      else collect_requests.status
    end,
    atendido_em = case
      when collect_requests.status in ('sem_item', 'sem_destaque') then null
      else collect_requests.atendido_em
    end
  returning pedidos into v_pedidos;
  return jsonb_build_object('ok', true, 'pedidos', v_pedidos,
    'aviso', case when p_categoria is null
                  then 'sem a categoria, a coleta pode demorar mais' else null end);
end;
$$;

grant execute on function solicitar_coleta(text, text, text, jsonb) to authenticated;

drop function if exists meus_pedidos();

create function meus_pedidos()
returns table (
  mlb text, category_id text, categoria text, url text,
  status text, pedidos int, criado_em timestamptz,
  atendido_em timestamptz, produto text, snapshot jsonb
)
language sql
security definer set search_path = public
as $$
  select r.mlb, r.category_id, c.name, r.url, r.status, r.pedidos,
         r.criado_em, r.atendido_em,
         -- Preferência: anúncio já linkado → product_id do pedido →
         -- o próprio mlb se for id de catálogo (página /p/...).
         coalesce(i.catalog_product_id, r.product_id, cp.id) as produto,
         r.snapshot
    from collect_requests r
    left join categories c on c.id = r.category_id
    left join items i on i.id = r.mlb
    left join catalog_products cp on cp.id = r.mlb
   where r.user_id = auth.uid()
   order by r.criado_em desc
$$;

grant execute on function meus_pedidos() to authenticated;
