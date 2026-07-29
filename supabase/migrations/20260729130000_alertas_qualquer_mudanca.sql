-- =====================================================================
-- Alertas: qualquer mudança nos monitorados gera aviso.
--
-- Antes: só 3+ posições, 5%+ preço, 2+ concorrentes (anti-ruído).
-- Agora: ciência de QUALQUER mudança. Continua no máximo 1 alerta por
-- (user, produto, tipo, dia) — sem duplicata no mesmo dia.
-- =====================================================================

create or replace function gerar_alertas()
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  n int := 0;
begin
  -- ---- posição: qualquer variação ----
  with duas as (
    select
      d.product_id,
      d.captured_date,
      d.position,
      row_number() over (partition by d.product_id order by d.captured_date desc) as r
    from product_rank_daily d
    where d.product_id in (select product_id from tracked_products)
  ),
  cmp as (
    select
      h.product_id,
      h.captured_date as dia,
      o.position as antes,
      h.position as depois
    from duas h
    join duas o on o.product_id = h.product_id and o.r = 2
    where h.r = 1 and o.position is distinct from h.position
  ),
  ins as (
    insert into product_alerts (user_id, product_id, dia, tipo, titulo, detalhe, antes, depois)
    select
      t.user_id, c.product_id, c.dia,
      case
        when c.antes > 10 and c.depois <= 10 then 'entrou_top10'
        when c.antes <= 10 and c.depois > 10 then 'saiu_top10'
        when c.antes > c.depois              then 'subiu'
        when c.depois > c.antes              then 'caiu'
      end,
      case
        when c.antes > 10 and c.depois <= 10 then 'Entrou no top 10'
        when c.antes <= 10 and c.depois > 10 then 'Saiu do top 10'
        when c.antes > c.depois then
          case when (c.antes - c.depois) = 1 then 'Subiu 1 posição'
               else 'Subiu ' || (c.antes - c.depois) || ' posições' end
        when c.depois > c.antes then
          case when (c.depois - c.antes) = 1 then 'Caiu 1 posição'
               else 'Caiu ' || (c.depois - c.antes) || ' posições' end
      end,
      'De ' || c.antes || 'º para ' || c.depois || 'º',
      c.antes, c.depois
    from cmp c
    join tracked_products t on t.product_id = c.product_id
    on conflict (user_id, product_id, tipo, dia) do nothing
    returning 1
  )
  select count(*) into n from ins;

  -- ---- preço + concorrência ----
  with duas as (
    select
      p.product_id, p.dia, p.preco_mediano, p.anuncios,
      row_number() over (partition by p.product_id order by p.dia desc) as r
    from product_price_daily p
    where p.product_id in (select product_id from tracked_products)
  ),
  cmp as (
    select h.product_id, h.dia, o.preco_mediano as antes, h.preco_mediano as depois,
           o.anuncios as ant_anuncios, h.anuncios as dep_anuncios
    from duas h join duas o on o.product_id = h.product_id and o.r = 2
    where h.r = 1
  ),
  ins2 as (
    insert into product_alerts (user_id, product_id, dia, tipo, titulo, detalhe, antes, depois)
    select
      t.user_id, c.product_id, c.dia,
      case when c.depois < c.antes then 'preco_caiu' else 'preco_subiu' end,
      case
        when c.antes > 0 and c.depois < c.antes then
          'Preço caiu ' || round(abs(c.depois - c.antes) / c.antes * 100, 1) || '%'
        when c.antes > 0 then
          'Preço subiu ' || round(abs(c.depois - c.antes) / c.antes * 100, 1) || '%'
        when c.depois < c.antes then 'Preço caiu'
        else 'Preço subiu'
      end,
      'De R$ ' || to_char(c.antes,'FM999G999D00') || ' para R$ ' || to_char(c.depois,'FM999G999D00'),
      c.antes, c.depois
    from cmp c
    join tracked_products t on t.product_id = c.product_id
    where c.antes is not null and c.depois is not null
      and c.antes is distinct from c.depois
    on conflict (user_id, product_id, tipo, dia) do nothing
    returning 1
  ),
  ins3 as (
    insert into product_alerts (user_id, product_id, dia, tipo, titulo, detalhe, antes, depois)
    select
      t.user_id, c.product_id, c.dia, 'concorrencia',
      case when c.dep_anuncios > c.ant_anuncios
           then case when (c.dep_anuncios - c.ant_anuncios) = 1 then '1 concorrente a mais'
                     else (c.dep_anuncios - c.ant_anuncios) || ' concorrente(s) a mais' end
           else case when (c.ant_anuncios - c.dep_anuncios) = 1 then '1 concorrente a menos'
                     else (c.ant_anuncios - c.dep_anuncios) || ' concorrente(s) a menos' end
      end,
      'De ' || c.ant_anuncios || ' para ' || c.dep_anuncios || ' anúncios',
      c.ant_anuncios, c.dep_anuncios
    from cmp c
    join tracked_products t on t.product_id = c.product_id
    where c.ant_anuncios is distinct from c.dep_anuncios
    on conflict (user_id, product_id, tipo, dia) do nothing
    returning 1
  )
  select n + (select count(*) from ins2) + (select count(*) from ins3) into n;

  return n;
end;
$$;

revoke all on function gerar_alertas() from public, anon, authenticated;

notify pgrst, 'reload schema';
