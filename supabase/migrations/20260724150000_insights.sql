-- =====================================================================
-- 015_insights.sql — dados de apoio ao painel da extensão
--
-- A extensão lê da própria página o que o Mercado Livre já exibe para
-- qualquer visitante: "+100 vendidos", preço, data de criação. Com isso
-- ela calcula médias e receita sem depender de sold_quantity da API.
--
-- O que ela NÃO consegue ler da página é o histórico: a página mostra o
-- preço de hoje, não o de duas semanas atrás. Esse pedaço vem da nossa
-- coleta, e é o que a extensão sozinha não faria.
-- =====================================================================

/**
 * Série de preço de um produto de catálogo.
 *
 * Não consome quota: quem já gastou uma visualização para abrir o
 * produto não deve pagar de novo para ver o gráfico dele.
 */
create or replace function historico_preco(p_produto text, p_dias int default 90)
returns table (dia date, preco_mediano numeric, preco_min numeric, anuncios int)
language sql
security definer set search_path = public
as $$
  select dia, preco_mediano, preco_min, anuncios
    from product_price_daily
   where product_id = p_produto
     and dia > current_date - least(p_dias, 365)
   order by dia
$$;

/**
 * Série de preço a partir de UM anúncio, resolvendo o produto por trás.
 * A extensão tem o MLB do anúncio, não o do produto.
 */
create or replace function historico_preco_anuncio(p_mlb text, p_dias int default 90)
returns table (dia date, preco_mediano numeric, preco_min numeric, anuncios int)
language sql
security definer set search_path = public
as $$
  select h.dia, h.preco_mediano, h.preco_min, h.anuncios
    from items i
    join product_price_daily h on h.product_id = i.catalog_product_id
   where i.id = p_mlb
     and h.dia > current_date - least(p_dias, 365)
   order by h.dia
$$;

grant execute on function historico_preco(text,int)          to authenticated;
grant execute on function historico_preco_anuncio(text,int)  to authenticated;
