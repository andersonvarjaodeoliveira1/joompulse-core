/**
 * Camada de banco. Escreve direto no Postgres do Supabase (não via
 * supabase-js) porque a coleta faz inserts em lote de milhares de linhas
 * e o REST não aguenta isso com eficiência.
 *
 * Use a connection string do "Session pooler" ou "Direct connection" —
 * a do Transaction pooler (porta 6543) não suporta prepared statements.
 */
import postgres from 'postgres';
import type { MlItem, MlUser, MlCategory } from './ml-client.js';

export const sql = postgres(process.env.DATABASE_URL!, {
  max: Number(process.env.DB_POOL ?? 5),
  prepare: false,
  onnotice: () => {},
});

/** Data de captura no fuso de São Paulo — não em UTC. */
export function captureDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function attr(item: MlItem, id: string): string | null {
  return item.attributes?.find((a) => a.id === id)?.value_name ?? null;
}

// ---------------------------------------------------------------------
// CATEGORIAS
// ---------------------------------------------------------------------
export async function upsertCategory(
  cat: MlCategory,
  extra: { parentId: string | null; rootId: string | null; level: number; isLeaf: boolean },
) {
  const pathIds = cat.path_from_root?.map((p) => p.id) ?? [];
  const pathNames = cat.path_from_root?.map((p) => p.name) ?? [cat.name];

  await sql`
    insert into categories
      (id, name, parent_id, root_id, path_ids, path_names, level, is_leaf,
       total_items_ml, last_synced_at)
    values (
      ${cat.id}, ${cat.name}, ${extra.parentId}, ${extra.rootId},
      ${pathIds}, ${pathNames}, ${extra.level}, ${extra.isLeaf},
      ${cat.total_items_in_this_category ?? null}, now()
    )
    on conflict (id) do update set
      name = excluded.name,
      parent_id = excluded.parent_id,
      root_id = excluded.root_id,
      path_ids = excluded.path_ids,
      path_names = excluded.path_names,
      level = excluded.level,
      is_leaf = excluded.is_leaf,
      total_items_ml = excluded.total_items_ml,
      last_synced_at = now()
  `;
}

export async function leafCategories(limit?: number) {
  return sql<{ id: string; name: string; total_items_ml: number | null }[]>`
    select id, name, total_items_ml
      from categories
     where is_leaf = true
     order by coalesce(total_items_ml, 0) desc
     ${limit ? sql`limit ${limit}` : sql``}
  `;
}

// ---------------------------------------------------------------------
// ANÚNCIOS
// ---------------------------------------------------------------------
export async function upsertItems(items: MlItem[], priority = 0) {
  if (!items.length) return 0;

  const rows = items.map((it) => ({
    id: it.id,
    title: it.title ?? '',
    category_id: it.category_id ?? null,
    seller_id: it.seller_id ?? it.seller?.id ?? null,
    brand: attr(it, 'BRAND'),
    model: attr(it, 'MODEL'),
    catalog_product_id: it.catalog_product_id ?? null,
    is_catalog_listing: it.catalog_listing ?? false,
    listing_type_id: it.listing_type_id ?? null,
    condition: it.condition ?? null,
    shipping_free: it.shipping?.free_shipping ?? false,
    shipping_logistic_type: it.shipping?.logistic_type ?? null,
    official_store_id: it.official_store_id ?? null,
    permalink: it.permalink ?? null,
    thumbnail: it.secure_thumbnail ?? it.thumbnail ?? null,
    ml_date_created: it.date_created ?? null,
    status: it.status ?? 'active',
    collect_priority: priority,
  }));

  // Categoria pode ainda não existir no nosso banco — a FK derrubaria o
  // lote inteiro. Insere o esqueleto antes.
  const catIds = [...new Set(rows.map((r) => r.category_id).filter(Boolean))] as string[];
  if (catIds.length) {
    await sql`
      insert into categories (id, name)
      select unnest(${catIds}::text[]), '(pendente)'
      on conflict (id) do nothing
    `;
  }
  const sellerIds = [...new Set(rows.map((r) => r.seller_id).filter(Boolean))] as number[];
  if (sellerIds.length) {
    await sql`
      insert into sellers (id)
      select unnest(${sellerIds}::bigint[])
      on conflict (id) do nothing
    `;
  }

  await sql`
    insert into items ${sql(rows)}
    on conflict (id) do update set
      title = excluded.title,
      category_id = excluded.category_id,
      seller_id = excluded.seller_id,
      brand = coalesce(excluded.brand, items.brand),
      listing_type_id = excluded.listing_type_id,
      shipping_free = excluded.shipping_free,
      shipping_logistic_type = excluded.shipping_logistic_type,
      official_store_id = excluded.official_store_id,
      permalink = excluded.permalink,
      thumbnail = excluded.thumbnail,
      status = excluded.status,
      collect_priority = greatest(items.collect_priority, excluded.collect_priority),
      last_seen_at = now()
  `;
  return rows.length;
}

// ---------------------------------------------------------------------
// SNAPSHOTS — o dado que vira produto
// ---------------------------------------------------------------------
export async function insertItemSnapshots(
  items: MlItem[],
  opts: { positions?: Map<string, number> } = {},
) {
  if (!items.length) return 0;
  const date = captureDate();

  const rows = items
    .filter((it) => it.price != null || it.sold_quantity != null)
    .map((it) => ({
      item_id: it.id,
      captured_at: new Date(),
      captured_date: date,
      price: it.price ?? null,
      original_price: it.original_price ?? null,
      sold_quantity: it.sold_quantity ?? null,
      available_quantity: it.available_quantity ?? null,
      health: it.health ?? null,
      seller_id: it.seller_id ?? it.seller?.id ?? null,
      search_position: opts.positions?.get(it.id) ?? null,
    }));

  if (!rows.length) return 0;

  // Uma captura por anúncio por rodada. Se o mesmo item aparecer em duas
  // buscas no mesmo instante, a PK (item_id, captured_at) absorve.
  await sql`
    insert into item_snapshots ${sql(rows)}
    on conflict (item_id, captured_at) do nothing
  `;
  return rows.length;
}

// ---------------------------------------------------------------------
// VENDEDORES
// ---------------------------------------------------------------------
export async function upsertSeller(u: MlUser) {
  await sql`
    insert into sellers
      (id, nickname, city, state, country, registration_date,
       permalink, last_seen_at, last_synced_at)
    values (
      ${u.id}, ${u.nickname ?? null},
      ${u.address?.city ?? null}, ${u.address?.state ?? null},
      ${u.country_id ?? 'BR'}, ${u.registration_date ?? null},
      ${u.permalink ?? null}, now(), now()
    )
    on conflict (id) do update set
      nickname = excluded.nickname,
      city = excluded.city,
      state = excluded.state,
      registration_date = coalesce(excluded.registration_date, sellers.registration_date),
      permalink = excluded.permalink,
      last_seen_at = now(),
      last_synced_at = now()
  `;

  const rep = u.seller_reputation;
  if (!rep) return;

  await sql`
    insert into seller_snapshots
      (seller_id, captured_at, captured_date, reputation_level, power_seller_status,
       transactions_total, transactions_canceled, claims_rate, delayed_rate)
    values (
      ${u.id}, now(), ${captureDate()},
      ${rep.level_id ?? null}, ${rep.power_seller_status ?? null},
      ${rep.transactions?.total ?? null}, ${rep.transactions?.canceled ?? null},
      ${rep.metrics?.claims?.rate ?? null}, ${rep.metrics?.delayed_handling_time?.rate ?? null}
    )
    on conflict (seller_id, captured_at) do nothing
  `;
}

// ---------------------------------------------------------------------
// FILA E LOG
// ---------------------------------------------------------------------
export async function enqueue(
  jobType: string,
  target: string | null,
  payload: Record<string, string | number | boolean | null> = {},
  priority = 0,
) {
  await sql`
    insert into collect_jobs (job_type, target, payload, priority)
    values (${jobType}, ${target}, ${sql.json(payload)}, ${priority})
  `;
}

export async function claimJob() {
  const [job] = await sql<
    { id: number; job_type: string; target: string | null; payload: Record<string, unknown> }[]
  >`select * from claim_job() where id is not null`;
  return job ?? null;
}

/**
 * Encerra um job. Se falhou e ainda tem tentativa sobrando, volta para
 * a fila com 10 minutos de espera em vez de morrer.
 */
export async function finishJob(id: number, ok: boolean, error?: string) {
  await sql`
    update collect_jobs
       set status = case
             when ${ok} then 'done'
             when attempts < 3 then 'pending'
             else 'failed'
           end,
           finished_at = case when ${ok} then now() else finished_at end,
           last_error = ${error ?? null},
           scheduled_for = case
             when ${!ok} and attempts < 3 then now() + interval '10 minutes'
             else scheduled_for
           end
     where id = ${id}
  `;
}

export async function logRun(entry: {
  jobType: string;
  target?: string | null;
  ok: boolean;
  itemsSeen?: number;
  snapshots?: number;
  apiCalls?: number;
  durationMs?: number;
  error?: string;
}) {
  await sql`
    insert into collect_log
      (job_type, target, ok, items_seen, snapshots, api_calls, duration_ms, error)
    values (
      ${entry.jobType}, ${entry.target ?? null}, ${entry.ok},
      ${entry.itemsSeen ?? 0}, ${entry.snapshots ?? 0}, ${entry.apiCalls ?? 0},
      ${entry.durationMs ?? null}, ${entry.error ?? null}
    )
  `;
}

/** Anúncios que precisam de nova captura, em ordem de prioridade. */
export async function itemsDueForRefresh(limit: number) {
  return sql<{ id: string }[]>`
    select i.id
      from items i
      left join lateral (
        select max(captured_at) as last_at
          from item_snapshots s
         where s.item_id = i.id
      ) s on true
     where i.status = 'active'
       and (
         s.last_at is null
         or (i.collect_priority >= 2 and s.last_at < now() - interval '20 hours')
         or (i.collect_priority = 1 and s.last_at < now() - interval '44 hours')
         or (i.collect_priority = 0 and s.last_at < now() - interval '6 days')
       )
     order by i.collect_priority desc, s.last_at asc nulls first
     limit ${limit}
  `;
}

export async function refreshMetrics(concurrent = true) {
  await sql`select refresh_metrics(${concurrent})`;
}

/**
 * Impede duas coletas simultâneas.
 *
 * Em 24/07 uma rodada e um "rank" foram disparados com 15 minutos de
 * diferença. As duas competiram pelo mesmo limite de API do Mercado
 * Livre e a segunda voltou quase vazia — 3 produtos onde deveriam vir
 * milhares. O pior é que nenhuma das duas acusou erro: cada uma achou
 * que o mercado é que estava sem dados.
 *
 * O lock consultivo do Postgres resolve na raiz: a segunda tentativa
 * descobre na hora que já tem coleta rodando e sai avisando, em vez de
 * estragar o resultado das duas.
 *
 * É por sessão — se o processo morrer, o lock cai junto. Não trava nada
 * para sempre.
 */
const CHAVE_LOCK = 8123471;

export async function travarColeta(): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${CHAVE_LOCK}) as ok`;
  return r?.ok === true;
}

export async function destravarColeta() {
  await sql`select pg_advisory_unlock(${CHAVE_LOCK})`;
}

export async function ensurePartitions() {
  await sql`select ensure_partitions(3)`;
}
