-- monitorar_produto() nunca recebia o snapshot que a extensao ja
-- capturou no pedido (collect_requests.snapshot) -- por isso
-- tracked_products.snapshot ficava sempre nulo, mesmo quando o produto
-- veio da fila com vendidos/preco/dias_no_ar reais lidos da pagina.
-- Novo parametro no FIM, com default -- mas Postgres so troca a funcao
-- com "create or replace" se a assinatura for IDENTICA. Parametro novo
-- cria uma SEGUNDA funcao (2 args e 3 args coexistindo) e todo select
-- vira "could not choose a best candidate function". Precisa dropar
-- a antiga primeiro (mesma armadilha ja documentada varias vezes aqui).
drop function if exists monitorar_produto(text, text);

create or replace function monitorar_produto(p_produto text, p_nota text default null, p_snapshot jsonb default null)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_plano text;
  v_lim   int;
  v_atual int;
  v_pos   int;
  v_preco numeric;
begin
  if v_user is null then raise exception 'nao autenticado' using errcode = '28000'; end if;

  select plan into v_plano from profiles where id = v_user;
  select coalesce((limits ->> 'tracked_items')::int, 0) into v_lim
    from plans where code = coalesce(v_plano, 'free');
  select count(*) into v_atual from tracked_products where user_id = v_user;

  if v_lim >= 0 and v_atual >= v_lim then
    return jsonb_build_object('ok', false, 'motivo', 'limite_do_plano',
                              'limite', v_lim, 'usados', v_atual);
  end if;

  select position into v_pos from product_rank_snapshots
   where product_id = p_produto order by captured_at desc limit 1;
  select median_price into v_preco from product_competition where product_id = p_produto;

  insert into tracked_products (user_id, product_id, nota, pos_inicial, preco_inicial, snapshot)
  values (v_user, p_produto, p_nota, v_pos, v_preco, p_snapshot)
  on conflict (user_id, product_id) do update set
    snapshot = coalesce(tracked_products.snapshot, excluded.snapshot);

  return jsonb_build_object('ok', true, 'usados', v_atual + 1,
                            'limite', v_lim, 'pos_inicial', v_pos);
end;
$$;

grant execute on function monitorar_produto(text, text, jsonb) to authenticated;
