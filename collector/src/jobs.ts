/**
 * Os quatro trabalhos da coleta.
 *
 * syncCategories  — desce a árvore inteira. Roda 1x por semana.
 * discoverItems   — descobre anúncios novos numa categoria. Diário nas
 *                   categorias quentes, semanal no resto.
 * refreshItems    — recaptura preço e sold_quantity dos anúncios já
 *                   conhecidos. É ESTE job que gera o histórico. Diário.
 * syncSellers     — reputação e localização. Semanal.
 */
import { MlClient, NotFoundError } from './ml-client.js';
import * as db from './db.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------
export async function syncCategories(ml: MlClient) {
  const started = Date.now();
  let count = 0;

  const roots = await ml.categoriesRoot();
  log(`categorias raiz: ${roots.length}`);

  async function walk(id: string, parentId: string | null, rootId: string, level: number) {
    let cat;
    try {
      cat = await ml.category(id);
    } catch (e) {
      if (e instanceof NotFoundError) return;
      throw e;
    }

    const children = cat.children_categories ?? [];
    await db.upsertCategory(cat, {
      parentId,
      rootId,
      level,
      isLeaf: children.length === 0,
    });
    count++;

    for (const child of children) {
      await walk(child.id, id, rootId, level + 1);
    }
  }

  for (const root of roots) {
    await walk(root.id, null, root.id, 0);
    log(`  ${root.name} ok (${count} acumuladas)`);
  }

  await db.logRun({
    jobType: 'sync_categories',
    ok: true,
    itemsSeen: count,
    apiCalls: ml.callCount,
    durationMs: Date.now() - started,
  });
  return count;
}

// ---------------------------------------------------------------------
/**
 * Varre uma categoria e registra os anúncios encontrados.
 *
 * O ML corta a paginação em offset 1000, então de uma categoria só dá
 * para tirar ~1.000 anúncios por ordenação. Para pegar mais, varra as
 * subcategorias folha em vez do pai.
 */
export async function discoverItems(
  ml: MlClient,
  categoryId: string,
  opts: { maxItems?: number; priority?: number } = {},
) {
  const started = Date.now();
  const maxItems = Math.min(opts.maxItems ?? 1000, 1000);
  const priority = opts.priority ?? 1;

  let offset = 0;
  let seen = 0;
  let snaps = 0;

  try {
    while (offset < maxItems) {
      const res = await ml.search({ category: categoryId, offset, limit: 50 });
      const results = res.results ?? [];
      if (!results.length) break;

      const positions = new Map<string, number>();
      results.forEach((it, i) => positions.set(it.id, offset + i + 1));

      await db.upsertItems(results, priority);
      snaps += await db.insertItemSnapshots(results, { positions });
      seen += results.length;

      offset += results.length;
      if (offset >= (res.paging?.total ?? 0)) break;
    }

    await db.logRun({
      jobType: 'discover_items',
      target: categoryId,
      ok: true,
      itemsSeen: seen,
      snapshots: snaps,
      apiCalls: ml.callCount,
      durationMs: Date.now() - started,
    });
    log(`discover ${categoryId}: ${seen} anúncios, ${snaps} snapshots`);
    return seen;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.logRun({
      jobType: 'discover_items',
      target: categoryId,
      ok: false,
      itemsSeen: seen,
      snapshots: snaps,
      error: msg,
      durationMs: Date.now() - started,
    });
    throw e;
  }
}

// ---------------------------------------------------------------------
/**
 * O job mais importante do sistema.
 *
 * Cada execução grava um ponto novo na série de cada anúncio. Sem ele
 * você tem um catálogo estático; com ele, 30 dias depois, você tem
 * vendas estimadas, tendência e histórico de preço — que é o produto.
 *
 * Não pule dias. Buraco na série vira buraco no gráfico do cliente.
 */
export async function refreshItems(ml: MlClient, opts: { batch?: number } = {}) {
  const started = Date.now();
  const batch = opts.batch ?? 5000;

  const due = await db.itemsDueForRefresh(batch);
  if (!due.length) {
    log('nada para recapturar');
    return 0;
  }
  log(`recapturando ${due.length} anúncios`);

  const ids = due.map((r) => r.id);
  let snaps = 0;
  let processed = 0;

  // O multiget aceita 20 por chamada; agrupamos de 200 em 200 para
  // escrever no banco em lotes decentes.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    try {
      const items = await ml.itemsMulti(chunk);
      await db.upsertItems(items);
      snaps += await db.insertItemSnapshots(items);
      processed += items.length;

      if (i % 2000 === 0 && i > 0) log(`  ${i}/${ids.length}`);
    } catch (e) {
      log(`  lote ${i} falhou: ${e instanceof Error ? e.message : e}`);
    }
  }

  await db.logRun({
    jobType: 'refresh_items',
    ok: true,
    itemsSeen: processed,
    snapshots: snaps,
    apiCalls: ml.callCount,
    durationMs: Date.now() - started,
  });
  log(`refresh: ${processed} anúncios, ${snaps} snapshots`);
  return snaps;
}

// ---------------------------------------------------------------------
export async function syncSellers(ml: MlClient, opts: { limit?: number; concorrencia?: number } = {}) {
  const started = Date.now();
  const limit = opts.limit ?? 1000;

  const rows = await db.sql<{ id: number }[]>`
    select id from sellers
     where last_synced_at is null or last_synced_at < now() - interval '7 days'
     order by last_synced_at asc nulls first
     limit ${limit}
  `;

  let ok = 0;

  // Mesmo gargalo já visto em sincronizarProdutos: um "for" sequencial
  // fica ocioso esperando o round-trip de rede em vez de saturar o
  // rate limiter. Lanes concorrentes puxando da mesma fila, mesmo
  // TokenBucket compartilhado como único limitador real de req/s.
  const lanes = Math.max(1, opts.concorrencia ?? 8);
  let cursor = 0;
  async function lane() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const user = await ml.user(row.id);
        await db.upsertSeller(user);
        ok++;
      } catch (e) {
        if (!(e instanceof NotFoundError)) {
          log(`  vendedor ${row.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane));

  await db.logRun({
    jobType: 'sync_sellers',
    ok: true,
    itemsSeen: ok,
    apiCalls: ml.callCount,
    durationMs: Date.now() - started,
  });
  log(`vendedores sincronizados: ${ok}/${rows.length}`);
  return ok;
}

// ---------------------------------------------------------------------
/**
 * Semeadura inicial. Popula a árvore de categorias — é dela que
 * categoriasParaRanquear() tira o que ler todo dia.
 *
 * NÃO enfileira mais discover_items. O /sites/MLB/search devolve 403
 * desde 2026 (ver README) e o caminho de ranking não usa fila:
 * rodadaDiaria() chama coletarRanking() direto.
 */
export async function seed(ml: MlClient, _topCategories = 200) {
  await db.ensurePartitions();
  const n = await syncCategories(ml);
  log(`${n} categorias gravadas`);
  log('agora rode: npm run collect rodada');
  return n;
}