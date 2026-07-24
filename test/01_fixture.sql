-- =====================================================================
-- Fixture de teste: dados sintéticos com resposta conhecida.
--
-- Cada anúncio abaixo exercita um caso que o cálculo de vendas
-- estimadas precisa acertar. Os valores esperados estão comentados.
-- =====================================================================

insert into categories (id, name, parent_id, root_id, path_ids, path_names, level, is_leaf)
values
  ('MLB_ROOT', 'Saúde',        null,       'MLB_ROOT', '{MLB_ROOT}',          '{Saúde}',                0, false),
  ('MLB_SUP',  'Suplementos',  'MLB_ROOT', 'MLB_ROOT', '{MLB_ROOT,MLB_SUP}',  '{Saúde,Suplementos}',    1, true),
  ('MLB_CONC', 'Nicho travado','MLB_ROOT', 'MLB_ROOT', '{MLB_ROOT,MLB_CONC}', '{Saúde,Nicho travado}',  1, true);

insert into sellers (id, nickname, state) values
  (1, 'VENDEDOR_A', 'SP'),
  (2, 'VENDEDOR_B', 'RJ'),
  (3, 'DOMINANTE',  'SP');

insert into items (id, title, category_id, seller_id, status) values
  ('ITEM_NORMAL',  'Caso normal: vendas constantes', 'MLB_SUP',  1, 'active'),
  ('ITEM_RESET',   'Caso reset: anúncio republicado', 'MLB_SUP',  2, 'active'),
  ('ITEM_GAP',     'Caso buraco: coleta falhou',      'MLB_SUP',  1, 'active'),
  ('ITEM_PROMO',   'Caso promoção: preço variável',   'MLB_SUP',  2, 'active'),
  ('ITEM_MONO',    'Caso monopólio',                  'MLB_CONC', 3, 'active'),
  ('ITEM_PEQUENO', 'Concorrente pequeno',             'MLB_CONC', 1, 'active');

-- ---------------------------------------------------------------------
-- CASO 1 — normal. sold_quantity sobe 10, 15, 20. Preço fixo R$ 50.
-- Esperado: units_30d = 45, revenue_30d = 10*50 + 15*50 + 20*50 = 2250
-- ---------------------------------------------------------------------
insert into item_snapshots (item_id, captured_at, captured_date, price, sold_quantity, seller_id) values
  ('ITEM_NORMAL', now() - interval '3 days', current_date - 3, 50.00, 100, 1),
  ('ITEM_NORMAL', now() - interval '2 days', current_date - 2, 50.00, 110, 1),
  ('ITEM_NORMAL', now() - interval '1 days', current_date - 1, 50.00, 125, 1),
  ('ITEM_NORMAL', now(),                     current_date,     50.00, 145, 1);

-- ---------------------------------------------------------------------
-- CASO 2 — republicação. O contador cai de 210 para 5.
-- Isso NÃO é venda negativa: é o vendedor recriando o anúncio.
-- Esperado: units = 10, depois 0 (reset), depois 10 -> total 20
-- Se o código estivesse errado, daria 10 + (-205) + 10 = -185.
-- ---------------------------------------------------------------------
insert into item_snapshots (item_id, captured_at, captured_date, price, sold_quantity, seller_id) values
  ('ITEM_RESET', now() - interval '3 days', current_date - 3, 80.00, 200, 2),
  ('ITEM_RESET', now() - interval '2 days', current_date - 2, 80.00, 210, 2),
  ('ITEM_RESET', now() - interval '1 days', current_date - 1, 80.00,   5, 2),
  ('ITEM_RESET', now(),                     current_date,     80.00,  15, 2);

-- ---------------------------------------------------------------------
-- CASO 3 — buraco de coleta. Só dois pontos, separados por 5 dias.
-- Esperado: units = 50 num único dia, com gap_days = 5.
-- O gap_days existe para o gráfico não desenhar um pico falso.
-- ---------------------------------------------------------------------
insert into item_snapshots (item_id, captured_at, captured_date, price, sold_quantity, seller_id) values
  ('ITEM_GAP', now() - interval '6 days', current_date - 6, 30.00, 500, 1),
  ('ITEM_GAP', now() - interval '1 days', current_date - 1, 30.00, 550, 1);

-- ---------------------------------------------------------------------
-- CASO 4 — promoção. Mesmas 10 unidades por dia, preço muda.
-- Esperado: revenue = 10*100 + 10*60 + 10*100 = 2600
-- Se usasse preço médio (86,67), daria 2600 por coincidência aqui,
-- então variamos as quantidades: 10, 30, 10.
-- revenue = 10*100 + 30*60 + 10*100 = 1000 + 1800 + 1000 = 3800
-- Com preço médio seria 50 * 86,67 = 4333 -> erraria em 14%.
-- ---------------------------------------------------------------------
insert into item_snapshots (item_id, captured_at, captured_date, price, sold_quantity, seller_id) values
  ('ITEM_PROMO', now() - interval '3 days', current_date - 3, 100.00,   0, 2),
  ('ITEM_PROMO', now() - interval '2 days', current_date - 2, 100.00,  10, 2),
  ('ITEM_PROMO', now() - interval '1 days', current_date - 1,  60.00,  40, 2),
  ('ITEM_PROMO', now(),                     current_date,     100.00,  50, 2);

-- ---------------------------------------------------------------------
-- CASO 5 — categoria monopolizada.
-- DOMINANTE fatura 100 * 90 = 9000; pequeno fatura 10 * 90 = 900.
-- Esperado: top_seller_share = 9000/9900 = 0,9091
--           hhi = (9000² + 900²)/9900² = 0,8347
-- ---------------------------------------------------------------------
insert into item_snapshots (item_id, captured_at, captured_date, price, sold_quantity, seller_id) values
  ('ITEM_MONO',    now() - interval '1 days', current_date - 1, 90.00, 1000, 3),
  ('ITEM_MONO',    now(),                     current_date,     90.00, 1100, 3),
  ('ITEM_PEQUENO', now() - interval '1 days', current_date - 1, 90.00,  200, 1),
  ('ITEM_PEQUENO', now(),                     current_date,     90.00,  210, 1);
