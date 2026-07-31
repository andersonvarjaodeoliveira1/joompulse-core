-- Exclui do conteúdo diário produtos sem foto e sem nome real.
create or replace function atualizar_conteudo_diario(p_dia date default null)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_dia date := coalesce(
    p_dia,
    (select max(captured_date) from product_rank_snapshots),
    (now() at time zone 'America/Sao_Paulo')::date
  );
  v_total int;
  v_novos int;
begin
  delete from daily_content_products where dia = v_dia;

  insert into daily_content_products (dia, product_id, category_id, posicao, novo)
  with hoje as (
    select distinct on (s.product_id)
           s.product_id,
           s.position,
           s.category_id
      from product_rank_snapshots s
     where s.captured_date = v_dia
     order by s.product_id, s.position asc
  ),
  novos as (
    select product_id
      from product_rank_snapshots
     where captured_date = v_dia
    except
    select product_id
      from product_rank_snapshots
     where captured_date < v_dia
  )
  select
    v_dia,
    h.product_id,
    coalesce(cp.category_id, h.category_id),
    h.position::int,
    (n.product_id is not null)
  from hoje h
  join catalog_products cp on cp.id = h.product_id
  left join novos n on n.product_id = h.product_id
  where
    -- precisa ter foto OU nome de verdade (não o próprio MLB…)
    (
      (cp.picture is not null and btrim(cp.picture) <> '')
      or (
        cp.name is not null
        and btrim(cp.name) <> ''
        and btrim(cp.name) <> h.product_id
      )
    );

  select count(*)::int,
         count(*) filter (where novo)::int
    into v_total, v_novos
    from daily_content_products
   where dia = v_dia;

  return jsonb_build_object(
    'dia', v_dia,
    'total', v_total,
    'novos', v_novos
  );
end;
$$;

revoke all on function atualizar_conteudo_diario(date) from public, anon, authenticated;

-- Rede de segurança na leitura (cache antigo ainda no ar).
drop function if exists conteudo_diario(date, boolean, int, int);
create function conteudo_diario(
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
  momentum      text,
  dia           date
)
language sql
security definer set search_path = public
stable
as $$
  with v_dia as (
    select coalesce(
      p_dia,
      (select max(dia) from daily_content_products),
      (now() at time zone 'America/Sao_Paulo')::date
    ) as d
  ),
  page as (
    select d.product_id, d.category_id, d.posicao, d.novo, d.dia
      from daily_content_products d
      join catalog_products cp on cp.id = d.product_id
      , v_dia
     where d.dia = v_dia.d
       and (not coalesce(p_so_novos, false) or d.novo)
       and (
         (cp.picture is not null and btrim(cp.picture) <> '')
         or (
           cp.name is not null
           and btrim(cp.name) <> ''
           and btrim(cp.name) <> d.product_id
         )
       )
     order by d.novo desc, d.posicao asc, d.product_id
     limit least(coalesce(p_limite, 60), 100)
     offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    p.product_id,
    cp.name as nome,
    cp.picture as imagem,
    coalesce(cp.category_id, p.category_id) as category_id,
    c.name as categoria,
    p.posicao,
    k.median_price as preco_mediano,
    k.listings::int as concorrentes,
    k.sellers::int as vendedores,
    p.novo,
    m.delta_7d::int as delta_7d,
    m.momentum,
    p.dia
  from page p
  join catalog_products cp on cp.id = p.product_id
  left join categories c on c.id = coalesce(cp.category_id, p.category_id)
  left join product_competition k on k.product_id = p.product_id
  left join product_momentum m on m.product_id = p.product_id
  order by p.novo desc, p.posicao asc, p.product_id;
$$;

drop function if exists contar_conteudo_diario(date, boolean);
create function contar_conteudo_diario(
  p_dia      date    default null,
  p_so_novos boolean default false
)
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  with v_dia as (
    select coalesce(
      p_dia,
      (select max(dia) from daily_content_products),
      (now() at time zone 'America/Sao_Paulo')::date
    ) as d
  ),
  c as (
    select
      count(*)::int as total,
      count(*) filter (where d.novo)::int as novos
    from daily_content_products d
    join catalog_products cp on cp.id = d.product_id
    , v_dia
    where d.dia = v_dia.d
      and (
        (cp.picture is not null and btrim(cp.picture) <> '')
        or (
          cp.name is not null
          and btrim(cp.name) <> ''
          and btrim(cp.name) <> d.product_id
        )
      )
  )
  select jsonb_build_object(
    'dia', (select d from v_dia),
    'total', c.total,
    'novos', c.novos,
    'filtrado', case when p_so_novos then c.novos else c.total end
  )
  from c;
$$;

grant execute on function conteudo_diario(date, boolean, int, int) to authenticated;
grant execute on function contar_conteudo_diario(date, boolean) to authenticated;

notify pgrst, 'reload schema';
