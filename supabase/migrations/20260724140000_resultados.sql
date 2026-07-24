-- =====================================================================
-- 013_resultados.sql — linhas visíveis e ações em lote
-- =====================================================================

-- Quantas linhas do resultado aparecem sem desfoque. As demais são
-- mostradas borradas: o usuário vê a forma do dado e sabe o que está
-- perdendo, em vez de olhar para uma lista vazia.
update plans set limits = limits || jsonb_build_object('rows_full',
  case code when 'free' then 5 when 'starter' then 50
            when 'pro' then 200 else -1 end);

/**
 * Monitora vários produtos de uma vez, respeitando o teto do plano.
 * Devolve o que entrou e o que sobrou de fora, em vez de falhar inteiro
 * no primeiro que estourar o limite.
 */
create or replace function monitorar_lote(p_produtos text[])
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_lim   int;
  v_atual int;
  v_ok    int := 0;
  v_fora  int := 0;
  p       text;
begin
  if v_user is null then raise exception 'nao autenticado' using errcode = '28000'; end if;

  select coalesce((pl.limits ->> 'tracked_items')::int, 0) into v_lim
    from profiles pr join plans pl on pl.code = pr.plan where pr.id = v_user;
  select count(*) into v_atual from tracked_products where user_id = v_user;

  foreach p in array p_produtos loop
    if v_lim >= 0 and v_atual >= v_lim then v_fora := v_fora + 1; continue; end if;
    insert into tracked_products (user_id, product_id, pos_inicial)
    select v_user, p, (select position from product_rank_snapshots
                        where product_id = p order by captured_at desc limit 1)
    on conflict (user_id, product_id) do nothing;
    if found then v_ok := v_ok + 1; v_atual := v_atual + 1; end if;
  end loop;

  return jsonb_build_object('adicionados', v_ok, 'fora_do_limite', v_fora,
                            'total', v_atual, 'limite', v_lim);
end;
$$;

grant execute on function monitorar_lote(text[]) to authenticated;
