-- Foto do anuncio no momento do pedido.
-- Antes o pedido guardava so o MLB e a tela ficava sem nada ate a coleta
-- rodar. A extensao ja le titulo, imagem, preco e vendidos da pagina que o
-- usuario esta olhando; guardar isso custa uma coluna.
-- E FOTO, nao dado vivo: a tela mostra a data e troca por dado real depois.
alter table collect_requests add column if not exists snapshot jsonb;

-- Assinatura muda, entao precisa de drop: com "create or replace" o Postgres
-- criaria uma SEGUNDA funcao e o PostgREST nao saberia qual chamar.
drop function if exists solicitar_coleta(text, text, text);

create or replace function solicitar_coleta(
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
  insert into collect_requests (user_id, mlb, category_id, url, snapshot)
  values (auth.uid(), p_mlb, p_categoria, p_url, p_snapshot)
  on conflict (mlb) do update set
    pedidos = collect_requests.pedidos + 1,
    category_id = coalesce(collect_requests.category_id, excluded.category_id),
    snapshot = coalesce(excluded.snapshot, collect_requests.snapshot)
  returning pedidos into v_pedidos;
  return jsonb_build_object('ok', true, 'pedidos', v_pedidos,
    'aviso', case when p_categoria is null
                  then 'sem a categoria, a coleta pode demorar mais' else null end);
end;
$$;

grant execute on function solicitar_coleta(text, text, text, jsonb) to authenticated;

drop function if exists meus_pedidos();

create or replace function meus_pedidos()
returns table (
  mlb text, category_id text, categoria text, url text,
  status text, pedidos int, criado_em timestamptz,
  atendido_em timestamptz, produto text, snapshot jsonb
)
language sql
security definer set search_path = public
as $$
  select r.mlb, r.category_id, c.name, r.url, r.status, r.pedidos,
         r.criado_em, r.atendido_em, i.catalog_product_id, r.snapshot
    from collect_requests r
    left join categories c on c.id = r.category_id
    left join items i on i.id = r.mlb
   where r.user_id = auth.uid()
   order by r.criado_em desc
$$;

grant execute on function meus_pedidos() to authenticated;
