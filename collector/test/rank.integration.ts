/**
 * Integração do caminho de ranking contra Postgres real.
 * Exercita db-rank.ts com objetos no formato que a API devolve.
 */
import * as db from '../src/db.js';
import * as rank from '../src/db-rank.js';
import type { MlHighlight, MlProductItem, MlProduct } from '../src/ml-client.js';

let falhas = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'OK  ' : 'FALHA'} ${m}`); if (!c) falhas++; };

async function main() {
  console.log('\n  Integração do caminho de ranking\n  ─────────────────────────────────');

  await db.sql`insert into categories (id, name, is_leaf, root_id, path_ids, path_names, level)
               values ('MLB_IT','Categoria integração',true,'MLB_IT','{MLB_IT}','{Integração}',0)
               on conflict (id) do nothing`;

  // --- destaques -> produtos + posições ---
  const destaques: MlHighlight[] = [
    { id: 'P_INT_1', position: 1, type: 'PRODUCT' },
    { id: 'P_INT_2', position: 2, type: 'PRODUCT' },
    { id: 'I_INT_9', position: 3, type: 'ITEM' },
  ];

  const n = await rank.upsertCatalogProducts(
    destaques.filter((d) => d.type === 'PRODUCT').map((d) => ({ id: d.id, categoryId: 'MLB_IT' })),
  );
  ok(n === 2, `upsertCatalogProducts grava 2 produtos (veio ${n})`);

  const pos = await rank.insertRankSnapshots('MLB_IT', destaques);
  ok(pos === 2, `insertRankSnapshots grava só os PRODUCT (veio ${pos})`);

  const [p1] = await db.sql`select position from product_rank_snapshots where product_id='P_INT_1'`;
  ok(p1?.position === 1, 'posição gravada corretamente');

  // --- destaque sem campo position usa a ordem da lista ---
  await db.sql`delete from product_rank_snapshots where category_id='MLB_IT'`;
  await rank.insertRankSnapshots('MLB_IT', [
    { id: 'P_INT_1', type: 'PRODUCT' },
    { id: 'P_INT_2', type: 'PRODUCT' },
  ] as MlHighlight[]);
  const semPos = await db.sql`select product_id, position from product_rank_snapshots
                               where category_id='MLB_IT' order by position`;
  ok(semPos[0]?.position === 1 && semPos[1]?.position === 2,
     'sem campo position, usa a ordem da lista como fallback');

  // --- ficha do produto ---
  const ficha: MlProduct = {
    id: 'P_INT_1',
    name: 'Produto de integração',
    status: 'active',
    permalink: 'https://x/p',
    pictures: [{ url: 'https://x/img.jpg' }],
    attributes: [{ id: 'BRAND', value_name: 'MarcaX' }, { id: 'MODEL', value_name: 'M1' }],
  };
  await rank.enrichProduct(ficha);
  const [f] = await db.sql`select name, brand, model, picture from catalog_products where id='P_INT_1'`;
  ok(f?.brand === 'MarcaX' && f?.model === 'M1', 'enrichProduct extrai marca e modelo dos atributos');
  ok(f?.picture === 'https://x/img.jpg', 'enrichProduct grava a imagem');

  // --- anúncios concorrentes ---
  const itens: MlProductItem[] = [
    { item_id: 'IT_INT_A', seller_id: 5001, price: 199.9, category_id: 'MLB_IT',
      shipping: { free_shipping: true, logistic_type: 'fulfillment' }, official_store_id: 12 },
    { item_id: 'IT_INT_B', seller_id: 5002, price: 249.9, category_id: 'MLB_IT',
      shipping: { free_shipping: false, logistic_type: 'drop_off' } },
    { item_id: 'IT_INT_C', seller_id: 5003, category_id: 'MLB_IT' },  // sem preço
  ];

  const r = await rank.upsertProductItems('P_INT_1', 'MLB_IT', itens);
  ok(r.anuncios === 3, `upsertProductItems grava 3 anúncios (veio ${r.anuncios})`);
  ok(r.snapshots === 2, `anúncio sem preço não vira snapshot (veio ${r.snapshots})`);

  const [a] = await db.sql`select catalog_product_id, is_catalog_listing, shipping_logistic_type,
                                  official_store_id from items where id='IT_INT_A'`;
  ok(a?.catalog_product_id === 'P_INT_1', 'anúncio fica ligado ao produto de catálogo');
  ok(a?.shipping_logistic_type === 'fulfillment', 'tipo de logística preservado (Full)');
  ok(a?.official_store_id === 12, 'loja oficial preservada');

  const [sn] = await db.sql`select price, sold_quantity from item_snapshots where item_id='IT_INT_A'`;
  ok(Number(sn?.price) === 199.9, 'preço gravado no snapshot');
  ok(sn?.sold_quantity === null,
     'sold_quantity fica NULO — a API não entrega, e zero seria mentira');

  // vendedor desconhecido não pode quebrar por chave estrangeira
  const [v] = await db.sql`select id from sellers where id=5003`;
  ok(!!v, 'vendedor desconhecido ganha esqueleto antes do insert');

  // --- calibração ---
  await rank.gravarCalibracao({
    itemId: 'IT_INT_A', productId: 'P_INT_1', categoryId: 'MLB_IT',
    sellerId: 5001, position: 1, unitsSold: 840, periodDays: 30, price: 199.9,
  });
  const [c] = await db.sql`select units_sold, position, source from calibration_points
                            where item_id='IT_INT_A'`;
  ok(Number(c?.units_sold) === 840 && c?.position === 1, 'par de calibração gravado');
  ok(c?.source === 'own_account', 'origem da calibração registrada');

  const p = await rank.posicaoAtual('P_INT_1');
  ok(p === 1, `posicaoAtual devolve a última posição (veio ${p})`);

  // --- filas ---
  const cats = await rank.categoriasParaRanquear(10, 0);
  ok(Array.isArray(cats), `categoriasParaRanquear responde (${cats.length} pendentes)`);

  const prods = await rank.produtosParaSincronizar(10, 0);
  ok(prods.some((x) => x.id === 'P_INT_1'), 'produto rankeado entra na fila de sincronização');

  // --- métricas ---
  await rank.refreshRankMetrics(false);
  const [m] = await db.sql`select position_now, listings, median_price
                             from product_search_view where product_id='P_INT_1'`;
  ok(m?.position_now === 1, 'view de busca reflete a posição atual');
  ok(Number(m?.listings) === 2, `view conta os anúncios com preço (veio ${m?.listings})`);

  console.log('\n  ─────────────────────────────────');
  console.log(falhas === 0 ? '  Tudo passou.\n' : `  ${falhas} falha(s).\n`);
  await db.sql.end();
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n  EXCEÇÃO:', e.message);
  await db.sql.end();
  process.exit(1);
});
