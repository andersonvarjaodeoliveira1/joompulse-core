-- =====================================================================
-- Testes do pivô para ranking.
-- Cada produto abaixo exercita um caso, com resposta calculada à mão.
-- =====================================================================
\set ON_ERROR_STOP on

insert into categories (id, name, root_id, path_ids, path_names, level, is_leaf) values
  ('MLB_R1', 'Categoria de teste', 'MLB_R1', '{MLB_R1}', '{Teste}', 0, true)
on conflict (id) do nothing;

insert into sellers (id, nickname) values (901,'A'),(902,'B'),(903,'C'),(904,'D')
on conflict (id) do nothing;

insert into catalog_products (id, name, category_id) values
  ('PROD_SOBE',  'Subiu 8 posições em 7 dias', 'MLB_R1'),
  ('PROD_TOP',   'Consolidado no top 10',      'MLB_R1'),
  ('PROD_PASSA', 'Passageiro',                 'MLB_R1');

-- ---------------------------------------------------------------------
-- CASO 1 — produto em ascensão.
-- Posição 11 dos dias -30 a -7, depois 3 dos dias -6 a hoje.
-- Esperado: position_now=3, position_7d_ago=11, delta_7d=+8, 'subindo'
-- ---------------------------------------------------------------------
insert into product_rank_snapshots (product_id, category_id, captured_at, captured_date, position)
select 'PROD_SOBE', 'MLB_R1',
       now() - make_interval(days => d),
       current_date - d,
       case when d >= 7 then 11 else 3 end
from generate_series(0, 30) d;

-- ---------------------------------------------------------------------
-- CASO 2 — consolidado. Posição 5 em todos os 30 dias.
-- Esperado: days_in_top10=31, top10_rate=1.0, 'consolidado', delta_7d=0
-- ---------------------------------------------------------------------
insert into product_rank_snapshots (product_id, category_id, captured_at, captured_date, position)
select 'PROD_TOP', 'MLB_R1', now() - make_interval(days => d), current_date - d, 5
from generate_series(0, 30) d;

-- ---------------------------------------------------------------------
-- CASO 3 — passageiro. 3 dias no top 10, 17 fora.
-- Esperado: days_in_top10=3, days_observed=20, 'passageiro'
-- ---------------------------------------------------------------------
insert into product_rank_snapshots (product_id, category_id, captured_at, captured_date, position)
select 'PROD_PASSA', 'MLB_R1', now() - make_interval(days => d), current_date - d,
       case when d < 3 then 8 else 15 end
from generate_series(0, 19) d;

-- ---------------------------------------------------------------------
-- CASO 4 — concorrência. 4 anúncios disputando PROD_TOP.
-- Preços 100, 120, 150, 200.
-- Esperado: mediana=135, min=100, max=200, spread=(200-100)/142.5=0.702
--           full_share = 2/4 = 0.5
-- ---------------------------------------------------------------------
insert into items (id, title, category_id, seller_id, catalog_product_id,
                   shipping_logistic_type, official_store_id, shipping_free, status) values
  ('IT_A','Anúncio A','MLB_R1',901,'PROD_TOP','fulfillment', 77,  true, 'active'),
  ('IT_B','Anúncio B','MLB_R1',902,'PROD_TOP','fulfillment', null,true, 'active'),
  ('IT_C','Anúncio C','MLB_R1',903,'PROD_TOP','drop_off',    null,false,'active'),
  ('IT_D','Anúncio D','MLB_R1',904,'PROD_TOP','cross_docking',null,true, 'active');

insert into item_snapshots (item_id, captured_at, captured_date, price, seller_id) values
  ('IT_A', now(), current_date, 100.00, 901),
  ('IT_B', now(), current_date, 120.00, 902),
  ('IT_C', now(), current_date, 150.00, 903),
  ('IT_D', now(), current_date, 200.00, 904);

-- ---------------------------------------------------------------------
-- CASO 5 — calibração. Três pares reais de conta conectada.
-- ---------------------------------------------------------------------
insert into calibration_points (item_id, category_id, observed_on, position, units_sold, period_days) values
  ('IT_A','MLB_R1', current_date - 1,  1, 1000, 30),
  ('IT_B','MLB_R1', current_date - 1,  5,  250, 30),
  ('IT_C','MLB_R1', current_date - 1, 10,  130, 30);
