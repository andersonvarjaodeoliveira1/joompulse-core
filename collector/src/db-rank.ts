/**
 * Camada de banco do caminho de ranking.
 *
 * Separado de db.ts de propósito: o fluxo antigo (busca -> anúncio ->
 * sold_quantity) continua no arquivo original, morto mas intacto, caso
 * o Mercado Livre reabra o endpoint. Este aqui é o caminho vivo.
 */
import { sql, captureDate } from './db.js';
import type { MlHighlight, MlItem, MlProduct, MlProductItem } from './ml-client.js';

// ---------------------------------------------------------------------
// PRODUTOS DE CATÁLOGO
// ---------------------------------------------------------------------
export async function upsertCatalogProducts(
  produtos: { id: string; categoryId: string; name?: string | null; tipo?: string }[],
) {
  if (!produtos.length) return 0;

  const catIds = [...new Set(produtos.map((p) => p.categoryId))];
  await sql`
    insert into categories (id, name)
    select unnest(${catIds}::text[]), '(pendente)'
    on conflict (id) do nothing
  `;

  const linhas = produtos.map((p) => ({
    id: p.id,
    category_id: p.categoryId,
    name: p.name ?? null,
    tipo: p.tipo ?? 'PRODUCT',
  }));

  await sql`
    insert into catalog_products ${sql(linhas)}
    on conflict (id) do update set
      category_id = excluded.category_id,
      name = coalesce(excluded.name, catalog_products.name),
      tipo = excluded.tipo,
      last_seen_at = now()
  `;
  return linhas.length;
}

export async function enrichProduct(p: MlProduct) {
  await sql`
    update catalog_products set
      name = coalesce(${p.name ?? null}, name),
      brand = ${p.attributes?.find((a) => a.id === 'BRAND')?.value_name ?? null},
      model = ${p.attributes?.find((a) => a.id === 'MODEL')?.value_name ?? null},
      picture = ${p.pictures?.[0]?.url ?? null},
      permalink = ${p.permalink ?? null},
      status = ${p.status ?? 'active'},
      last_synced_at = now()
    where id = ${p.id}
  `;
}

// ---------------------------------------------------------------------
// SNAPSHOTS DE POSIÇÃO — o sinal de demanda
// ---------------------------------------------------------------------
export async function insertRankSnapshots(
  categoryId: string,
  destaques: MlHighlight[],
) {
  // Grava os TRÊS tipos que o Mercado Livre devolve desde 24/07/2026.
  //
  // A versão anterior filtrava só PRODUCT e descartava o resto em
  // silêncio. Quando o ML mudou o formato, uma varredura inteira de 404
  // categorias com 20 destaques cada foi perdida — o código achou que
  // não havia dado, quando havia 8.080 posições.
  //
  // Estar em 3º lugar significa a mesma coisa nos três casos. O tipo
  // muda o que dá para enriquecer depois, não a validade do ranking.
  const validos = destaques.filter((d) => d.id);
  if (!validos.length) return 0;

  const agora = new Date();
  const data = captureDate(agora);

  const linhas = validos.map((d, i) => ({
    product_id: d.id,
    category_id: categoryId,
    captured_at: agora,
    captured_date: data,
    position: d.position ?? i + 1,
    tipo: d.type ?? 'DESCONHECIDO',
  }));

  await sql`
    insert into product_rank_snapshots ${sql(linhas)}
    on conflict (product_id, category_id, captured_at) do nothing
  `;
  return linhas.length;
}

// ---------------------------------------------------------------------
// ANÚNCIOS QUE DISPUTAM UM PRODUTO
//
// É aqui que mora a análise de concorrência: um produto, N vendedores,
// preço de cada um. O endpoint bloqueado nunca daria isso tão limpo.
// ---------------------------------------------------------------------
export async function upsertProductItems(
  productId: string,
  categoryIdFallback: string | null,
  itens: MlProductItem[],
) {
  if (!itens.length) return { anuncios: 0, snapshots: 0 };

  const sellerIds = [...new Set(itens.map((i) => i.seller_id).filter(Boolean))] as number[];
  if (sellerIds.length) {
    await sql`
      insert into sellers (id) select unnest(${sellerIds}::bigint[])
      on conflict (id) do nothing
    `;
  }
  const catIds = [...new Set(itens.map((i) => i.category_id).filter(Boolean))] as string[];
  if (catIds.length) {
    await sql`
      insert into categories (id, name) select unnest(${catIds}::text[]), '(pendente)'
      on conflict (id) do nothing
    `;
  }

  const linhas = itens.map((i) => ({
    id: i.item_id,
    title: `(catálogo) ${productId}`,
    category_id: i.category_id ?? categoryIdFallback,
    seller_id: i.seller_id ?? null,
    catalog_product_id: productId,
    is_catalog_listing: true,
    listing_type_id: i.listing_type_id ?? null,
    condition: i.condition ?? null,
    shipping_free: i.shipping?.free_shipping ?? false,
    shipping_logistic_type: i.shipping?.logistic_type ?? null,
    official_store_id: i.official_store_id ?? null,
    status: 'active',
    collect_priority: 1,
  }));

  await sql`
    insert into items ${sql(linhas)}
    on conflict (id) do update set
      category_id = coalesce(excluded.category_id, items.category_id),
      seller_id = excluded.seller_id,
      catalog_product_id = excluded.catalog_product_id,
      is_catalog_listing = true,
      listing_type_id = excluded.listing_type_id,
      shipping_free = excluded.shipping_free,
      shipping_logistic_type = excluded.shipping_logistic_type,
      official_store_id = excluded.official_store_id,
      collect_priority = greatest(items.collect_priority, excluded.collect_priority),
      last_seen_at = now()
  `;

  // Snapshot de preço. sold_quantity fica nulo: a API não entrega para
  // anúncio de terceiro, e inventar zero seria pior que deixar vazio.
  const agora = new Date();
  const data = captureDate(agora);
  const snaps = itens
    .filter((i) => i.price != null)
    .map((i) => ({
      item_id: i.item_id,
      captured_at: agora,
      captured_date: data,
      price: i.price ?? null,
      original_price: i.original_price ?? null,
      sold_quantity: null,
      seller_id: i.seller_id ?? null,
    }));

  if (snaps.length) {
    await sql`
      insert into item_snapshots ${sql(snaps)}
      on conflict (item_id, captured_at) do nothing
    `;
  }

  await sql`update catalog_products set last_synced_at = now() where id = ${productId}`;
  return { anuncios: linhas.length, snapshots: snaps.length };
}

// ---------------------------------------------------------------------
// ANÚNCIO PEDIDO DIRETAMENTE — atende pedido da extensão sem depender
// de sorte no ranking.
//
// /items/{id} de terceiro dá 403, mas /items?ids= (multiget) responde.
// É a única forma de confirmar que UM anúncio específico existe sem
// esperar ele aparecer nos destaques de uma categoria — o que pode
// nunca acontecer, já que highlights só traz o top 20.
// ---------------------------------------------------------------------
export async function upsertItensDiretos(itens: MlItem[]) {
  if (!itens.length) return 0;

  const catIds = [...new Set(itens.map((i) => i.category_id).filter(Boolean))] as string[];
  if (catIds.length) {
    await sql`
      insert into categories (id, name) select unnest(${catIds}::text[]), '(pendente)'
      on conflict (id) do nothing
    `;
  }

  const sellerIds = [...new Set(itens.map((i) => i.seller_id).filter(Boolean))] as number[];
  if (sellerIds.length) {
    await sql`
      insert into sellers (id) select unnest(${sellerIds}::bigint[])
      on conflict (id) do nothing
    `;
  }

  const linhas = itens.map((i) => ({
    id: i.id,
    title: i.title ?? `(sem título) ${i.id}`,
    category_id: i.category_id ?? null,
    seller_id: i.seller_id ?? null,
    catalog_product_id: i.catalog_product_id ?? null,
    is_catalog_listing: !!i.catalog_product_id,
    listing_type_id: i.listing_type_id ?? null,
    condition: i.condition ?? null,
    shipping_free: i.shipping?.free_shipping ?? false,
    shipping_logistic_type: i.shipping?.logistic_type ?? null,
    official_store_id: i.official_store_id ?? null,
    permalink: i.permalink ?? null,
    thumbnail: i.thumbnail ?? i.secure_thumbnail ?? null,
    status: i.status ?? 'active',
    collect_priority: 1,
  }));

  await sql`
    insert into items ${sql(linhas)}
    on conflict (id) do update set
      title = excluded.title,
      category_id = coalesce(excluded.category_id, items.category_id),
      seller_id = excluded.seller_id,
      catalog_product_id = excluded.catalog_product_id,
      is_catalog_listing = excluded.is_catalog_listing,
      listing_type_id = excluded.listing_type_id,
      condition = excluded.condition,
      shipping_free = excluded.shipping_free,
      shipping_logistic_type = excluded.shipping_logistic_type,
      official_store_id = excluded.official_store_id,
      permalink = excluded.permalink,
      thumbnail = excluded.thumbnail,
      status = excluded.status,
      collect_priority = greatest(items.collect_priority, excluded.collect_priority),
      last_seen_at = now()
  `;

  // Produto de catálogo por trás do anúncio: sem isso o item entra sem
  // catalog_product_id resolvido em catalog_products, e "Monitorar" fica
  // preso — tracked_products.product_id tem FK para catalog_products.
  const produtos = itens.filter((i) => i.catalog_product_id && i.category_id);
  if (produtos.length) {
    await upsertCatalogProducts(
      produtos.map((i) => ({ id: i.catalog_product_id as string, categoryId: i.category_id as string })),
    );
  }

  const agora = new Date();
  const data = captureDate(agora);
  const snaps = itens
    .filter((i) => i.price != null)
    .map((i) => ({
      item_id: i.id,
      captured_at: agora,
      captured_date: data,
      price: i.price ?? null,
      original_price: i.original_price ?? null,
      sold_quantity: null,
      seller_id: i.seller_id ?? null,
    }));

  if (snaps.length) {
    await sql`
      insert into item_snapshots ${sql(snaps)}
      on conflict (item_id, captured_at) do nothing
    `;
  }

  return linhas.length;
}

// ---------------------------------------------------------------------
// CALIBRAÇÃO
//
// Um par real: "este anúncio, nesta posição, vendeu tantas unidades".
// Só existe para contas conectadas, onde o sold_quantity é acessível
// porque o token pertence ao dono.
// ---------------------------------------------------------------------
export async function gravarCalibracao(p: {
  itemId: string;
  productId?: string | null;
  categoryId: string | null;
  sellerId?: number | null;
  position: number | null;
  unitsSold: number;
  periodDays: number;
  price?: number | null;
  source?: string;
}) {
  await sql`
    insert into calibration_points
      (item_id, product_id, category_id, seller_id, observed_on,
       position, units_sold, period_days, price, source)
    values (
      ${p.itemId}, ${p.productId ?? null}, ${p.categoryId}, ${p.sellerId ?? null},
      ${captureDate()}, ${p.position}, ${p.unitsSold}, ${p.periodDays},
      ${p.price ?? null}, ${p.source ?? 'own_account'}
    )
  `;
}

/** Posição atual de um produto, se ele estiver rankeado. */
export async function posicaoAtual(productId: string): Promise<number | null> {
  const [r] = await sql<{ position: number }[]>`
    select position from product_rank_snapshots
     where product_id = ${productId}
     order by captured_at desc limit 1
  `;
  return r?.position ?? null;
}

// ---------------------------------------------------------------------
// FILAS DE TRABALHO
// ---------------------------------------------------------------------

/**
 * Categorias folha que ainda não foram lidas HOJE.
 *
 * A primeira versão usava "não lida nas últimas 20 horas", e isso
 * quebrava a cadência diária: se a varredura de ontem terminou às 19h e
 * a rodada de hoje roda às 9h, passaram 14 horas e o job pulava tudo —
 * o dia inteiro sem segunda leitura, que é justamente o que faz o
 * movimento existir.
 *
 * Comparar por DATA (no fuso de São Paulo, onde o dia comercial
 * acontece) torna o resultado independente do horário em que cada
 * rodada roda.
 */
export async function categoriasParaRanquear(limite: number, forcar = false) {
  const hoje = captureDate();
  return sql<{ id: string }[]>`
    select c.id
      from categories c
      left join lateral (
        select max(captured_date) as ultimo_dia
          from product_rank_snapshots s
         where s.category_id = c.id
      ) s on true
     where c.is_leaf
       and (
         ${forcar}
         or s.ultimo_dia is null
         or s.ultimo_dia < ${hoje}::date
       )
       -- Categoria que falhou 3 vezes seguidas passa para releitura
       -- semanal. Não é desistência: se o Mercado Livre voltar a
       -- publicar destaques ali, ela volta ao ritmo diário na hora.
       and (
         ${forcar}
         or c.rank_falhas < 3
         or c.rank_ultima_falha is null
         or c.rank_ultima_falha <= current_date - 7
       )
     order by c.rank_falhas asc, s.ultimo_dia asc nulls first,
              coalesce(c.total_items_ml, 0) desc
     limit ${limite}
  `;
}

/** Anota se a categoria devolveu destaques, para calibrar a frequência. */
export async function registrarRanking(categoryId: string, teve: boolean) {
  await sql`select registrar_ranking(${categoryId}, ${teve})`;
}

export async function saudeCobertura() {
  const [r] = await sql<{
    folhas: number; com_ranking: number; instaveis: number;
    adormecidas: number; nunca_tentadas: number;
  }[]>`select * from saude_cobertura`;
  return r;
}

/** Produtos rankeados que precisam da lista de concorrentes atualizada. */
export async function produtosParaSincronizar(limite: number, dias = 2) {
  return sql<{ id: string; category_id: string | null }[]>`
    select p.id, p.category_id
      from catalog_products p
     where p.status = 'active'
       -- ITEM e USER_PRODUCT não aceitam /products/{id}/items; buscar
       -- concorrentes deles só gastaria chamada para tomar 404.
       and p.tipo = 'PRODUCT'
       and (p.last_synced_at is null
            or p.last_synced_at::date < current_date - (${dias})::int)
       and exists (select 1 from product_rank_snapshots s where s.product_id = p.id)
     order by p.last_synced_at asc nulls first
     limit ${limite}
  `;
}

export async function refreshRankMetrics(concurrent = true) {
  await sql`select refresh_rank_metrics(${concurrent})`;
}

/**
 * Gera os alertas do Monitor comparando a leitura de hoje com a
 * anterior. Precisa rodar DEPOIS do refresh das métricas, senão compara
 * contra dado velho. É idempotente: rodar duas vezes no mesmo dia não
 * duplica nada.
 */
export async function gerarAlertas(): Promise<number> {
  const [r] = await sql<{ gerar_alertas: number }[]>`select gerar_alertas()`;
  return r?.gerar_alertas ?? 0;
}

export { sql };
