-- =====================================================================
-- 010_filtros.sql — busca avançada
--
-- O JoomPulse filtra por receita, volume de vendas e ticket médio.
-- Nada disso existe aqui: dependem de sold_quantity, que a API não
-- entrega para anúncio de terceiro.
--
-- O que existe, e eles não têm: filtro por MOVIMENTO no ranking e por
-- ESTRUTURA DE CONCORRÊNCIA. Um vendedor que procura "produto subindo
-- há 7 dias com menos de 5 concorrentes" está fazendo uma pergunta mais
-- precisa do que "produto com receita acima de X".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Seletor de categoria.
--
-- São 12 mil categorias. Um <select> com tudo é inutilizável, então o
-- front usa busca por texto e navegação pela árvore.
-- ---------------------------------------------------------------------
create or replace function buscar_categorias(p_texto text, p_limite int default 30)
returns table (id text, nome text, caminho text, produtos int)
language sql
security definer set search_path = public
as $$
  select c.id,
         c.name,
         array_to_string(c.path_names, ' › '),
         coalesce(m.produtos_rankeados, 0)
    from categories c
    left join category_rank_metrics m on m.category_id = c.id
   where c.is_leaf
     and (p_texto is null or c.name ilike '%' || p_texto || '%')
     and coalesce(m.produtos_rankeados, 0) > 0
   order by coalesce(m.produtos_rankeados, 0) desc, c.name
   limit least(p_limite, 100)
$$;

/** Categorias raiz, para navegar de cima para baixo. */
create or replace function categorias_raiz()
returns table (id text, nome text, produtos bigint)
language sql
security definer set search_path = public
as $$
  select r.id, r.name,
         (select count(*) from category_rank_metrics m
           join categories f on f.id = m.category_id
          where f.root_id = r.id)
    from categories r
   where r.level = 0
   order by r.name
$$;

-- ---------------------------------------------------------------------
-- 2) BUSCA AVANÇADA
--
-- Assinatura nova, então a antiga precisa cair antes.
--
-- Todos os parâmetros são opcionais e nulos por padrão: o front manda
-- só o que o usuário preencheu, e a função ignora o resto. Isso evita
-- ter que montar SQL dinâmico no cliente, que é onde nasce injeção.
-- ---------------------------------------------------------------------
drop function if exists buscar_produtos(text,text,numeric,numeric,text,int,int,int);

create or replace function buscar_produtos(
  -- produto
  p_categoria     text    default null,
  p_raiz          text    default null,   -- filtra pela categoria raiz
  p_texto         text    default null,
  p_pos_min       int     default null,
  p_pos_max       int     default null,
  p_melhor_pos    int     default null,   -- já esteve pelo menos em Nº
  -- preço
  p_preco_min     numeric default null,
  p_preco_max     numeric default null,
  -- movimento
  p_momentum      text    default null,
  p_delta_min     int     default null,   -- subiu ao menos N posições em 7d
  p_consistencia  text    default null,
  p_top10_min     int     default null,   -- ao menos N dias no top 10
  p_dias_min      int     default null,   -- ao menos N dias observados
  -- concorrência
  p_conc_min      int     default null,
  p_conc_max      int     default null,
  p_dispersao_min numeric default null,   -- diferença entre maior e menor preço
  p_full_max      numeric default null,   -- pouca gente usando Full = brecha
  p_oficial_max   numeric default null,   -- pouca loja oficial = menos briga
  -- paginação
  p_ordem         text    default 'posicao',
  p_limite        int     default 50,
  p_offset        int     default 0
)
returns setof product_search_view
language plpgsql
security definer set search_path = public
as $$
declare q jsonb;
begin
  q := consume_quota('product_search');
  if not (q ->> 'allowed')::boolean then
    raise exception 'quota esgotada' using errcode = 'P0001', detail = q::text;
  end if;

  return query
    select v.* from product_search_view v
    left join categories c on c.id = v.category_id
    where v.position_now is not null
      and (p_categoria     is null or v.category_id = p_categoria)
      and (p_raiz          is null or c.root_id = p_raiz)
      and (p_texto         is null or v.name ilike '%' || p_texto || '%')
      and (p_pos_min       is null or v.position_now >= p_pos_min)
      and (p_pos_max       is null or v.position_now <= p_pos_max)
      and (p_melhor_pos    is null or v.best_position <= p_melhor_pos)
      and (p_preco_min     is null or v.median_price >= p_preco_min)
      and (p_preco_max     is null or v.median_price <= p_preco_max)
      and (p_momentum      is null or v.momentum = p_momentum)
      and (p_delta_min     is null or v.delta_7d >= p_delta_min)
      and (p_consistencia  is null or v.consistencia = p_consistencia)
      and (p_top10_min     is null or v.days_in_top10 >= p_top10_min)
      and (p_dias_min      is null or v.days_observed >= p_dias_min)
      and (p_conc_min      is null or v.listings >= p_conc_min)
      and (p_conc_max      is null or v.listings <= p_conc_max)
      and (p_dispersao_min is null or v.price_spread >= p_dispersao_min)
      and (p_full_max      is null or coalesce(v.full_share, 0) <= p_full_max)
      and (p_oficial_max   is null or coalesce(v.official_share, 0) <= p_oficial_max)
    order by
      case when p_ordem = 'posicao'     then v.position_now end asc nulls last,
      case when p_ordem = 'movimento'   then v.delta_7d end desc nulls last,
      case when p_ordem = 'concorrencia' then v.listings end asc nulls last,
      case when p_ordem = 'preco'       then v.median_price end desc nulls last,
      case when p_ordem = 'consistencia' then v.top10_rate end desc nulls last,
      v.position_now asc nulls last
    limit least(p_limite, 200) offset p_offset;
end;
$$;

-- ---------------------------------------------------------------------
-- 3) Contagem sem gastar quota.
--
-- Serve para o front mostrar "3.482 produtos batem com esses filtros"
-- antes de o usuário gastar uma busca. Sem isso ele queima as 5 buscas
-- do plano gratuito tateando filtro.
-- ---------------------------------------------------------------------
create or replace function contar_produtos(
  p_categoria text default null, p_raiz text default null, p_texto text default null,
  p_pos_max int default null, p_preco_min numeric default null, p_preco_max numeric default null,
  p_momentum text default null, p_conc_max int default null
)
returns bigint
language sql
security definer set search_path = public
as $$
  select count(*)
    from product_search_view v
    left join categories c on c.id = v.category_id
   where v.position_now is not null
     and (p_categoria is null or v.category_id = p_categoria)
     and (p_raiz      is null or c.root_id = p_raiz)
     and (p_texto     is null or v.name ilike '%' || p_texto || '%')
     and (p_pos_max   is null or v.position_now <= p_pos_max)
     and (p_preco_min is null or v.median_price >= p_preco_min)
     and (p_preco_max is null or v.median_price <= p_preco_max)
     and (p_momentum  is null or v.momentum = p_momentum)
     and (p_conc_max  is null or v.listings <= p_conc_max)
$$;

grant execute on function buscar_categorias(text,int) to authenticated;
grant execute on function categorias_raiz()           to authenticated;
grant execute on function contar_produtos(text,text,text,int,numeric,numeric,text,int) to authenticated;
grant execute on function buscar_produtos(
  text,text,text,int,int,int,numeric,numeric,text,int,text,int,int,int,int,numeric,numeric,numeric,text,int,int
) to authenticated;
