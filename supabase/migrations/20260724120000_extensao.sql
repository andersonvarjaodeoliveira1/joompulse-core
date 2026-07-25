-- =====================================================================
-- 012_extensao.sql — suporte à extensão do Chrome
--
-- O PROBLEMA DE IDENTIDADE
--
-- A URL de um anúncio no Mercado Livre carrega um ITEM (MLB4881406189).
-- Nossos dados são indexados por PRODUTO DE CATÁLOGO (MLB54987753).
-- São coisas diferentes: um produto reúne dezenas de anúncios.
--
-- Se o anúncio já foi coletado, items.catalog_product_id faz a ponte.
-- Se não foi, ele está fora da nossa cobertura — que hoje é de 3.891
-- categorias das 10.624 folhas, porque só 37% delas têm destaques.
--
-- Em vez de mostrar erro nesse caso, a extensão oferece PEDIR A COLETA.
-- E manda junto a categoria, que ela lê do rastro de navegação da
-- própria página. Assim a lacuna de cobertura vira fila de trabalho
-- priorizada pelo que os usuários realmente olham.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Cota própria da extensão.
--
-- Separada da busca de propósito: navegando no ML o usuário abre dezenas
-- de páginas. Se cada uma queimasse uma das 5 buscas do plano gratuito,
-- a extensão ficaria inútil no primeiro minuto e ele desinstalaria.
-- ---------------------------------------------------------------------
update plans set limits = limits || jsonb_build_object('extension_view',
  case code when 'free' then 25 when 'starter' then 400
            when 'pro' then 2000 else -1 end);

-- ---------------------------------------------------------------------
-- PEDIDOS DE COLETA
-- ---------------------------------------------------------------------
create table if not exists collect_requests (
  id          bigserial primary key,
  user_id     uuid references profiles(id) on delete set null,
  mlb         text not null,
  category_id text,
  url         text,
  status      text not null default 'pendente',   -- pendente | atendido | sem_item | sem_destaque
  pedidos     int not null default 1,
  criado_em   timestamptz not null default now(),
  atendido_em timestamptz,
  unique (mlb)
);
create index if not exists creq_status_idx on collect_requests(status, pedidos desc);

-- ---------------------------------------------------------------------
-- RESOLVER ANÚNCIO
--
-- Recebe o MLB que a extensão leu da URL e devolve o que sabemos.
-- Três desfechos possíveis, e cada um tem uma tela diferente:
--
--   encontrado    — temos o produto, com posição e concorrência
--   sem_ranking   — conhecemos o anúncio, mas o produto nunca apareceu
--                   no top 20 de nenhuma categoria
--   desconhecido  — nunca vimos esse anúncio
-- ---------------------------------------------------------------------
create or replace function resolver_anuncio(p_mlb text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  q       jsonb;
  v_prod  text;
  v_item  record;
  v_p     record;
  v_seg   boolean;
begin
  if v_user is null then raise exception 'nao autenticado' using errcode = '28000'; end if;

  q := consume_quota('extension_view');
  if not (q ->> 'allowed')::boolean then
    return jsonb_build_object('status','sem_quota','restantes',0,
                              'motivo', q ->> 'reason');
  end if;

  select i.id, i.catalog_product_id, i.seller_id, i.category_id,
         s.nickname as vendedor
    into v_item
    from items i left join sellers s on s.id = i.seller_id
   where i.id = p_mlb;

  -- A URL do ML tem dois formatos: /MLB-4881406189-titulo (anúncio) e
  -- /p/MLB54987753 (produto de catálogo). Se não achamos como anúncio,
  -- pode ser que o id JÁ seja o produto.
  if v_item.id is null then
    if exists (select 1 from catalog_products where id = p_mlb) then
      v_prod := p_mlb;
    else
      return jsonb_build_object('status','desconhecido','mlb',p_mlb,
                                'restantes', q -> 'remaining');
    end if;
  else
    v_prod := v_item.catalog_product_id;
  end if;
  if v_prod is null then
    return jsonb_build_object('status','sem_ranking','mlb',p_mlb,
                              'vendedor', v_item.vendedor,
                              'restantes', q -> 'remaining');
  end if;

  select * into v_p from product_search_view where product_id = v_prod;
  if v_p.product_id is null then
    return jsonb_build_object('status','sem_ranking','mlb',p_mlb,
                              'produto', v_prod, 'restantes', q -> 'remaining');
  end if;

  select exists(select 1 from tracked_products
                 where user_id = v_user and product_id = v_prod) into v_seg;

  return jsonb_build_object(
    'status','encontrado',
    'mlb', p_mlb,
    'produto', v_prod,
    'nome', v_p.name,
    'categoria', v_p.category_name,
    'posicao', v_p.position_now,
    'melhor_posicao', v_p.best_position,
    'delta_7d', v_p.delta_7d,
    'momentum', v_p.momentum,
    'consistencia', v_p.consistencia,
    'dias_top10', v_p.days_in_top10,
    'dias_observados', v_p.days_observed,
    'concorrentes', v_p.listings,
    'vendedores', v_p.sellers,
    'preco_min', v_p.min_price,
    'preco_mediano', v_p.median_price,
    'preco_max', v_p.max_price,
    'full_share', v_p.full_share,
    'monitorado', v_seg,
    'restantes', q -> 'remaining'
  );
end;
$$;

-- ---------------------------------------------------------------------
-- PEDIR COLETA
--
-- Não consome quota: o usuário está fazendo um favor ao sistema ao
-- apontar uma lacuna. Cobrar por isso seria contraproducente.
--
-- Vários pedidos do mesmo anúncio incrementam o contador, e é ele que
-- ordena a fila — o que mais gente procura entra antes.
-- ---------------------------------------------------------------------
create or replace function solicitar_coleta(
  p_mlb text, p_categoria text default null, p_url text default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare v_pedidos int;
begin
  if auth.uid() is null then raise exception 'nao autenticado' using errcode = '28000'; end if;

  insert into collect_requests (user_id, mlb, category_id, url)
  values (auth.uid(), p_mlb, p_categoria, p_url)
  on conflict (mlb) do update set
    pedidos = collect_requests.pedidos + 1,
    category_id = coalesce(collect_requests.category_id, excluded.category_id)
  returning pedidos into v_pedidos;

  return jsonb_build_object('ok', true, 'pedidos', v_pedidos,
    'aviso', case when p_categoria is null
                  then 'sem a categoria, a coleta pode demorar mais'
                  else null end);
end;
$$;

grant execute on function resolver_anuncio(text)                to authenticated;
grant execute on function solicitar_coleta(text,text,text)      to authenticated;
revoke all on collect_requests from anon, authenticated;

comment on table collect_requests is
  'Lacunas de cobertura apontadas pelos usuários via extensão. Ordenar por "pedidos".';
