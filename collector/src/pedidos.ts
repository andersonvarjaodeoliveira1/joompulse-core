/**
 * Atende os pedidos de coleta vindos da extensão.
 *
 * Quando alguém abre no Mercado Livre um produto que está fora da nossa
 * cobertura, a extensão registra o pedido em collect_requests junto com
 * a categoria que leu do rastro de navegação da página.
 *
 * Este job fecha o ciclo: lê a fila, coleta o ranking daquelas
 * categorias e resolve cada anúncio.
 *
 * Caminho de resolução (28/07/2026):
 *   1. Ranking da categoria (top 20) — pode trazer o produto por sorte
 *   2. /items?ids= — quase sempre 403 pra terceiro; mantido barato
 *   3. /products/{mlb} — se o id for de catálogo (URL /p/...)
 *   4. /products/search?q=titulo — achado ao vivo: funciona pra terceiro
 *      + /products/{id}/items pra gravar concorrentes
 *
 * "sem_item" só quando a busca de catálogo também falha.
 * "sem_destaque" só quando falha o catálogo E a categoria não tem
 * ranking público — antes, categoria sem highlights marcava o pedido
 * cedo demais e impedia o passo 4.
 */
import { MlClient, NotFoundError, type MlProductItem } from './ml-client.js';
import { sql } from './db.js';
import * as db from './db.js';
import * as rank from './db-rank.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

interface Pedido {
  id: number;
  mlb: string;
  category_id: string | null;
  pedidos: number;
  snapshot: { titulo?: string; imagem?: string; preco?: number } | null;
}

/** Sincroniza ficha + concorrentes de um produto de catálogo. */
async function sincronizarCatalogo(
  ml: MlClient,
  productId: string,
  categoryId: string | null,
): Promise<MlProductItem[]> {
  if (categoryId) {
    await rank.upsertCatalogProducts([{ id: productId, categoryId }]);
  } else {
    // Sem categoria no pedido: cria o produto sem inventar categoria.
    await sql`
      insert into catalog_products (id) values (${productId})
      on conflict (id) do update set last_seen_at = now()
    `;
  }
  try {
    const ficha = await ml.product(productId);
    if (ficha) await rank.enrichProduct(ficha);
  } catch { /* ficha opcional */ }

  try {
    const r = await ml.productItems(productId, 100);
    const itens = r?.results ?? [];
    if (itens.length) {
      const cat = categoryId ?? itens[0]?.category_id ?? null;
      await rank.upsertProductItems(productId, cat, itens);
    }
    return itens;
  } catch (e) {
    if (!(e instanceof NotFoundError)) {
      log(`  productItems ${productId}: ${e instanceof Error ? e.message : e}`);
    }
    return [];
  }
}

async function marcarAtendido(id: number, productId: string) {
  await sql`
    update collect_requests
       set status = 'atendido', atendido_em = now(), product_id = ${productId}
     where id = ${id}
  `;
}

/**
 * Resolve um pedido sem depender de /items (403).
 * Retorna o catalog_product_id se achou, null se não.
 */
async function resolverViaCatalogo(ml: MlClient, p: Pedido): Promise<string | null> {
  // 1) O id já é de catálogo? (página /p/MLB...)
  try {
    const ficha = await ml.product(p.mlb);
    if (ficha?.id) {
      await sincronizarCatalogo(ml, ficha.id, p.category_id);
      return ficha.id;
    }
  } catch {
    // Não é catálogo (404/400) — segue pra busca por texto
  }

  // 2) Busca por título capturado na página pela extensão
  const titulo = p.snapshot?.titulo?.trim();
  if (!titulo || titulo.length < 3) return null;

  try {
    const busca = await ml.searchProducts(titulo, 5);
    const candidatos = busca?.results ?? [];
    if (!candidatos.length) return null;

    // Preferir candidato cuja lista de anúncios contenha o MLB pedido.
    for (const cand of candidatos) {
      const itens = await sincronizarCatalogo(ml, cand.id, p.category_id);
      if (itens.some((i) => i.item_id === p.mlb)) return cand.id;
    }

    // Nenhum candidato listou o MLB (limite da API). O 1º resultado da
    // busca por título é o produto de catálogo mais próximo — é o que o
    // ranking cobre e o que dá pra monitorar. Sem inventar que o anúncio
    // específico entrou em items: o vínculo fica em product_id do pedido
    // + stub mínimo em items pro join de meus_pedidos.
    const top = candidatos[0];
    await sincronizarCatalogo(ml, top.id, p.category_id);

    if (p.category_id) {
      await sql`
        insert into categories (id, name) values (${p.category_id}, '(pendente)')
        on conflict (id) do nothing
      `;
    }
    await sql`
      insert into items (id, title, category_id, catalog_product_id, is_catalog_listing, status, collect_priority)
      values (
        ${p.mlb},
        ${titulo},
        ${p.category_id},
        ${top.id},
        true,
        'active',
        2
      )
      on conflict (id) do update set
        catalog_product_id = coalesce(items.catalog_product_id, excluded.catalog_product_id),
        title = case when items.title like '(catálogo)%' then excluded.title else items.title end,
        collect_priority = greatest(items.collect_priority, excluded.collect_priority),
        last_seen_at = now()
    `;
    return top.id;
  } catch (e) {
    log(`  busca catálogo "${titulo.slice(0, 40)}": ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function atenderPedidos(ml: MlClient, limite = 200) {
  const inicio = Date.now();

  const fila = await sql<Pedido[]>`
    select id, mlb, category_id, pedidos, snapshot
      from collect_requests
     where status = 'pendente'
     order by pedidos desc, criado_em asc
     limit ${limite}
  `;

  if (!fila.length) {
    log('nenhum pedido de coleta pendente');
    return 0;
  }

  log(`${fila.length} pedido(s) na fila`);

  const porCategoria = new Map<string, Pedido[]>();
  const semCategoria: Pedido[] = [];

  for (const p of fila) {
    if (!p.category_id) { semCategoria.push(p); continue; }
    const lista = porCategoria.get(p.category_id) ?? [];
    lista.push(p);
    porCategoria.set(p.category_id, lista);
  }

  log(`  ${porCategoria.size} categoria(s) distintas, ${semCategoria.length} pedido(s) sem categoria`);

  // Categorias sem ranking público — NÃO marca o pedido ainda.
  // O passo 3 (busca de catálogo) ainda pode resolver e liberar Monitorar.
  const semRanking = new Set<string>();
  let produtosNovos = 0;

  for (const [cat, _pedidos] of porCategoria) {
    try {
      const d = await ml.highlights(cat);
      const conteudo = d?.content ?? [];

      if (!conteudo.length) {
        semRanking.add(cat);
        continue;
      }

      const produtos = conteudo.filter((x) => x.type === 'PRODUCT' && x.id);
      if (produtos.length) {
        produtosNovos += await rank.upsertCatalogProducts(
          produtos.map((x) => ({ id: x.id, categoryId: cat })),
        );
      }
      await rank.insertRankSnapshots(cat, conteudo);

      await sql`
        update catalog_products set last_synced_at = null
         where category_id = ${cat} and last_synced_at is not null
      `;
    } catch (e) {
      if (e instanceof NotFoundError) {
        semRanking.add(cat);
      } else {
        log(`  categoria ${cat}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (semRanking.size) {
    log(`  ${semRanking.size} categoria(s) sem ranking — pedidos seguem pro catálogo`);
  }
  if (semCategoria.length) {
    log(`  ${semCategoria.length} pedido(s) sem categoria — resolvem via título`);
  }

  let atendidos = 0;
  let semItem = 0;
  let semDestaque = 0;

  const restantes = await sql<Pedido[]>`
    select id, mlb, category_id, pedidos, snapshot from collect_requests
     where id = any(${fila.map((p) => p.id)}::bigint[]) and status = 'pendente'
  `;

  // Passo 2: /items?ids= — barato, quase sempre vazio pra terceiro.
  if (restantes.length) {
    try {
      const encontrados = await ml.itemsMulti(restantes.map((p) => p.mlb));
      if (encontrados.length) {
        produtosNovos += await rank.upsertItensDiretos(encontrados);
        const idsEncontrados = new Set(encontrados.map((i) => i.id));
        for (const p of restantes.filter((x) => idsEncontrados.has(x.mlb))) {
          const prod = encontrados.find((i) => i.id === p.mlb)?.catalog_product_id;
          if (prod) await marcarAtendido(p.id, prod);
          else {
            await sql`
              update collect_requests set status = 'atendido', atendido_em = now()
               where id = ${p.id}
            `;
          }
          atendidos++;
        }
      }
    } catch (e) {
      log(`  multiget: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Passo 3: catálogo — o caminho que funciona de verdade (28/07).
  const ainda = await sql<Pedido[]>`
    select id, mlb, category_id, pedidos, snapshot from collect_requests
     where id = any(${fila.map((p) => p.id)}::bigint[]) and status = 'pendente'
  `;

  for (const p of ainda) {
    const productId = await resolverViaCatalogo(ml, p);
    if (productId) {
      await marcarAtendido(p.id, productId);
      atendidos++;
      produtosNovos++;
      log(`  ✓ ${p.mlb} → ${productId}`);
      continue;
    }

    // Catálogo falhou: distingue "categoria sem ranking" de "anúncio
    // inacessível" — ambos honestos, ações diferentes pra quem lê.
    const statusFinal = (p.category_id && semRanking.has(p.category_id))
      ? 'sem_destaque'
      : 'sem_item';
    await sql`
      update collect_requests set status = ${statusFinal}, atendido_em = now()
       where id = ${p.id}
    `;
    if (statusFinal === 'sem_destaque') semDestaque++;
    else semItem++;
    log(`  ✗ ${p.mlb} → ${statusFinal} (título: ${p.snapshot?.titulo?.slice(0, 40) ?? '—'})`);
  }

  await db.logRun({
    jobType: 'atender_pedidos',
    ok: true,
    itemsSeen: produtosNovos,
    apiCalls: ml.callCount,
    durationMs: Date.now() - inicio,
  });

  log(`pedidos: ${atendidos} atendido(s), ${semItem} sem catálogo, ` +
      `${semDestaque} sem ranking+catálogo, ${produtosNovos} produto(s) tocados`);
  return atendidos;
}

/** Resumo da fila, para saber onde a cobertura está doendo. */
export async function statusPedidos() {
  const linhas = await sql<{ status: string; n: number; pedidos: number }[]>`
    select status, count(*)::int as n, sum(pedidos)::int as pedidos
      from collect_requests group by status order by n desc
  `;
  console.log('\n  Fila de pedidos de coleta');
  console.log('  ─────────────────────────────────────');
  if (!linhas.length) { console.log('  vazia\n'); return; }
  for (const l of linhas) {
    console.log(`  ${l.status.padEnd(14)} ${String(l.n).padStart(5)} anúncio(s)  ${l.pedidos} pedido(s)`);
  }

  const top = await sql<{ mlb: string; pedidos: number; category_id: string | null }[]>`
    select mlb, pedidos, category_id from collect_requests
     where status = 'pendente' order by pedidos desc limit 5
  `;
  if (top.length) {
    console.log('\n  Mais pedidos:');
    top.forEach((t) => console.log(`    ${t.mlb}  ${t.pedidos}x  ${t.category_id ?? '(sem categoria)'}`));
  }
  console.log();
}
