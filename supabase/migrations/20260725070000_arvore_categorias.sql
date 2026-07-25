-- =====================================================================
-- 070_arvore_categorias.sql
--
-- O JoomPulse abre o seletor de categoria já mostrando a árvore inteira
-- (raízes com seta pra expandir), sem precisar digitar nada. O nosso só
-- tinha busca por texto (buscar_categorias), que exige >=2 letras e só
-- devolve FOLHA com produto rankeado — não dá pra "navegar de cima pra
-- baixo" como o comentário de categorias_raiz() já prometia.
--
-- categories já tem a árvore inteira (parent_id, level, is_leaf) desde o
-- seed() — syncCategories desce recursivamente TODA a taxonomia do ML,
-- independente de cobertura de ranking. Só faltava o RPC genérico de
-- navegação por nível.
-- =====================================================================

create or replace function categoria_filhos(p_parent_id text default null)
returns table (id text, nome text, is_leaf boolean)
language sql
security definer set search_path = public
as $$
  select c.id, c.name, c.is_leaf
    from categories c
   where (p_parent_id is null and c.level = 0)
      or (p_parent_id is not null and c.parent_id = p_parent_id)
   order by c.name
$$;

grant execute on function categoria_filhos(text) to authenticated;

-- ---------------------------------------------------------------------
-- Selecionar um nó da árvore só fazia sentido pra FOLHA: p_categoria
-- exigia igualdade exata com v.category_id. Escolher uma categoria-mãe
-- (ex.: "Eletrônicos, Áudio e Vídeo") não devolvia nada.
--
-- path_ids guarda a cadeia de ancestrais de cada categoria (comentário
-- original da tabela: "permite consultar 'tudo abaixo de MLB1276' sem
-- recursão"). Isso nunca tinha sido usado até agora — é exatamente o
-- que falta pra selecionar qualquer nível da árvore, não só folha.
-- Assinatura idêntica à de 20260724130000_busca_guiada.sql, então
-- create or replace substitui sem precisar de drop.
-- ---------------------------------------------------------------------
create or replace function buscar_produtos(
  p_categoria     text    default null,
  p_raiz          text    default null,
  p_texto         text    default null,
  p_produto       text    default null,
  p_pos_min       int     default null,
  p_pos_max       int     default null,
  p_melhor_pos    int     default null,
  p_preco_min     numeric default null,
  p_preco_max     numeric default null,
  p_momentum      text    default null,
  p_delta_min     int     default null,
  p_consistencia  text    default null,
  p_top10_min     int     default null,
  p_dias_min      int     default null,
  p_conc_min      int     default null,
  p_conc_max      int     default null,
  p_dispersao_min numeric default null,
  p_full_min      numeric default null,
  p_full_max      numeric default null,
  p_oficial_max   numeric default null,
  p_maturidade    text    default null,
  p_nivel_conc    text    default null,
  p_estabilidade  text    default null,
  p_ordem         text    default 'posicao',
  p_limite        int     default 50,
  p_offset        int     default 0
)
returns setof product_search_view
language plpgsql
security definer set search_path = public
as $$
declare
  q jsonb;
  v_dias_min int;  v_dias_max int;  v_cons text;
  v_cmin int;      v_cmax int;
  v_dmin numeric;  v_dmax numeric;
begin
  q := consume_quota('product_search');
  if not (q ->> 'allowed')::boolean then
    raise exception 'quota esgotada' using errcode = 'P0001', detail = q::text;
  end if;

  case p_maturidade
    when 'nova'         then v_dias_max := 14;
    when 'consolidando' then v_dias_min := 14; v_cons := 'recorrente';
    when 'comprovado'   then v_dias_min := 21; v_cons := 'consolidado';
    else null;
  end case;

  case p_nivel_conc
    when 'baixa' then v_cmax := 5;
    when 'media' then v_cmin := 6;  v_cmax := 20;
    when 'alta'  then v_cmin := 21;
    else null;
  end case;

  case p_estabilidade
    when 'estavel'   then v_dmax := 0.25;
    when 'oscilante' then v_dmin := 0.25; v_dmax := 0.6;
    when 'volatil'   then v_dmin := 0.6;
    else null;
  end case;

  return query
    select v.* from product_search_view v
    left join categories c on c.id = v.category_id
    where v.position_now is not null
      and (p_produto      is null or v.product_id = p_produto)
      -- categoria: bate exato OU p_categoria é ancestral (nó não-folha
      -- selecionado na árvore) — "tudo abaixo de X".
      and (p_categoria    is null or v.category_id = p_categoria
                                   or p_categoria = any(c.path_ids))
      and (p_raiz         is null or c.root_id = p_raiz)
      and (p_texto        is null or v.name ilike '%' || p_texto || '%')
      and (p_pos_min      is null or v.position_now >= p_pos_min)
      and (p_pos_max      is null or v.position_now <= p_pos_max)
      and (p_melhor_pos   is null or v.best_position <= p_melhor_pos)
      and (p_preco_min    is null or v.median_price >= p_preco_min)
      and (p_preco_max    is null or v.median_price <= p_preco_max)
      and (p_momentum     is null or v.momentum = p_momentum)
      and (p_delta_min    is null or v.delta_7d >= p_delta_min)
      and (p_top10_min    is null or v.days_in_top10 >= p_top10_min)
      and (p_oficial_max  is null or coalesce(v.official_share,0) <= p_oficial_max)
      and (p_full_min     is null or coalesce(v.full_share,0) >= p_full_min)
      and (p_full_max     is null or coalesce(v.full_share,0) <= p_full_max)
      and (coalesce(p_consistencia, v_cons) is null
           or v.consistencia = coalesce(p_consistencia, v_cons))
      and (coalesce(p_dias_min, v_dias_min) is null
           or v.days_observed >= coalesce(p_dias_min, v_dias_min))
      and (v_dias_max      is null or v.days_observed <= v_dias_max)
      and (coalesce(p_conc_min, v_cmin) is null
           or v.listings >= coalesce(p_conc_min, v_cmin))
      and (coalesce(p_conc_max, v_cmax) is null
           or v.listings <= coalesce(p_conc_max, v_cmax))
      and (coalesce(p_dispersao_min, v_dmin) is null
           or v.price_spread >= coalesce(p_dispersao_min, v_dmin))
      and (v_dmax          is null or v.price_spread <= v_dmax)
    order by
      case when p_ordem = 'posicao'      then v.position_now end asc nulls last,
      case when p_ordem = 'movimento'    then v.delta_7d end desc nulls last,
      case when p_ordem = 'concorrencia' then v.listings end asc nulls last,
      case when p_ordem = 'preco'        then v.median_price end desc nulls last,
      case when p_ordem = 'consistencia' then v.top10_rate end desc nulls last,
      v.position_now asc nulls last
    limit least(p_limite, 200) offset p_offset;
end;
$$;

-- Mesmo ajuste no contador (não consome quota) — senão o número que
-- aparece antes de buscar não bate com o que buscar_produtos devolve.
create or replace function contar_produtos(
  p_categoria text default null, p_raiz text default null, p_texto text default null,
  p_pos_max int default null, p_preco_min numeric default null, p_preco_max numeric default null,
  p_momentum text default null, p_conc_max int default null,
  p_maturidade text default null, p_nivel_conc text default null, p_estabilidade text default null
)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  n bigint;
  v_dias_min int; v_dias_max int; v_cons text;
  v_cmin int; v_cmax int; v_dmin numeric; v_dmax numeric;
begin
  case p_maturidade
    when 'nova'         then v_dias_max := 14;
    when 'consolidando' then v_dias_min := 14; v_cons := 'recorrente';
    when 'comprovado'   then v_dias_min := 21; v_cons := 'consolidado';
    else null; end case;
  case p_nivel_conc
    when 'baixa' then v_cmax := 5;
    when 'media' then v_cmin := 6; v_cmax := 20;
    when 'alta'  then v_cmin := 21;
    else null; end case;
  case p_estabilidade
    when 'estavel'   then v_dmax := 0.25;
    when 'oscilante' then v_dmin := 0.25; v_dmax := 0.6;
    when 'volatil'   then v_dmin := 0.6;
    else null; end case;

  select count(*) into n
    from product_search_view v
    left join categories c on c.id = v.category_id
   where v.position_now is not null
     and (p_categoria is null or v.category_id = p_categoria
                               or p_categoria = any(c.path_ids))
     and (p_raiz      is null or c.root_id = p_raiz)
     and (p_texto     is null or v.name ilike '%' || p_texto || '%')
     and (p_pos_max   is null or v.position_now <= p_pos_max)
     and (p_preco_min is null or v.median_price >= p_preco_min)
     and (p_preco_max is null or v.median_price <= p_preco_max)
     and (p_momentum  is null or v.momentum = p_momentum)
     and (v_cons      is null or v.consistencia = v_cons)
     and (v_dias_min  is null or v.days_observed >= v_dias_min)
     and (v_dias_max  is null or v.days_observed <= v_dias_max)
     and (coalesce(p_conc_max, v_cmax) is null or v.listings <= coalesce(p_conc_max, v_cmax))
     and (v_cmin      is null or v.listings >= v_cmin)
     and (v_dmin      is null or v.price_spread >= v_dmin)
     and (v_dmax      is null or v.price_spread <= v_dmax);
  return n;
end;
$$;

grant execute on function buscar_produtos(
  text,text,text,text,int,int,int,numeric,numeric,text,int,text,int,int,int,int,
  numeric,numeric,numeric,numeric,text,text,text,text,int,int) to authenticated;
grant execute on function contar_produtos(text,text,text,int,numeric,numeric,text,int,text,text,text) to authenticated;
