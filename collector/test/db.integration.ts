/**
 * Teste de integração do coletor contra um Postgres de verdade.
 *
 * Exercita todas as funções de db.ts com objetos no formato que a API
 * do Mercado Livre devolve. Não chama a rede — o objetivo é provar que
 * as queries executam e escrevem o que deveriam.
 */
import * as db from '../src/db.js';
import type { MlItem, MlUser, MlCategory } from '../src/ml-client.js';

let falhas = 0;
function ok(cond: boolean, msg: string) {
  console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}`);
  if (!cond) falhas++;
}

const itemFake = (id: string, over: Partial<MlItem> = {}): MlItem => ({
  id,
  title: `Anúncio ${id}`,
  category_id: 'MLB_SUP',
  seller_id: 1,
  price: 99.9,
  sold_quantity: 500,
  available_quantity: 42,
  condition: 'new',
  listing_type_id: 'gold_special',
  permalink: `https://x/${id}`,
  secure_thumbnail: 'https://x/t.jpg',
  status: 'active',
  date_created: '2025-01-15T10:00:00.000Z',
  shipping: { free_shipping: true, logistic_type: 'fulfillment' },
  attributes: [{ id: 'BRAND', value_name: 'MarcaTeste' }],
  ...over,
});

async function main() {
  console.log('\n  Integração db.ts <-> Postgres\n  ─────────────────────────────');

  // --- captureDate deve devolver a data no fuso de São Paulo ---
  const d = db.captureDate(new Date('2026-07-23T02:30:00Z')); // 23:30 do dia 22 em BRT
  ok(d === '2026-07-22', `captureDate converte UTC->BRT (veio ${d})`);

  // --- upsertCategory ---
  const cat: MlCategory = {
    id: 'MLB_TESTE',
    name: 'Categoria de teste',
    total_items_in_this_category: 1234,
    path_from_root: [
      { id: 'MLB_ROOT', name: 'Saúde' },
      { id: 'MLB_TESTE', name: 'Categoria de teste' },
    ],
  };
  await db.upsertCategory(cat, { parentId: 'MLB_ROOT', rootId: 'MLB_ROOT', level: 1, isLeaf: true });
  const [c] = await db.sql`select name, level, is_leaf, total_items_ml, path_names
                             from categories where id = 'MLB_TESTE'`;
  ok(!!c && c.level === 1 && c.is_leaf === true && Number(c.total_items_ml) === 1234,
     'upsertCategory grava nível, folha e contagem');
  ok(Array.isArray(c?.path_names) && c.path_names.length === 2,
     'upsertCategory grava o caminho da árvore');

  // --- upsertItems com categoria e vendedor ainda desconhecidos ---
  // Esse é o caso que quebraria por violação de chave estrangeira se o
  // código não inserisse o esqueleto antes.
  const novos = [
    itemFake('TEST_A', { category_id: 'MLB_INEXISTENTE', seller_id: 99999 }),
    itemFake('TEST_B'),
  ];
  const n = await db.upsertItems(novos, 1);
  ok(n === 2, `upsertItems grava 2 anúncios (veio ${n})`);
  const [novaCat] = await db.sql`select id from categories where id = 'MLB_INEXISTENTE'`;
  ok(!!novaCat, 'upsertItems cria esqueleto de categoria desconhecida (sem violar FK)');
  const [novoVend] = await db.sql`select id from sellers where id = 99999`;
  ok(!!novoVend, 'upsertItems cria esqueleto de vendedor desconhecido');

  const [a] = await db.sql`select brand, shipping_logistic_type, collect_priority
                             from items where id = 'TEST_A'`;
  ok(a?.brand === 'MarcaTeste', 'upsertItems extrai a marca do array de atributos');
  ok(a?.shipping_logistic_type === 'fulfillment', 'upsertItems grava o tipo de logística (Full)');

  // --- prioridade nunca deve regredir ---
  await db.sql`update items set collect_priority = 2 where id = 'TEST_B'`;
  await db.upsertItems([itemFake('TEST_B')], 0);
  const [b] = await db.sql`select collect_priority from items where id = 'TEST_B'`;
  ok(b?.collect_priority === 2, 'upsertItems não rebaixa a prioridade de um item monitorado');

  // --- insertItemSnapshots ---
  const posicoes = new Map<string, number>([['TEST_A', 7]]);
  const s = await db.insertItemSnapshots([itemFake('TEST_A')], { positions: posicoes });
  ok(s === 1, `insertItemSnapshots grava 1 snapshot (veio ${s})`);
  const [snap] = await db.sql`select search_position, price, sold_quantity
                                from item_snapshots where item_id = 'TEST_A'`;
  ok(snap?.search_position === 7, 'insertItemSnapshots grava a posição na busca');
  ok(Number(snap?.price) === 99.9, 'insertItemSnapshots grava o preço');

  // --- upsertSeller com reputação ---
  const user: MlUser = {
    id: 12345,
    nickname: 'VENDEDOR_TESTE',
    registration_date: '2019-03-01T00:00:00.000Z',
    address: { state: 'SP', city: 'Santo André' },
    permalink: 'https://x/v',
    seller_reputation: {
      level_id: '5_green',
      power_seller_status: 'platinum',
      transactions: { total: 8400, canceled: 12 },
      metrics: { claims: { rate: 0.008 }, delayed_handling_time: { rate: 0.02 } },
    },
  };
  await db.upsertSeller(user);
  const [v] = await db.sql`select nickname, state from sellers where id = 12345`;
  ok(v?.nickname === 'VENDEDOR_TESTE' && v?.state === 'SP', 'upsertSeller grava o vendedor');
  const [rep] = await db.sql`select reputation_level, power_seller_status, transactions_total
                               from seller_snapshots where seller_id = 12345`;
  ok(rep?.reputation_level === '5_green' && Number(rep?.transactions_total) === 8400,
     'upsertSeller grava o snapshot de reputação');

  // --- fila de jobs ---
  await db.enqueue('discover_items', 'MLB_SUP', { maxItems: 500 }, 2);
  const job = await db.claimJob();
  ok(job?.job_type === 'discover_items' && job?.target === 'MLB_SUP', 'claimJob pega o job da fila');
  ok(Number(job?.payload?.maxItems) === 500, 'claimJob devolve o payload em jsonb');

  // Job que falha e ainda tem tentativa deve voltar para a fila.
  await db.finishJob(job!.id, false, 'erro simulado');
  const [voltou] = await db.sql`select status, attempts, last_error from collect_jobs where id = ${job!.id}`;
  ok(voltou?.status === 'pending', `job com falha volta para pending (veio ${voltou?.status})`);
  ok(voltou?.last_error === 'erro simulado', 'job registra a mensagem de erro');

  await db.finishJob(job!.id, true);
  const [concluido] = await db.sql`select status, finished_at from collect_jobs where id = ${job!.id}`;
  ok(concluido?.status === 'done' && concluido?.finished_at !== null, 'job concluído marca done e data');

  // --- fila vazia não pode estourar ---
  await db.sql`update collect_jobs set status = 'done'`;
  const vazio = await db.claimJob();
  ok(vazio === null, 'claimJob devolve null com a fila vazia (não lança exceção)');

  // --- itemsDueForRefresh respeita a prioridade ---
  await db.sql`update items set collect_priority = 2 where id = 'TEST_B'`;
  await db.sql`update items set collect_priority = 0 where id = 'TEST_A'`;
  const due = await db.itemsDueForRefresh(50);
  ok(due.length > 0, `itemsDueForRefresh encontra ${due.length} anúncios pendentes`);
  ok(due[0].id === 'TEST_B', `prioridade 2 vem primeiro na fila (veio ${due[0]?.id})`);

  // --- log ---
  await db.logRun({ jobType: 'teste', ok: true, itemsSeen: 10, snapshots: 10, apiCalls: 3, durationMs: 120 });
  const [log] = await db.sql`select api_calls from collect_log where job_type = 'teste'`;
  ok(log?.api_calls === 3, 'logRun grava a contagem de chamadas à API');

  // --- refreshMetrics e partições ---
  await db.ensurePartitions();
  const parts = await db.sql`select count(*)::int as n from pg_class
                              where relname like 'item_snapshots_%' and relkind = 'r'`;
  ok(parts[0].n >= 4, `ensurePartitions criou ${parts[0].n} partições mensais`);

  await db.refreshMetrics(false);
  ok(true, 'refreshMetrics executa sem erro');

  console.log('\n  ─────────────────────────────');
  console.log(falhas === 0 ? `  Tudo passou.\n` : `  ${falhas} falha(s).\n`);
  await db.sql.end();
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n  EXCEÇÃO:', e.message);
  await db.sql.end();
  process.exit(1);
});
