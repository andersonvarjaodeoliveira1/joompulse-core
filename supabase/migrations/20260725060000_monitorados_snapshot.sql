-- listar_monitorados passa a devolver a foto da pagina.
-- Assinatura muda, entao precisa de drop antes.
drop function if exists listar_monitorados();

create or replace function listar_monitorados()
returns table (
  product_id text, nome text, categoria text, nota text,
  pos_inicial int, pos_atual int, delta_desde_inicio int,
  preco_inicial numeric, preco_atual numeric, variacao_preco numeric,
  concorrentes int, dias_no_top10 int, dias_observados int,
  alertas_novos bigint, criado_em timestamptz, snapshot jsonb
)
language sql
security definer set search_path = public
as $$
  select
    t.product_id, p.name, c.name, t.nota, t.pos_inicial, m.position_now,
    case when t.pos_inicial is not null and m.position_now is not null
         then t.pos_inicial - m.position_now end,
    t.preco_inicial, k.median_price,
    case when t.preco_inicial > 0 and k.median_price is not null
         then round((k.median_price - t.preco_inicial) / t.preco_inicial, 4) end,
    k.listings, m.days_in_top10, m.days_observed,
    (select count(*) from product_alerts a
      where a.user_id = t.user_id and a.product_id = t.product_id and not a.lido),
    t.criado_em, t.snapshot
  from tracked_products t
  left join catalog_products p on p.id = t.product_id
  left join categories c on c.id = p.category_id
  left join product_rank_metrics m on m.product_id = t.product_id
  left join product_competition k on k.product_id = t.product_id
 where t.user_id = auth.uid()
 order by t.criado_em desc
$$;

grant execute on function listar_monitorados() to authenticated;
