-- =====================================================================
-- 013_busca_guiada.sql
--
-- Duas formas de buscar, como no JoomPulse:
--
--   BUSCA AVANÇADA — campos numéricos, para quem sabe o que quer.
--   PESQUISA SIMPLES — opções semânticas com explicação, para quem não
--                      sabe que número colocar em "posição máxima".
--
-- A ideia da segunda é a melhor coisa da interface deles, e mapeia bem
-- no nosso dado: a "maturidade do anúncio" é a nossa consistência no
-- ranking, e o "nível de concorrência" é a contagem de disputantes.
--
-- Onde eles põem cadeado (recurso pago), aqui a distinção é outra: se o
-- dado não existe do nosso lado, o campo não aparece. Cadeado sugere
-- "pague e libera" — prometer o que não temos seria pior que omitir.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) REFERÊNCIA: aceita código, link ou nome.
--
-- O campo de busca do JoomPulse aceita "nome do produto, código MLB ou
-- link do Mercado Livre". Colar o link é o gesto natural de quem está
-- olhando um anúncio e quer saber se vale a pena.
-- ---------------------------------------------------------------------
create or replace function buscar_por_referencia(p_ref text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_mlb  text;
  v_prod text;
begin
  if auth.uid() is null then raise exception 'nao autenticado' using errcode = '28000'; end if;

  -- link de produto de catálogo: /p/MLB54987753
  v_mlb := (regexp_match(p_ref, '/p/(MLB[0-9]+)', 'i'))[1];
  -- link ou código de anúncio: MLB-4881406189 ou MLB4881406189
  if v_mlb is null then
    v_mlb := (regexp_match(p_ref, 'MLB-?([0-9]{8,})', 'i'))[1];
    if v_mlb is not null then v_mlb := 'MLB' || v_mlb; end if;
  end if;

  if v_mlb is null then
    return jsonb_build_object('tipo', 'texto', 'termo', p_ref);
  end if;

  select coalesce(
    (select id from catalog_products where id = v_mlb),
    (select catalog_product_id from items where id = v_mlb)
  ) into v_prod;

  if v_prod is null then
    return jsonb_build_object('tipo', 'nao_encontrado', 'mlb', v_mlb);
  end if;
  return jsonb_build_object('tipo', 'produto', 'produto', v_prod, 'mlb', v_mlb);
end;
$$;

-- ---------------------------------------------------------------------
-- 2) BUSCA COM MODO GUIADO
--
-- Os três parâmetros semânticos traduzem para faixas numéricas dentro
-- da função. O usuário escolhe "concorrência baixa"; quem decide que
-- isso significa até 5 disputantes é o servidor — e muda de ideia sem
-- precisar atualizar o front.
-- ---------------------------------------------------------------------
drop function if exists buscar_produtos(
  text,text,text,int,int,int,numeric,numeric,text,int,text,int,int,int,int,numeric,numeric,numeric,text,int,int);

create or replace function buscar_produtos(
  p_categoria     text    default null,
  p_raiz          text    default null,
  p_texto         text    default null,
  p_produto       text    default null,   -- veio de buscar_por_referencia
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
  -- guiados
  p_maturidade    text    default null,   -- nova | consolidando | comprovado
  p_nivel_conc    text    default null,   -- baixa | media | alta
  p_estabilidade  text    default null,   -- estavel | oscilante | volatil
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
  -- traduções dos modos guiados
  v_dias_min int;  v_dias_max int;  v_cons text;
  v_cmin int;      v_cmax int;
  v_dmin numeric;  v_dmax numeric;
begin
  q := consume_quota('product_search');
  if not (q ->> 'allowed')::boolean then
    raise exception 'quota esgotada' using errcode = 'P0001', detail = q::text;
  end if;

  -- MATURIDADE: quanto tempo o produto sustenta presença no ranking
  case p_maturidade
    when 'nova'         then v_dias_max := 14;                       -- apareceu há pouco
    when 'consolidando' then v_dias_min := 14; v_cons := 'recorrente';
    when 'comprovado'   then v_dias_min := 21; v_cons := 'consolidado';
    else null;
  end case;

  -- NÍVEL DE CONCORRÊNCIA: quantos disputam o mesmo produto
  case p_nivel_conc
    when 'baixa' then v_cmax := 5;
    when 'media' then v_cmin := 6;  v_cmax := 20;
    when 'alta'  then v_cmin := 21;
    else null;
  end case;

  -- ESTABILIDADE DE PREÇO: dispersão entre o maior e o menor
  case p_estabilidade
    when 'estavel'   then v_dmax := 0.25;   -- todos cobram parecido
    when 'oscilante' then v_dmin := 0.25; v_dmax := 0.6;
    when 'volatil'   then v_dmin := 0.6;    -- mercado desorganizado
    else null;
  end case;

  return query
    select v.* from product_search_view v
    left join categories c on c.id = v.category_id
    where v.position_now is not null
      and (p_produto      is null or v.product_id = p_produto)
      and (p_categoria    is null or v.category_id = p_categoria)
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
      -- consistência: explícita ou vinda da maturidade
      and (coalesce(p_consistencia, v_cons) is null
           or v.consistencia = coalesce(p_consistencia, v_cons))
      and (coalesce(p_dias_min, v_dias_min) is null
           or v.days_observed >= coalesce(p_dias_min, v_dias_min))
      and (v_dias_max      is null or v.days_observed <= v_dias_max)
      -- concorrência: explícita ou vinda do nível
      and (coalesce(p_conc_min, v_cmin) is null
           or v.listings >= coalesce(p_conc_min, v_cmin))
      and (coalesce(p_conc_max, v_cmax) is null
           or v.listings <= coalesce(p_conc_max, v_cmax))
      -- dispersão: explícita ou vinda da estabilidade
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

-- ---------------------------------------------------------------------
-- 3) Contagem com os mesmos modos guiados. Não consome quota.
-- ---------------------------------------------------------------------
-- A versão antiga (8 parâmetros) precisa cair: com todos os argumentos
-- opcionais, chamar contar_produtos() sem nada casaria com as duas e o
-- Postgres recusa por ambiguidade.
drop function if exists contar_produtos(text,text,text,int,numeric,numeric,text,int);

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
     and (p_categoria is null or v.category_id = p_categoria)
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

grant execute on function buscar_por_referencia(text) to authenticated;
grant execute on function contar_produtos(text,text,text,int,numeric,numeric,text,int,text,text,text) to authenticated;
grant execute on function buscar_produtos(
  text,text,text,text,int,int,int,numeric,numeric,text,int,text,int,int,int,int,
  numeric,numeric,numeric,numeric,text,text,text,text,int,int) to authenticated;
