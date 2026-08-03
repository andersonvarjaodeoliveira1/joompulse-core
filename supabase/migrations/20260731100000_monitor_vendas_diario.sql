-- =====================================================================
-- Vendas no Monitor: histórico + atualização via extensão + alerta
--
-- A API do ML NÃO entrega sold_quantity de anúncio de terceiro.
-- O número de "vendidos" só vem da leitura da página (extensão).
-- Aqui: gravamos histórico a cada leitura, geramos alerta se mudou,
-- e a coleta diária atualiza vendas do VENDEDOR (transactions_total)
-- dos vendedores ligados aos monitorados — único sinal diário via API.
-- =====================================================================

create table if not exists tracked_sales_daily (
  user_id    uuid not null references profiles(id) on delete cascade,
  product_id text not null,
  dia        date not null,
  vendidos   bigint,
  aprox      boolean not null default false,
  preco      numeric,
  receita    numeric,
  lido_em    timestamptz not null default now(),
  primary key (user_id, product_id, dia)
);

create index if not exists tracked_sales_prod_idx
  on tracked_sales_daily (user_id, product_id, dia desc);

alter table tracked_sales_daily enable row level security;

drop policy if exists tracked_sales_own on tracked_sales_daily;
create policy tracked_sales_own on tracked_sales_daily
  for select to authenticated
  using (user_id = auth.uid());

grant select on tracked_sales_daily to authenticated;

-- Atualiza snapshot do monitor + histórico do dia + alerta se vendidos mudou.
create or replace function atualizar_vendas_monitor(
  p_produto  text,
  p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
  v_vendidos bigint;
  v_aprox boolean;
  v_preco numeric;
  v_antes bigint;
  v_alert boolean := false;
begin
  if v_user is null then raise exception 'nao autenticado' using errcode = '28000'; end if;
  if p_produto is null or btrim(p_produto) = '' then
    return jsonb_build_object('ok', false, 'erro', 'produto_obrigatorio');
  end if;
  if not exists (
    select 1 from tracked_products
     where user_id = v_user and product_id = p_produto
  ) then
    return jsonb_build_object('ok', false, 'erro', 'nao_monitorado');
  end if;

  v_vendidos := nullif(p_snapshot->>'vendidos', '')::bigint;
  v_aprox := coalesce((p_snapshot->>'aprox')::boolean, false);
  v_preco := nullif(p_snapshot->>'preco', '')::numeric;

  select vendidos into v_antes
    from tracked_sales_daily
   where user_id = v_user and product_id = p_produto
   order by dia desc
   limit 1;

  update tracked_products
     set snapshot = coalesce(p_snapshot, snapshot)
   where user_id = v_user and product_id = p_produto;

  insert into tracked_sales_daily as s
    (user_id, product_id, dia, vendidos, aprox, preco, receita, lido_em)
  values (
    v_user, p_produto, v_dia, v_vendidos, v_aprox, v_preco,
    case when v_vendidos is not null and v_preco is not null
         then v_vendidos * v_preco else null end,
    now()
  )
  on conflict (user_id, product_id, dia) do update set
    vendidos = excluded.vendidos,
    aprox = excluded.aprox,
    preco = excluded.preco,
    receita = excluded.receita,
    lido_em = now();

  if v_vendidos is not null and v_antes is not null and v_vendidos is distinct from v_antes then
    insert into product_alerts (user_id, product_id, dia, tipo, titulo, detalhe, antes, depois)
    values (
      v_user, p_produto, v_dia,
      case when v_vendidos > v_antes then 'vendas_subiu' else 'vendas_caiu' end,
      case when v_vendidos > v_antes
           then 'Vendidos subiu (leitura da página)'
           else 'Vendidos caiu (leitura da página)' end,
      'De ' || v_antes || ' para ' || v_vendidos ||
        case when v_aprox then ' (arredondado pelo ML)' else '' end,
      v_antes, v_vendidos
    )
    on conflict (user_id, product_id, tipo, dia) do nothing;
    v_alert := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'dia', v_dia,
    'vendidos', v_vendidos,
    'antes', v_antes,
    'alerta', v_alert
  );
end;
$$;

grant execute on function atualizar_vendas_monitor(text, jsonb) to authenticated;

-- listar_monitorados passa a expor vendas da última leitura + dia anterior
drop function if exists listar_monitorados();
create function listar_monitorados()
returns table (
  product_id text, nome text, imagem text, categoria text, nota text,
  pos_inicial int, pos_atual int, delta_desde_inicio int,
  preco_inicial numeric, preco_atual numeric, variacao_preco numeric,
  concorrentes int, dias_no_top10 int, dias_observados int,
  alertas_novos bigint, criado_em timestamptz, snapshot jsonb,
  vendidos bigint, vendidos_aprox boolean, vendidos_preco numeric,
  vendas_lido_em timestamptz, vendidos_anterior bigint, delta_vendidos bigint
)
language sql
security definer set search_path = public
as $$
  with ult as (
    select distinct on (s.product_id)
           s.product_id, s.vendidos, s.aprox, s.preco, s.lido_em, s.dia
      from tracked_sales_daily s
     where s.user_id = auth.uid()
     order by s.product_id, s.dia desc
  ),
  ant as (
    select distinct on (s.product_id)
           s.product_id, s.vendidos
      from tracked_sales_daily s
      join ult u on u.product_id = s.product_id
     where s.user_id = auth.uid()
       and s.dia < u.dia
     order by s.product_id, s.dia desc
  )
  select
    t.product_id,
    p.name,
    p.picture,
    c.name,
    t.nota,
    t.pos_inicial,
    m.position_now,
    case when t.pos_inicial is not null and m.position_now is not null
         then t.pos_inicial - m.position_now end,
    t.preco_inicial,
    k.median_price,
    case when t.preco_inicial > 0 and k.median_price is not null
         then round((k.median_price - t.preco_inicial) / t.preco_inicial, 4) end,
    k.listings,
    m.days_in_top10,
    m.days_observed,
    (select count(*) from product_alerts a
      where a.user_id = t.user_id and a.product_id = t.product_id and not a.lido),
    t.criado_em,
    t.snapshot,
    coalesce(u.vendidos, nullif(t.snapshot->>'vendidos','')::bigint),
    coalesce(u.aprox, (t.snapshot->>'aprox')::boolean),
    coalesce(u.preco, nullif(t.snapshot->>'preco','')::numeric),
    coalesce(u.lido_em, nullif(t.snapshot->>'lido_em','')::timestamptz),
    a.vendidos,
    case when coalesce(u.vendidos, nullif(t.snapshot->>'vendidos','')::bigint) is not null
              and a.vendidos is not null
         then coalesce(u.vendidos, nullif(t.snapshot->>'vendidos','')::bigint) - a.vendidos
         else null end
  from tracked_products t
  left join catalog_products p      on p.id = t.product_id
  left join categories c            on c.id = p.category_id
  left join product_rank_metrics m  on m.product_id = t.product_id
  left join product_competition k   on k.product_id = t.product_id
  left join ult u                   on u.product_id = t.product_id
  left join ant a                   on a.product_id = t.product_id
  where t.user_id = auth.uid()
  order by t.criado_em desc
$$;

grant execute on function listar_monitorados() to authenticated;

-- Seed: se já tem snapshot com vendidos, cria 1 ponto no histórico
insert into tracked_sales_daily (user_id, product_id, dia, vendidos, aprox, preco, receita, lido_em)
select
  t.user_id,
  t.product_id,
  coalesce(
    (nullif(t.snapshot->>'lido_em','')::timestamptz at time zone 'America/Sao_Paulo')::date,
    (t.criado_em at time zone 'America/Sao_Paulo')::date,
    (now() at time zone 'America/Sao_Paulo')::date
  ),
  nullif(t.snapshot->>'vendidos','')::bigint,
  coalesce((t.snapshot->>'aprox')::boolean, false),
  nullif(t.snapshot->>'preco','')::numeric,
  case
    when nullif(t.snapshot->>'vendidos','') is not null
     and nullif(t.snapshot->>'preco','') is not null
    then (t.snapshot->>'vendidos')::bigint * (t.snapshot->>'preco')::numeric
    else null
  end,
  coalesce(nullif(t.snapshot->>'lido_em','')::timestamptz, t.criado_em, now())
from tracked_products t
where t.snapshot ? 'vendidos'
  and nullif(t.snapshot->>'vendidos','') is not null
on conflict do nothing;

notify pgrst, 'reload schema';
