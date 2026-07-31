-- =====================================================================
-- Conteúdo diário: produtos analisados na coleta do dia
-- =====================================================================

create or replace function conteudo_diario(
  p_dia      date    default null,
  p_so_novos boolean default false,
  p_limite   int     default 60,
  p_offset   int     default 0
)
returns table (
  product_id    text,
  nome          text,
  imagem        text,
  category_id   text,
  categoria     text,
  posicao       int,
  preco_mediano numeric,
  concorrentes  int,
  vendedores    int,
  novo          boolean,
  delta_7d      int,
  momentum      text
)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_dia date := coalesce(
    p_dia,
    (now() at time zone 'America/Sao_Paulo')::date
  );
begin
  return query
  with hoje as (
    -- melhor posição do produto no dia (pode aparecer em várias categorias)
    select distinct on (s.product_id)
           s.product_id,
           s.position,
           s.category_id
      from product_rank_snapshots s
     where s.captured_date = v_dia
     order by s.product_id, s.position asc
  ),
  flag as (
    select h.product_id,
           not exists (
             select 1 from product_rank_snapshots a
              where a.product_id = h.product_id
                and a.captured_date < v_dia
           ) as eh_novo
      from hoje h
  )
  select
    h.product_id,
    coalesce(v.name, p.name, h.product_id) as nome,
    coalesce(v.picture, p.picture) as imagem,
    coalesce(v.category_id, h.category_id) as category_id,
    coalesce(v.category_name, c.name) as categoria,
    h.position::int as posicao,
    v.median_price as preco_mediano,
    v.listings::int as concorrentes,
    v.sellers::int as vendedores,
    f.eh_novo as novo,
    v.delta_7d::int as delta_7d,
    v.momentum
  from hoje h
  join flag f on f.product_id = h.product_id
  left join catalog_products p on p.id = h.product_id
  left join product_search_view v on v.product_id = h.product_id
  left join categories c on c.id = coalesce(v.category_id, h.category_id)
  where (not coalesce(p_so_novos, false) or f.eh_novo)
  order by
    case when f.eh_novo then 0 else 1 end,
    h.position asc nulls last,
    h.product_id
  limit least(coalesce(p_limite, 60), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function contar_conteudo_diario(
  p_dia      date    default null,
  p_so_novos boolean default false
)
returns jsonb
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_dia date := coalesce(
    p_dia,
    (now() at time zone 'America/Sao_Paulo')::date
  );
  v_total int;
  v_novos int;
begin
  select count(distinct product_id)::int into v_total
    from product_rank_snapshots where captured_date = v_dia;

  select count(*)::int into v_novos
    from (
      select distinct product_id
        from product_rank_snapshots
       where captured_date = v_dia
    ) hoje
   where not exists (
     select 1 from product_rank_snapshots a
      where a.product_id = hoje.product_id
        and a.captured_date < v_dia
   );

  return jsonb_build_object(
    'dia', v_dia,
    'total', v_total,
    'novos', v_novos,
    'filtrado', case when p_so_novos then v_novos else v_total end
  );
end;
$$;

grant execute on function conteudo_diario(date, boolean, int, int) to authenticated;
grant execute on function contar_conteudo_diario(date, boolean) to authenticated;

notify pgrst, 'reload schema';
