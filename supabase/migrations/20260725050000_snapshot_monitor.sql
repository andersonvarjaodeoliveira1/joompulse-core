-- Foto da pagina no momento em que o produto entrou no monitor.
--
-- sold_quantity de anuncio de terceiro da 403 na API (ver README), mas a
-- pagina publica "+10 mil vendidos" para qualquer visitante. A extensao ja
-- le esse numero; guardar aqui deixa o app calcular media mensal e receita
-- sem depender de coleta.
--
-- E FOTO do dia da inclusao. A serie de preco continua vindo de
-- product_price_daily, que e dado nosso e atualiza sozinho.
alter table tracked_products add column if not exists snapshot jsonb;

comment on column tracked_products.snapshot is
  'Leitura da pagina do ML no dia em que o produto entrou no monitor. Nao atualiza sozinho.';
