-- Pagina de detalhe ao clicar numa categoria (aba Categorias). So dado
-- real: sold_quantity de anuncio de terceiro nao existe em NENHUM
-- endpoint que a conta tem acesso -- testado ao vivo com 17 produtos de
-- catalogo reais, buy_box_winner sempre nulo. Por isso nao ha
-- receita/vendas aqui, so estrutura de mercado (rotatividade, preco,
-- concorrencia) e tendencia real ao longo do tempo.
--
-- Drill-down nao cobra quota de novo: o dado ja foi pago em
-- listar_categorias (consume_quota('category_view')), abrir o detalhe
-- de uma linha ja carregada e leitura pura do banco.
create or replace function categoria_detalhe(p_categoria text)
returns table (category_id text, categoria text, path_names text[],
               oportunidade text, score numeric, rotatividade_7d numeric,
               entrantes int, produtos_rankeados int, preco_mediano numeric,
               concorrentes_medio numeric, dispersao_media numeric,
               full_medio numeric, anuncios_totais bigint,
               dias_observados int, computed_at timestamptz)
language sql
security definer set search_path = public
as $$
  select category_id, categoria, path_names, oportunidade, score, rotatividade_7d,
         entrantes, produtos_rankeados, preco_mediano, concorrentes_medio,
         dispersao_media, full_medio, anuncios_totais, dias_observados, computed_at
    from category_opportunity_rank
   where category_id = p_categoria
$$;

grant execute on function categoria_detalhe(text) to authenticated;

-- Serie real dia a dia: quantos produtos distintos apareceram no top 20
-- daquela categoria naquele dia, e o preco mediano do dia (mesma fonte
-- que o grafico do produto -- product_price_daily).
create or replace function categoria_historico(p_categoria text, p_dias int default 30)
returns table (dia date, produtos_no_top int, preco_mediano numeric)
language sql
security definer set search_path = public
as $$
  select d.captured_date,
         count(distinct d.product_id)::int,
         round(percentile_cont(0.5) within group (order by pd.preco_mediano)::numeric, 2)
    from product_rank_daily d
    left join product_price_daily pd
      on pd.product_id = d.product_id and pd.dia = d.captured_date
   where d.category_id = p_categoria
     and d.captured_date >= current_date - p_dias
   group by d.captured_date
   order by d.captured_date
$$;

grant execute on function categoria_historico(text, int) to authenticated;
