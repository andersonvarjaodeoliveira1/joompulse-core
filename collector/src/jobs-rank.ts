/**
 * Rotinas de coleta do caminho de ranking.
 *
 *   coletarRanking   — lê o top 20 de cada categoria. É o job diário que
 *                      constrói a série histórica de posições. Não pode
 *                      falhar dia nenhum: buraco na série vira buraco no
 *                      gráfico de movimento.
 *
 *   sincronizarProdutos — para cada produto rankeado, busca todos os
 *                      anúncios que o disputam. Alimenta a análise de
 *                      concorrência e o histórico de preço.
 *
 *   colherCalibracao — lê os anúncios da PRÓPRIA conta, onde o
 *                      sold_quantity é acessível, e grava pares reais
 *                      (posição, unidades) que ancoram a estimativa.
 */
import { MlClient, NotFoundError } from './ml-client.js';
import * as db from './db.js';
import * as rank from './db-rank.js';
import { atenderPedidos } from './pedidos.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------
export async function coletarRanking(
  ml: MlClient,
  opts: { lote?: number; forcar?: boolean } = {},
) {
  const inicio = Date.now();
  const cats = await rank.categoriasParaRanquear(opts.lote ?? 500, opts.forcar ?? false);

  if (!cats.length) {
    log('nenhuma categoria pendente de ranking');
    return 0;
  }
  log(`lendo ranking de ${cats.length} categorias`);

  const pausa = Number(process.env.ML_PAUSA_MS ?? 0);
  if (pausa > 0) log(`  pausa de ${pausa}ms entre categorias`);

  let produtos = 0;
  let posicoes = 0;
  let vazias = 0;
  let naoAchadas = 0;
  let erros = 0;
  const porErro = new Map<string, number>();
  const porTipo = new Map<string, number>();

  for (const [i, c] of cats.entries()) {
    try {
      const d = await ml.highlights(c.id);
      const conteudo = d?.content ?? [];

      if (!conteudo.length) {
        vazias++;
        if (vazias <= 3) {
          log(`  ${c.id} veio vazia. Resposta: ${JSON.stringify(d).slice(0, 200)}`);
        }
        await rank.registrarRanking(c.id, false);
        continue;
      }

      // Guarda TODOS os tipos. Desde 24/07/2026 o ML devolve ITEM e
      // USER_PRODUCT além de PRODUCT — e descartar o desconhecido custou
      // uma varredura inteira.
      const comId = conteudo.filter((x) => x.id);
      if (comId.length) {
        produtos += await rank.upsertCatalogProducts(
          comId.map((x) => ({ id: x.id, categoryId: c.id, tipo: x.type ?? 'DESCONHECIDO' })),
        );
        for (const t of new Set(comId.map((x) => x.type ?? 'DESCONHECIDO'))) {
          porTipo.set(t, (porTipo.get(t) ?? 0) + comId.filter((x) => (x.type ?? 'DESCONHECIDO') === t).length);
        }
      }
      posicoes += await rank.insertRankSnapshots(c.id, conteudo);
      await rank.registrarRanking(c.id, true);

      if (i > 0 && i % 250 === 0) log(`  ${i}/${cats.length}`);

      // Pausa explícita entre categorias. O limitador por segundo do
      // cliente não impede rajadas curtas, e o endpoint de destaques
      // parece sensível a isso.
      if (pausa > 0) await new Promise((s) => setTimeout(s, pausa));
      // Se as primeiras 50 vierem quase todas vazias, é degradação por
      // carga, não catálogo vazio. Melhor parar cedo que varrer 6.700
      // categorias colhendo nada por meia hora.
      if (i === 49) {
        const cheias = 50 - vazias - naoAchadas - erros;
        if (cheias <= 2) {
          log('');
          log('  PARANDO: das 50 primeiras categorias, só ' + cheias + ' devolveram destaque.');
          log('  Isso é degradação por ritmo, não catálogo vazio — o diagnóstico');
          log('  (npm run collect diag) mostra o mesmo endpoint respondendo.');
          log('');
          log('  Reduza ML_RATE_PER_SEC no .env para 2 e rode em lotes menores:');
          log('      npm run collect rank 500');
          log('');
          break;
        }
      }
    } catch (e) {
      if (e instanceof NotFoundError) {
        naoAchadas++;
        await rank.registrarRanking(c.id, false);
      } else {
        // Antes isso era silencioso e o relatório dizia "0 sem destaque"
        // mesmo com milhares de falhas. Coleta que falha inteira e
        // reporta sucesso é pior que coleta que quebra.
        erros++;
        const msg = e instanceof Error ? e.message.slice(0, 60) : String(e);
        porErro.set(msg, (porErro.get(msg) ?? 0) + 1);
        if (erros <= 3) log(`  categoria ${c.id}: ${msg}`);
      }
    }
  }

  const saude = await rank.saudeCobertura();
  log(`cobertura: ${saude.com_ranking} com ranking, ${saude.adormecidas} adormecidas ` +
      `(releitura semanal), ${saude.nunca_tentadas} nunca tentadas`);

  await db.logRun({
    jobType: 'coletar_ranking',
    ok: true,
    itemsSeen: produtos,
    snapshots: posicoes,
    apiCalls: ml.callCount,
    durationMs: Date.now() - inicio,
  });

  log(`ranking: ${produtos} entidades, ${posicoes} posições`);
  if (porTipo.size) {
    log('  por tipo: ' + [...porTipo.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ${n}`).join(' · '));
  }
  log(`  ${cats.length - vazias - naoAchadas - erros} com destaque · ${vazias} vazias · ` +
      `${naoAchadas} inexistentes · ${erros} com erro`);

  if (erros > 0) {
    log('  erros mais comuns:');
    [...porErro.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .forEach(([m, n]) => log(`    ${n}x  ${m}`));
  }
  // Se quase tudo falhou, a rodada não vale nada — melhor gritar.
  if (cats.length > 100 && produtos < cats.length * 0.02) {
    log('  ATENÇÃO: quase nenhuma categoria devolveu produto.');
    log('  Verifique se há outra coleta rodando ou se o limite da API foi atingido.');
  }
  return posicoes;
}

// ---------------------------------------------------------------------
export async function sincronizarProdutos(
  ml: MlClient,
  opts: { lote?: number; dias?: number; comFicha?: boolean; concorrencia?: number } = {},
) {
  const inicio = Date.now();
  const prods = await rank.produtosParaSincronizar(opts.lote ?? 300, opts.dias ?? 2);

  if (!prods.length) {
    log('nenhum produto pendente de sincronização');
    return 0;
  }
  log(`sincronizando ${prods.length} produtos`);

  let anuncios = 0;
  let snapshots = 0;
  let feitos = 0;

  async function processar(p: { id: string; category_id: string | null }) {
    try {
      // Ficha do produto: nome, imagem, marca. Vale só na primeira vez.
      if (opts.comFicha !== false) {
        try {
          const ficha = await ml.product(p.id);
          if (ficha) await rank.enrichProduct(ficha);
        } catch { /* ficha é opcional, os anúncios importam mais */ }
      }

      const r = await ml.productItems(p.id);
      const itens = r?.results ?? [];
      if (itens.length) {
        const res = await rank.upsertProductItems(p.id, p.category_id, itens);
        anuncios += res.anuncios;
        snapshots += res.snapshots;
      }
    } catch (e) {
      if (!(e instanceof NotFoundError)) {
        log(`  produto ${p.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    feitos++;
    if (feitos % 100 === 0) log(`  ${feitos}/${prods.length}`);
  }

  // Um produto = até 2 chamadas sequenciais (ficha + concorrentes). Um
  // `for` simples fica ocioso esperando o round-trip de rede entre uma
  // chamada e outra em vez de saturar os 8 req/s do rate limiter — é
  // por isso que 25 mil produtos levavam ~17h em vez de ~2h. O
  // TokenBucket de MlClient é compartilhado entre as lanes e continua
  // sendo o único limitador real de requisições/segundo; mais lanes só
  // evita ficar parado esperando, não estoura o limite.
  const lanes = Math.max(1, opts.concorrencia ?? 8);
  let cursor = 0;
  async function lane() {
    while (cursor < prods.length) {
      const p = prods[cursor++];
      await processar(p);
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane));

  await db.logRun({
    jobType: 'sincronizar_produtos',
    ok: true,
    itemsSeen: anuncios,
    snapshots,
    apiCalls: ml.callCount,
    durationMs: Date.now() - inicio,
  });

  log(`produtos: ${anuncios} anúncios concorrentes, ${snapshots} preços`);
  return anuncios;
}

// ---------------------------------------------------------------------
/**
 * Sincroniza produtos de catálogo tipo ITEM — destaque cujo id É o
 * anúncio (não um /products/{id}). sincronizarProdutos pula esse tipo
 * de propósito (ficha e productItems dão 404 nele).
 *
 * TESTADO AO VIVO em 25/07/2026: /items?ids= (multiget) dá 403
 * access_denied pra anúncio de terceiro, igual /items/{id} sozinho —
 * não é o desvio que parecia ser. Na prática, hoje, este job roda,
 * tenta, não acha nada e marca como tentado (pra não bater na API todo
 * dia à toa). Fica registrado porque é barato e esse endpoint já mudou
 * de comportamento sem aviso antes — se abrir de novo, começa a
 * preencher nome/foto sozinho, sem precisar de outro deploy.
 */
export async function sincronizarItens(ml: MlClient, opts: { lote?: number } = {}) {
  const inicio = Date.now();
  const alvo = await rank.itensParaSincronizar(opts.lote ?? 300);

  if (!alvo.length) {
    log('nenhum item tipo ITEM pendente de sincronização');
    return 0;
  }
  log(`sincronizando ${alvo.length} itens tipo ITEM`);

  let sincronizados = 0;
  try {
    const encontrados = await ml.itemsMulti(alvo.map((p) => p.id));
    if (encontrados.length) {
      await rank.enrichCatalogProductsFromItems(encontrados);
      // O anúncio É o produto rankeado aqui: catalog_product_id aponta
      // pra si mesmo, então "concorrentes" mostra 1 (ele) em vez de
      // ficar em branco pra sempre.
      await rank.upsertItensDiretos(
        encontrados.map((it) => ({ ...it, catalog_product_id: it.id })),
      );
      sincronizados = encontrados.length;
    }

    const idsEncontrados = new Set(encontrados.map((i) => i.id));
    const idsFaltando = alvo.filter((p) => !idsEncontrados.has(p.id)).map((p) => p.id);
    if (idsFaltando.length) await rank.marcarCatalogProductsSincronizados(idsFaltando);
  } catch (e) {
    log(`  sincronizar itens: ${e instanceof Error ? e.message : e}`);
  }

  await db.logRun({
    jobType: 'sincronizar_itens',
    ok: true,
    itemsSeen: sincronizados,
    apiCalls: ml.callCount,
    durationMs: Date.now() - inicio,
  });

  log(`itens: ${sincronizados}/${alvo.length} sincronizados`);
  return sincronizados;
}

// ---------------------------------------------------------------------
/**
 * Colhe pares reais de calibração da conta conectada.
 *
 * Este é o único lugar do sistema onde existe sold_quantity verdadeiro.
 * A API entrega para o dono do token e para mais ninguém — por isso
 * cada vendedor que conecta a conta melhora a estimativa de todos.
 *
 * Guarda o valor ABSOLUTO com a data. A diferença entre duas colheitas
 * vira "vendeu X unidades em Y dias", que é o par que ancora a curva.
 */
export async function colherCalibracao(ml: MlClient) {
  const inicio = Date.now();

  const eu = await ml.get<{ id: number }>('/users/me');
  if (!eu?.id) { log('não consegui identificar a conta'); return 0; }

  const ids: string[] = [];
  let offset = 0;
  for (;;) {
    const r = await ml.myItems(eu.id, offset, 50);
    const lote = r?.results ?? [];
    ids.push(...lote);
    offset += lote.length;
    if (!lote.length || offset >= (r?.paging?.total ?? 0) || offset >= 1000) break;
  }

  if (!ids.length) {
    log('a conta conectada não tem anúncios — sem calibração por aqui');
    log('para calibrar, conecte a conta de um vendedor com anúncios ativos');
    return 0;
  }
  log(`${ids.length} anúncios próprios encontrados`);

  const detalhes = await ml.itemsMulti(ids);
  let gravados = 0;

  for (const it of detalhes) {
    if (it.sold_quantity == null) continue;

    const posicao = it.catalog_product_id
      ? await rank.posicaoAtual(it.catalog_product_id)
      : null;

    await rank.gravarCalibracao({
      itemId: it.id,
      productId: it.catalog_product_id ?? null,
      categoryId: it.category_id ?? null,
      sellerId: it.seller_id ?? null,
      position: posicao,
      unitsSold: it.sold_quantity,
      periodDays: 0,   // acumulado; a diferença entre colheitas dá o giro
      price: it.price ?? null,
      source: 'own_account',
    });
    gravados++;
  }

  await db.logRun({
    jobType: 'colher_calibracao',
    ok: true,
    itemsSeen: gravados,
    apiCalls: ml.callCount,
    durationMs: Date.now() - inicio,
  });

  log(`calibração: ${gravados} pares gravados`);
  if (gravados > 0) {
    log('rode de novo daqui a alguns dias — a diferença entre as leituras');
    log('é o que transforma contador acumulado em unidades por período');
  }
  return gravados;
}

// ---------------------------------------------------------------------
/** Rodada diária completa do caminho de ranking. */
export async function rodadaDiaria(ml: MlClient) {
  await db.ensurePartitions();
  await coletarRanking(ml, { lote: Number(process.env.RANK_BATCH ?? 2000) });
  await sincronizarProdutos(ml, {
    lote: Number(process.env.PRODUCT_BATCH ?? 1000),
    concorrencia: Number(process.env.PRODUCT_CONCURRENCY ?? 8),
  });
  await sincronizarItens(ml, { lote: Number(process.env.ITEM_BATCH ?? 500) });

  log('recalculando métricas...');
  try {
    await rank.refreshRankMetrics(true);
  } catch {
    await rank.refreshRankMetrics(false);
  }

  // Pedidos da extensão entram antes das métricas: assim o que o
  // usuário pediu hoje já aparece calculado no fim desta rodada.
  await atenderPedidos(ml, 300);

  const alertas = await rank.gerarAlertas();
  log(`alertas gerados: ${alertas}`);
  log('rodada concluída');
}
