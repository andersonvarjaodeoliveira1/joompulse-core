-- =====================================================================
-- 018_ficha_produto.sql — tudo que dá para saber sem gastar chamada
--
-- Todo o cálculo aqui sai de dado que já coletamos: a série de posições
-- e a série de preços de cada concorrente. Nenhuma chamada nova à API
-- do Mercado Livre.
--
-- Isso importa porque a API é o recurso escasso do projeto — já perdemos
-- dois endpoints. Métrica derivada de dado guardado não pode ser
-- bloqueada por ninguém.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) COMPORTAMENTO DE PREÇO
--
-- O JoomPulse mostra "preço mínimo" e "desconto máximo". Aqui vai isso
-- e mais o que a série permite: onde o preço de HOJE está dentro da
-- faixa histórica, e o quanto ele balança.
--
-- posicao_na_faixa é o número mais útil e o mais fácil de entender:
--   0.0 = está no menor preço que já vimos
--   1.0 = está no maior
-- Abaixo de 0,3 é hora de comprar; acima de 0,8, o vendedor está
-- testando o teto.
-- ---------------------------------------------------------------------
create or replace view produto_preco_analise as
with serie as (
  select product_id, dia, preco_mediano, preco_min, anuncios
    from product_price_daily
   where dia > current_date - 90
),
agg as (
  select
    product_id,
    count(*)                                                  as dias_com_preco,
    min(preco_min)                                            as menor_ja_visto,
    max(preco_mediano)                                        as maior_mediano,
    min(preco_mediano)                                        as menor_mediano,
    round(avg(preco_mediano)::numeric, 2)                     as media,
    round(stddev_samp(preco_mediano)::numeric, 2)             as desvio,
    round(percentile_cont(0.5) within group (order by preco_mediano)::numeric, 2) as mediana_hist,
    (array_agg(preco_mediano order by dia desc))[1]           as atual,
    (array_agg(preco_mediano order by dia desc))[8]           as sete_dias_atras,
    (array_agg(preco_mediano order by dia desc))[31]          as trinta_dias_atras,
    max(dia)                                                  as ultima_leitura
  from serie group by product_id
)
select
  product_id,
  dias_com_preco,
  atual                                                       as preco_atual,
  menor_ja_visto                                              as preco_minimo,
  maior_mediano                                               as preco_maximo,
  mediana_hist                                                as preco_tipico,
  -- desconto máximo já praticado, do topo ao fundo da faixa
  case when maior_mediano > 0
       then round((maior_mediano - menor_ja_visto) / maior_mediano, 4) end as desconto_maximo,
  -- onde o preço de hoje está na faixa: 0 = mínimo histórico, 1 = máximo
  case when maior_mediano > menor_mediano
       then round((atual - menor_mediano) / (maior_mediano - menor_mediano), 3) end as posicao_na_faixa,
  case
    when maior_mediano <= menor_mediano                       then 'estavel'
    when (atual - menor_mediano) / (maior_mediano - menor_mediano) <= 0.30 then 'barato'
    when (atual - menor_mediano) / (maior_mediano - menor_mediano) >= 0.75 then 'caro'
    else 'medio'
  end                                                         as momento_de_preco,
  -- variação recente
  case when sete_dias_atras > 0
       then round((atual - sete_dias_atras) / sete_dias_atras, 4) end   as var_7d,
  case when trinta_dias_atras > 0
       then round((atual - trinta_dias_atras) / trinta_dias_atras, 4) end as var_30d,
  -- volatilidade: desvio sobre média. Acima de 0,15 é mercado nervoso.
  case when media > 0 then round(desvio / media, 3) end       as volatilidade,
  case
    when dias_com_preco < 5                                   then 'insuficiente'
    when media > 0 and desvio / media >= 0.15                 then 'instavel'
    when media > 0 and desvio / media >= 0.06                 then 'oscila'
    else 'firme'
  end                                                         as comportamento,
  ultima_leitura
from agg;

-- ---------------------------------------------------------------------
-- 2) COMPORTAMENTO DE RANKING
--
-- Estabilidade e velocidade são coisas que só quem guarda série sabe.
-- Um produto que oscila entre 3º e 18º toda semana é diferente de um
-- que fica cravado em 5º — mesmo os dois tendo "posição média 8".
-- ---------------------------------------------------------------------
create or replace view produto_ranking_analise as
with s as (
  select product_id, category_id, captured_date, position
    from product_rank_daily
   where captured_date > current_date - 90
),
agg as (
  select
    product_id,
    count(*)                                            as dias,
    min(position)                                       as melhor,
    max(position)                                       as pior,
    round(avg(position), 1)                             as media_pos,
    round(stddev_samp(position)::numeric, 2)            as desvio_pos,
    min(captured_date)                                  as primeira_vez,
    max(captured_date)                                  as ultima_vez,
    (array_agg(position order by captured_date desc))[1] as atual,
    count(*) filter (where position <= 3)               as dias_top3,
    count(*) filter (where position <= 10)              as dias_top10,
    min(captured_date) filter (where position <= 10)    as entrou_top10_em
  from s group by product_id
)
select
  product_id,
  dias                                                  as dias_no_ranking,
  atual                                                 as posicao_atual,
  melhor                                                as melhor_posicao,
  pior                                                  as pior_posicao,
  media_pos                                             as posicao_media,
  desvio_pos                                            as oscilacao,
  case
    when dias < 7                                       then 'novo'
    when desvio_pos is null or desvio_pos <= 1.5        then 'cravado'
    when desvio_pos <= 4                                then 'firme'
    when desvio_pos <= 8                                then 'oscilante'
    else 'instavel'
  end                                                   as estabilidade,
  dias_top3,
  dias_top10,
  round(dias_top10::numeric / nullif(dias, 0), 3)       as taxa_top10,
  primeira_vez,
  entrou_top10_em,
  -- quantos dias levou da primeira aparição até chegar ao top 10
  case when entrou_top10_em is not null
       then (entrou_top10_em - primeira_vez) end        as dias_ate_top10,
  ultima_vez,
  -- sumiu do ranking?
  case when ultima_vez < current_date - 1 then true else false end as fora_do_ranking
from agg;

-- ---------------------------------------------------------------------
-- 3) QUEM ESTÁ GANHANDO
--
-- O JoomPulse mostra "vendedor" e a barrinha de reputação. Aqui dá para
-- ir além: quem tem o menor preço hoje, quanto ele está abaixo da
-- mediana, e se esse vendedor domina outros produtos da mesma categoria.
-- ---------------------------------------------------------------------
create or replace view produto_lider as
with ultimo as (
  select distinct on (i.id)
    i.catalog_product_id as product_id, i.id as item_id, i.seller_id,
    i.shipping_logistic_type, i.official_store_id, s.price
  from items i
  join item_snapshots s on s.item_id = i.id
  where i.catalog_product_id is not null and i.status = 'active' and s.price is not null
  order by i.id, s.captured_at desc
),
-- percentile_cont não aceita OVER, então a mediana sai num passo à parte
medianas as (
  select product_id,
         percentile_cont(0.5) within group (order by price) as mediana
    from ultimo group by product_id
),
ranked as (
  select u.*, m.mediana,
         row_number() over (partition by u.product_id order by u.price asc) as rn
  from ultimo u join medianas m on m.product_id = u.product_id
)
select
  r.product_id,
  r.item_id                                             as item_lider,
  r.seller_id                                           as vendedor_lider,
  v.nickname                                            as vendedor,
  v.state                                               as estado,
  r.price                                               as menor_preco,
  round(r.mediana::numeric, 2)                          as preco_mediano,
  case when r.mediana > 0
       then round(((r.mediana - r.price) / r.mediana)::numeric, 3) end as abaixo_da_mediana,
  r.shipping_logistic_type = 'fulfillment'              as lider_usa_full,
  r.official_store_id is not null                       as lider_e_oficial,
  rep.reputation_level                                  as reputacao,
  rep.power_seller_status                               as medalha,
  rep.transactions_total                                as transacoes,
  -- em quantos produtos deste ranking esse vendedor aparece
  (select count(distinct i2.catalog_product_id) from items i2
    where i2.seller_id = r.seller_id and i2.catalog_product_id is not null) as produtos_do_lider
from ranked r
left join sellers v on v.id = r.seller_id
left join lateral (
  select reputation_level, power_seller_status, transactions_total
    from seller_snapshots ss where ss.seller_id = r.seller_id
   order by ss.captured_at desc limit 1
) rep on true
where r.rn = 1;

-- ---------------------------------------------------------------------
-- 4) MOVIMENTO DA CONCORRÊNCIA
--
-- Quantos entraram e saíram nos últimos 30 dias. Categoria onde
-- concorrente novo aparece toda semana é diferente de uma fechada.
-- ---------------------------------------------------------------------
create or replace view produto_concorrencia_movimento as
with visto as (
  select i.catalog_product_id as product_id, i.id as item_id,
         min(s.captured_date) as primeiro, max(s.captured_date) as ultimo
  from items i join item_snapshots s on s.item_id = i.id
  where i.catalog_product_id is not null
  group by 1, 2
)
select
  product_id,
  count(*)                                                          as total_ja_visto,
  count(*) filter (where ultimo >= current_date - 1)                as ativos_hoje,
  count(*) filter (where primeiro >= current_date - 30)             as entraram_30d,
  count(*) filter (where ultimo < current_date - 7)                 as sumiram_7d
from visto group by product_id;

-- ---------------------------------------------------------------------
-- 5) A FICHA COMPLETA
--
-- Uma chamada devolve tudo. Não consome quota: quem já gastou uma busca
-- para achar o produto não deve pagar de novo para abrir a ficha.
-- ---------------------------------------------------------------------
create or replace function ficha_produto(p_produto text)
returns jsonb
language sql
security definer set search_path = public
as $$
  select jsonb_build_object(
    'produto', jsonb_build_object(
      'id', p.id, 'nome', p.name, 'tipo', p.tipo, 'marca', p.brand,
      'imagem', p.picture, 'link', p.permalink,
      'categoria', c.name, 'caminho', c.path_names
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
grant select on produto_preco_analise, produto_ranking_analise,
                produto_lider, produto_concorrencia_movimento to authenticated;
