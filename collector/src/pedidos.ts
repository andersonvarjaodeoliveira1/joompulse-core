/**
 * Atende os pedidos de coleta vindos da extensão.
 *
 * Quando alguém abre no Mercado Livre um produto que está fora da nossa
 * cobertura, a extensão registra o pedido em collect_requests junto com
 * a categoria que leu do rastro de navegação da página.
 *
 * Este job fecha o ciclo: lê a fila, coleta o ranking daquelas
 * categorias e marca o resultado.
 *
 * A ordem da fila é por número de pedidos — o produto que mais gente
 * procurou entra primeiro. É a lacuna de cobertura sendo priorizada
 * por demanda real em vez de palpite.
 */
import { MlClient, NotFoundError } from './ml-client.js';
import { sql } from './db.js';
import * as db from './db.js';
import * as rank from './db-rank.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

interface Pedido {
  id: number;
  mlb: string;
  category_id: string | null;
  pedidos: number;
}

export async function atenderPedidos(ml: MlClient, limite = 200) {
  const inicio = Date.now();

  const fila = await sql<Pedido[]>`
    select id, mlb, category_id, pedidos
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

  // Vários pedidos podem apontar para a mesma categoria. Coletar uma vez
  // e resolver todos de uma vez economiza chamadas à API.
  const porCategoria = new Map<string, Pedido[]>();
  const semCategoria: Pedido[] = [];

  for (const p of fila) {
    if (!p.category_id) { semCategoria.push(p); continue; }
    const lista = porCategoria.get(p.category_id) ?? [];
    lista.push(p);
    porCategoria.set(p.category_id, lista);
  }

  log(`  ${porCategoria.size} categoria(s) distintas, ${semCategoria.length} pedido(s) sem categoria`);

  let atendidos = 0;
  let semDestaque = 0;
  let produtosNovos = 0;

  for (const [cat, pedidos] of porCategoria) {
    try {
      const d = await ml.highlights(cat);
      const conteudo = d?.content ?? [];

      if (!conteudo.length) {
        // A categoria existe mas não tem ranking público. Marcar assim
        // evita tentar de novo toda rodada — e é informação útil: diz
        // que aquele nicho é invisível para todo mundo, não só para nós.
        await sql`
          update collect_requests set status = 'sem_destaque', atendido_em = now()
           where id = any(${pedidos.map((p) => p.id)}::bigint[])
        `;
        semDestaque += pedidos.length;
        continue;
      }

      const produtos = conteudo.filter((x) => x.type === 'PRODUCT' && x.id);
      if (produtos.length) {
        produtosNovos += await rank.upsertCatalogProducts(
          produtos.map((x) => ({ id: x.id, categoryId: cat })),
        );
      }
      await rank.insertRankSnapshots(cat, conteudo);

      // Os produtos entram com prioridade alta: alguém pediu, então
      // vale sincronizar os concorrentes deles na próxima rodada.
      await sql`
        update catalog_products set last_synced_at = null
         where category_id = ${cat} and last_synced_at is not null
      `;

      await sql`
        update collect_requests set status = 'atendido', atendido_em = now()
         where id = any(${pedidos.map((p) => p.id)}::bigint[])
      `;
      atendidos += pedidos.length;
    } catch (e) {
      if (e instanceof NotFoundError) {
        await sql`
          update collect_requests set status = 'sem_destaque', atendido_em = now()
           where id = any(${pedidos.map((p) => p.id)}::bigint[])
        `;
        semDestaque += pedidos.length;
      } else {
        log(`  categoria ${cat}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (semCategoria.length) {
    log(`  ${semCategoria.length} pedido(s) sem categoria ficam na fila —`);
    log('  a extensão não conseguiu ler o rastro de navegação da página');
  }

  await db.logRun({
    jobType: 'atender_pedidos',
    ok: true,
    itemsSeen: produtosNovos,
    apiCalls: ml.callCount,
    durationMs: Date.now() - inicio,
  });

  log(`pedidos: ${atendidos} atendido(s), ${semDestaque} sem ranking público, ${produtosNovos} produto(s) novos`);
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
