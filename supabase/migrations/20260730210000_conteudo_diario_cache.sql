-- =====================================================================
-- Conteúdo diário rápido: cache materializado após a coleta
-- A RPC ao vivo em product_rank_snapshots (~80k produtos/dia) estoura
-- o statement_timeout do PostgREST (~3s). Servimos de uma tabela
-- preenchida no digest.
-- =====================================================================

create table if not exists daily_content_products (
  dia         date not null,
  product_id  text not null,
  category_id text,
  posicao     int  not null,
  novo        boolean not null default false,
  primary key (dia, product_id)
);

create index if not exists daily_content_dia_pos_idx
  on daily_content_products (dia, posicao, product_id);

create index if not exists daily_content_dia_novo_pos_idx
  on daily_content_products (dia, novo desc, posicao, product_id);

alter table daily_content_products enable row level security;

drop policy if exists daily_content_select on daily_content_products;
create policy daily_content_select on daily_content_products
  for select to authenticated using (true);

grant select on daily_content_products to authenticated;

-- Reconstrói o cache de um dia (coletor / digest). Não expor a authenticated.
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
    h.category_id,
    h.position::int,
    (n.product_id is not null)
  from hoje h
  left join novos n on n.product_id = h.product_id;

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

-- Lista paginada a partir do cache + enriquecimento leve (só da página).
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
      from daily_content_products d, v_dia
     where d.dia = v_dia.d
       and (not coalesce(p_so_novos, false) or d.novo)
     order by d.novo desc, d.posicao asc, d.product_id
     limit least(coalesce(p_limite, 60), 100)
     offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    p.product_id,
    coalesce(cp.name, p.product_id) as nome,
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
  left join catalog_products cp on cp.id = p.product_id
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
      count(*) filter (where novo)::int as novos
    from daily_content_products d, v_dia
    where d.dia = v_dia.d
  )
  select jsonb_build_object(
    'dia', (select d from v_dia),
    'total', c.total,
    'novos', c.novos,
    'filtrado', case when p_so_novos then c.novos else c.total end
  )
  from c;
$$;

-- Digest também atualiza o cache do conteúdo diário.
create or replace function registrar_digest_coleta(p_dia date default current_date)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_posicoes int;
  v_produtos int;
  v_novos_rank int;
  v_novos_cat int;
  v_alertas int;
  v_titulo text;
  v_detalhe text;
  v_id bigint;
  v_cache jsonb;
begin
  v_cache := atualizar_conteudo_diario(p_dia);
  v_novos_rank := coalesce((v_cache->>'novos')::int, 0);

  select count(*)::int into v_posicoes
    from product_rank_snapshots
   where captured_date = p_dia;

  select count(*)::int into v_produtos from catalog_products;

  select count(*)::int into v_novos_cat
    from catalog_products
   where (first_seen_at at time zone 'America/Sao_Paulo')::date = p_dia;

  select count(*)::int into v_alertas
    from product_alerts where dia = p_dia;

  insert into collection_digests as d (
    dia, posicoes, produtos_total, novos_ranking, novos_catalogo, alertas, atualizado_em
  ) values (
    p_dia, v_posicoes, v_produtos, v_novos_rank, v_novos_cat, v_alertas, now()
  )
  on conflict (dia) do update set
    posicoes = excluded.posicoes,
    produtos_total = excluded.produtos_total,
    novos_ranking = excluded.novos_ranking,
    novos_catalogo = excluded.novos_catalogo,
    alertas = excluded.alertas,
    atualizado_em = now();

  v_titulo := case
    when v_novos_rank = 0 and v_novos_cat = 0 then
      'Coleta do dia concluída — nenhum produto novo'
    when v_novos_rank = 1 then
      '1 produto novo entrou no ranking hoje'
    else
      v_novos_rank || ' produtos novos entraram no ranking hoje'
  end;

  v_detalhe := format(
    'Catálogo: %s novo(s). Posições lidas: %s. Alertas do Monitor: %s.',
    v_novos_cat, v_posicoes, v_alertas
  );

  insert into system_notifications (dia, tipo, titulo, detalhe, payload)
  values (
    p_dia, 'coleta_diaria', v_titulo, v_detalhe,
    jsonb_build_object(
      'novos_ranking', v_novos_rank,
      'novos_catalogo', v_novos_cat,
      'posicoes', v_posicoes,
      'produtos_total', v_produtos,
      'alertas', v_alertas
    )
  )
  on conflict (dia, tipo) do update set
    titulo = excluded.titulo,
    detalhe = excluded.detalhe,
    payload = excluded.payload,
    criado_em = now()
  returning id into v_id;

  delete from system_notification_reads where notification_id = v_id;

  return jsonb_build_object(
    'ok', true,
    'dia', p_dia,
    'posicoes', v_posicoes,
    'produtos_total', v_produtos,
    'novos_ranking', v_novos_rank,
    'novos_catalogo', v_novos_cat,
    'alertas', v_alertas,
    'notification_id', v_id,
    'titulo', v_titulo,
    'detalhe', v_detalhe,
    'conteudo_diario', v_cache
  );
end;
$$;

revoke all on function registrar_digest_coleta(date) from public, anon, authenticated;

grant execute on function conteudo_diario(date, boolean, int, int) to authenticated;
grant execute on function contar_conteudo_diario(date, boolean) to authenticated;

notify pgrst, 'reload schema';
