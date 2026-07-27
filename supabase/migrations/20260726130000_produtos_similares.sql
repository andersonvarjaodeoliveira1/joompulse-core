-- ficha_produto nao devolvia category_id (so o nome) -- sem isso nao
-- da pra filtrar "produtos similares" (mesma categoria). So acrescenta
-- categoria_id; resto copiado exatamente de 20260724180000_ficha_produto.sql.
create or replace function ficha_produto(p_produto text)
returns jsonb
language sql
security definer set search_path = public
as $$
  select jsonb_build_object(
    'produto', jsonb_build_object(
      'id', p.id, 'nome', p.name, 'tipo', p.tipo, 'marca', p.brand,
      'imagem', p.picture, 'link', p.permalink,
      'categoria', c.name, 'caminho', c.path_names, 'categoria_id', p.category_id
    ),
    'ranking', to_jsonb(r) - 'product_id',
    'preco',   to_jsonb(pr) - 'product_id',
    'lider',   to_jsonb(l) - 'product_id',
    'concorrencia', jsonb_build_object(
      'anuncios',       k.listings,
      'vendedores',     k.sellers,
      'preco_minimo',   k.min_price,
      'preco_mediano',  k.median_price,
      'preco_maximo',   k.max_price,
      'dispersao',      k.price_spread,
      'share_full',     k.full_share,
      'share_oficial',  k.official_share,
      'entraram_30d',   m.entraram_30d,
      'sumiram_7d',     m.sumiram_7d,
      'ativos_hoje',    m.ativos_hoje
    ),
    'categoria_contexto', jsonb_build_object(
      'produtos_rankeados', cm.produtos_rankeados,
      'rotatividade_7d',    cm.rotatividade_7d,
      'preco_mediano',      cm.preco_mediano,
      'concorrentes_medio', cm.concorrentes_medio
    )
  )
  from catalog_products p
  left join categories c                        on c.id = p.category_id
  left join produto_ranking_analise r           on r.product_id = p.id
  left join produto_preco_analise pr            on pr.product_id = p.id
  left join produto_lider l                     on l.product_id = p.id
  left join product_competition k               on k.product_id = p.id
  left join produto_concorrencia_movimento m    on m.product_id = p.id
  left join category_rank_metrics cm            on cm.category_id = p.category_id
  where p.id = p_produto
$$;

grant execute on function ficha_produto(text) to authenticated;

-- ---------------------------------------------------------------------
-- Produtos similares: mesma categoria, ordenados por posicao. Dado
-- real (product_search_view), nada de receita/vendas estimada -- API
-- do ML nao entrega isso pra terceiro, ja confirmado nesta base.
-- ---------------------------------------------------------------------
create or replace function produtos_similares(p_categoria text, p_excluir text default null, p_limite int default 20)
returns setof product_search_view
language sql
security definer set search_path = public
as $$
  select * from product_search_view
   where category_id = p_categoria
     and (p_excluir is null or product_id <> p_excluir)
     and position_now is not null
   order by position_now asc nulls last
   limit least(p_limite, 50)
$$;

grant execute on function produtos_similares(text, text, int) to authenticated;
