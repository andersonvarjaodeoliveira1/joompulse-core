-- criado_em faltava na view -- card pedia "publicado em" e nao tinha
-- de onde puxar. So acrescenta no fim (resto copiado exato do
-- original em 20260724110000_fornecedores.sql).
create or replace view produtos_locais_view as
select
  sp.id                       as produto_id,
  sp.nome,
  sp.imagem,
  sp.descricao,
  sp.custo,
  sp.moeda,
  sp.moq,
  sp.unidades_por_caixa,
  sp.preco_desde,
  sp.catalog_product_id,
  cp.name                     as nome_no_ml,
  k.median_price              as preco_medio_ml,
  k.listings                  as concorrentes_ml,
  m.position_now              as posicao_ml,
  case when k.median_price > 0 and sp.custo > 0
       then round((k.median_price - sp.custo) / k.median_price, 4) end as margem_bruta,
  case when sp.custo > 0 and k.median_price is not null
       then round(k.median_price - sp.custo, 2) end                    as lucro_bruto,
  s.id                        as fornecedor_id,
  s.nome                      as fornecedor,
  s.cidade,
  s.estado,
  s.tipo,
  s.verificado,
  s.origem,
  sp.category_id,
  c.name                      as categoria,
  sp.criado_em
from supplier_products sp
join suppliers s        on s.id = sp.supplier_id and s.ativo
left join catalog_products cp    on cp.id = sp.catalog_product_id
left join product_competition k  on k.product_id = sp.catalog_product_id
left join product_rank_metrics m on m.product_id = sp.catalog_product_id
left join categories c           on c.id = sp.category_id
where sp.ativo;
