/**
 * CLI do coletor.
 *
 * Instalação (uma vez só):
 *   npm run collect auth-url          # abre a URL, autoriza no navegador
 *   npm run collect auth-code TG-xxx  # troca o code por tokens
 *   npm run collect auth-status       # confere a credencial gravada
 *
 * Operação:
 *   npm run collect categories  # sincroniza a árvore de categorias
 *   npm run collect rank        # lê o top 20 de cada categoria  <- o diário
 *   npm run collect produtos    # concorrentes e preços de cada produto
 *   npm run collect itens       # nome/foto dos destaques tipo ITEM (não passam por produtos)
 *   npm run collect calibrar    # pares reais da própria conta
 *   npm run collect rodada      # tudo acima + métricas
 *   npm run collect fornecedor <csv>  # importa catálogo de fornecedor
 *   npm run collect pedidos     # atende os pedidos vindos da extensão
 *   npm run collect pedidos-status    # resumo da fila
 *   npm run collect digest            # conta produtos novos + e-mail + aviso no app
 *
 * Comandos do caminho antigo (seed/worker/daily) continuam no código mas
 * dependem de /sites/MLB/search, que devolve 403 desde 07/2026.
 */
import 'dotenv/config';
import { MlClient } from './ml-client.js';
import * as db from './db.js';
import { accessToken, authorizationUrl, exchangeCode, credentialStatus } from './auth.js';
import { syncCategories, discoverItems, refreshItems, syncSellers, seed } from './jobs.js';
import { coletarRanking, sincronizarProdutos, sincronizarItens, colherCalibracao, rodadaDiaria } from './jobs-rank.js';
import * as rank from './db-rank.js';
import { importarFornecedor, modeloCsv } from './fornecedores.js';
import { atenderPedidos, statusPedidos } from './pedidos.js';
import { fecharDigestDoDia } from './digest.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function client() {
  return new MlClient({
    getToken: accessToken,
    siteId: process.env.ML_SITE_ID ?? 'MLB',
    ratePerSec: Number(process.env.ML_RATE_PER_SEC ?? 8),
  });
}

/** Consome a fila até esvaziar. */
async function worker() {
  const ml = client();
  let idle = 0;

  for (;;) {
    const job = await db.claimJob();

    if (!job) {
      idle++;
      if (idle >= 3) {
        log('fila vazia, encerrando');
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    idle = 0;

    try {
      switch (job.job_type) {
        case 'sync_categories':
          await syncCategories(ml);
          break;
        case 'discover_items':
          await discoverItems(ml, job.target!, {
            maxItems: Number(job.payload.maxItems ?? 1000),
          });
          break;
        case 'refresh_items':
          await refreshItems(ml);
          break;
        case 'sync_sellers':
          await syncSellers(ml);
          break;
        default:
          throw new Error(`job desconhecido: ${job.job_type}`);
      }
      await db.finishJob(job.id, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`job ${job.id} (${job.job_type}) falhou: ${msg}`);
      await db.finishJob(job.id, false, msg);
    }
  }
}

/**
 * Rodada diária. É esta que precisa rodar TODO DIA, sem falha, para o
 * histórico não ficar furado.
 */
async function daily() {
  const ml = client();
  await db.ensurePartitions();
  await refreshItems(ml, { batch: Number(process.env.DAILY_BATCH ?? 20000) });

  log('recalculando métricas...');
  try {
    await db.refreshMetrics(true);
  } catch {
    // Na primeira vez as matviews ainda não têm índice populado.
    await db.refreshMetrics(false);
  }
  log('rodada diária concluída');
}

/** Comandos que consomem a API do ML e não podem rodar em paralelo. */
const PESADOS = new Set(['rank', 'produtos', 'itens', 'rodada', 'pedidos', 'seed',
                         'worker', 'daily', 'categories', 'sellers', 'discover']);

async function main() {
  const cmd = process.argv[2] ?? 'daily';
  const started = Date.now();
  let travado = false;

  if (PESADOS.has(cmd)) {
    travado = await db.travarColeta();
    if (!travado) {
      console.log('\n  Já existe uma coleta em andamento.');
      console.log('  Duas ao mesmo tempo competem pelo limite da API do Mercado');
      console.log('  Livre e as duas voltam com menos dados do que deveriam.');
      console.log('\n  Espere a atual terminar, ou feche a outra janela.\n');
      await db.sql.end();
      process.exit(1);
    }
  }

  try {
    switch (cmd) {
      case 'auth-url':
        console.log('\nAbra esta URL no navegador, autorize com a conta do ML,');
        console.log('e copie o valor do parâmetro "code" da URL de retorno:\n');
        console.log(authorizationUrl());
        console.log('\nDepois rode:  npm run collect auth-code TG-o-codigo-copiado\n');
        console.log('O code expira em poucos minutos — não deixe para depois.\n');
        break;

      case 'auth-code': {
        const code = process.argv[3];
        if (!code) throw new Error('uso: collect auth-code TG-xxxxx');
        const t = await exchangeCode(code);
        log(`credencial gravada. conta ${t.user_id}, escopos: ${t.scope}`);
        log(`access_token expira em ${Math.round(t.expires_in / 3600)}h — renovação automática daqui pra frente`);
        break;
      }

      case 'auth-status': {
        const s = await credentialStatus();
        if (!s) {
          log('nenhuma credencial gravada. rode: npm run collect auth-url');
          break;
        }
        const mins = s.expires_at
          ? Math.round((s.expires_at.getTime() - Date.now()) / 60000)
          : null;
        log(`conta ${s.ml_user_id} · escopos ${s.scope}`);
        log(`token ${mins === null ? 'sem validade registrada' : mins > 0 ? `válido por ${mins} min` : 'expirado (renova sozinho)'}`);
        log(`renovações até agora: ${s.refresh_count}`);
        break;
      }

      // ---- caminho de ranking (o vivo) ----
      case 'rank':
        // "rank 2000 forcar" ignora a checagem de já-lido-hoje.
        await coletarRanking(client(), {
          lote: Number(process.argv[3] ?? 2000),
          forcar: process.argv[4] === 'forcar',
        });
        break;

      case 'produtos':
        await sincronizarProdutos(client(), {
          lote: Number(process.argv[3] ?? 1000),
          concorrencia: Number(process.argv[4] ?? 8),
        });
        break;

      case 'itens':
        await sincronizarItens(client(), { lote: Number(process.argv[3] ?? 500) });
        break;

      case 'calibrar':
        await colherCalibracao(client());
        break;

      case 'rodada':
        await rodadaDiaria(client());
        break;

      case 'rank-metrics':
        await rank.refreshRankMetrics(process.argv[3] !== 'full');
        log('métricas de ranking recalculadas');
        break;

      case 'pedidos':
        await atenderPedidos(client(), Number(process.argv[3] ?? 200));
        break;

      case 'diag': {
        // Testa o endpoint de destaques em categorias que comprovadamente
        // funcionaram antes, e imprime o status HTTP cru de cada uma.
        const token = await accessToken();
        const API = 'https://api.mercadolibre.com';

        console.log('\n  Diagnóstico do endpoint de destaques');
        console.log('  ─────────────────────────────────────────────');

        const me = await fetch(`${API}/users/me`, {
          headers: { authorization: `Bearer ${token}` },
        });
        console.log(`  /users/me                 ${me.status} ${me.ok ? 'token válido' : 'PROBLEMA'}`);

        const alvos = await db.sql<{ category_id: string; n: number }[]>`
          select category_id, count(*)::int as n
            from product_rank_snapshots
           where captured_date < current_date
           group by category_id order by n desc limit 6
        `;

        if (!alvos.length) console.log('  (sem histórico anterior para comparar)');

        const status: Record<number, number> = {};
        for (const a of alvos) {
          const r = await fetch(`${API}/highlights/MLB/category/${a.category_id}`, {
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          });
          status[r.status] = (status[r.status] ?? 0) + 1;
          let nota = '';
          if (r.ok) {
            const j: any = await r.json();
            const n = (j?.content ?? []).length;
            nota = n ? `${n} destaque(s)` : 'lista VAZIA';
          } else {
            nota = (await r.text()).slice(0, 90).replace(/\s+/g, ' ');
          }
          console.log(`  ${a.category_id.padEnd(12)} antes ${String(a.n).padStart(3)}  ->  ${r.status}  ${nota}`);
          await new Promise((s) => setTimeout(s, 400));
        }

        // Endpoints vizinhos, para separar "só destaques" de "tudo"
        console.log('\n  Outros endpoints, para comparação');
        for (const [rot, url] of [
          ['categoria', '/categories/MLB1051'],
          ['tendências', '/trends/MLB'],
          ['catálogo', '/products/search?status=active&site_id=MLB&q=fone'],
        ] as [string, string][]) {
          const r = await fetch(API + url, {
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          });
          console.log(`  ${rot.padEnd(12)} ${r.status} ${r.ok ? 'ok' : (await r.text()).slice(0, 60)}`);
        }

        console.log('\n  ─────────────────────────────────────────────');
        console.log('  status dos destaques:', JSON.stringify(status));
        if (status[429]) console.log('  >> 429 é limite de uso. Baixe ML_RATE_PER_SEC e espere horas.');
        else if (status[403]) console.log('  >> 403 é bloqueio de acesso ao endpoint.');
        else if (status[404]) console.log('  >> 404 nessas categorias significa que o ML deixou de publicar destaques nelas.');
        else if (status[200]) console.log('  >> respondendo agora; a falha da rodada foi momentânea.');
        console.log();
        break;
      }

      case 'verificar': {
        // Sai com código de erro se a coleta do dia não aconteceu.
        //
        // Existe por causa de 24/07/2026: a rodada rodou, disse
        // "concluído" e gravou zero. Sem uma checagem que FALHA, um
        // problema desses passa dias despercebido — e cada dia perdido
        // é buraco permanente na série.
        const [v] = await db.sql<{
          hoje: number; ontem: number; dias: number; ultimo: string | null;
        }[]>`
          select
            (select count(*) from product_rank_snapshots
              where captured_date = current_date)::int          as hoje,
            (select count(*) from product_rank_snapshots
              where captured_date = current_date - 1)::int      as ontem,
            (select count(distinct captured_date)
               from product_rank_snapshots)::int                as dias,
            (select max(captured_date)::text
               from product_rank_snapshots)                     as ultimo
        `;

        console.log(`\n  posições hoje: ${v.hoje.toLocaleString('pt-BR')}`);
        console.log(`  posições ontem: ${v.ontem.toLocaleString('pt-BR')}`);
        console.log(`  dias de histórico: ${v.dias}`);
        console.log(`  última leitura: ${v.ultimo ?? 'nunca'}\n`);

        const minimo = Number(process.env.MINIMO_POSICOES ?? 1000);
        if (v.hoje < minimo) {
          console.error(`  FALHOU: esperava ao menos ${minimo} posições hoje, gravou ${v.hoje}.`);
          console.error('  A coleta rodou mas não trouxe dado. Rode "npm run collect diag".\n');
          process.exitCode = 1;
          break;
        }
        // Queda brusca também é sinal de problema, não de mercado parado.
        if (v.ontem > 0 && v.hoje < v.ontem * 0.5) {
          console.error(`  FALHOU: hoje veio ${Math.round((1 - v.hoje / v.ontem) * 100)}% abaixo de ontem.`);
          console.error('  Provável mudança de formato ou limite de API.\n');
          process.exitCode = 1;
          break;
        }
        console.log('  Coleta saudável.\n');
        break;
      }

      case 'digest': {
        // Conta produtos novos do dia, grava aviso no app e manda e-mail
        // (se RESEND_API_KEY estiver no ambiente do Actions/local).
        const d = await fecharDigestDoDia();
        console.log('\n  Digest da coleta');
        console.log('  ─────────────────────────────────────');
        console.log(`  ${d.titulo}`);
        console.log(`  ${d.detalhe}`);
        console.log(`  novos no ranking     ${d.novos_ranking}`);
        console.log(`  novos no catálogo    ${d.novos_catalogo}`);
        console.log(`  posições hoje        ${Number(d.posicoes).toLocaleString('pt-BR')}`);
        console.log(`  e-mail               ${d.email_enviado ? 'enviado' : `não (${d.email_erro ?? 'ok'})`}`);
        console.log();
        break;
      }

      case 'resumo': {
        // Sai no fim de cada rodada automática. É o que você olha para
        // saber se a coleta está saudável sem abrir o banco.
        const [r] = await db.sql<{
          dias: number; ultimo: string; posicoes: number;
          produtos: number; anuncios: number; alertas: number;
        }[]>`
          select
            (select count(distinct captured_date) from product_rank_snapshots)::int as dias,
            (select max(captured_date)::text from product_rank_snapshots)           as ultimo,
            (select count(*) from product_rank_snapshots
              where captured_date = current_date)::int                              as posicoes,
            (select count(*) from catalog_products)::int                            as produtos,
            (select count(*) from items where catalog_product_id is not null)::int  as anuncios,
            (select count(*) from product_alerts
              where dia = current_date)::int                                        as alertas
        `;
        console.log('\n  Estado da coleta');
        console.log('  ─────────────────────────────────────');
        console.log(`  dias de histórico     ${r.dias}`);
        console.log(`  última leitura        ${r.ultimo ?? '—'}`);
        console.log(`  posições hoje         ${r.posicoes.toLocaleString('pt-BR')}`);
        console.log(`  produtos no catálogo  ${r.produtos.toLocaleString('pt-BR')}`);
        console.log(`  anúncios vinculados   ${r.anuncios.toLocaleString('pt-BR')}`);
        console.log(`  alertas gerados hoje  ${r.alertas}`);
        if (r.dias < 2) {
          console.log('\n  Com menos de 2 dias não há movimento para calcular.');
        }
        console.log();
        break;
      }

      case 'pedidos-status':
        await statusPedidos();
        break;

      case 'fornecedor': {
        const arq = process.argv[3];
        if (!arq) {
          console.log('\n  uso: npm run collect fornecedor ./catalogo.csv');
          console.log('\n  modelo de planilha:\n');
          console.log(modeloCsv());
          console.log();
          break;
        }
        await importarFornecedor(arq);
        break;
      }

      // ---- caminho antigo, morto desde o 403 em /sites/MLB/search ----
      case 'seed': {
        const n = await seed(client(), Number(process.argv[3] ?? 200));
        log(`seed pronto: ${n} categorias na fila. Agora rode: npm run collect worker`);
        break;
      }
      case 'worker':
        await worker();
        break;
      case 'daily':
        await daily();
        break;
      case 'sellers':
        await syncSellers(client(), {
          limit: Number(process.argv[3] ?? 1000),
          concorrencia: Number(process.argv[4] ?? 8),
        });
        break;
      case 'categories':
        await syncCategories(client());
        break;
      case 'discover':
        if (!process.argv[3]) throw new Error('uso: collect discover MLB1234');
        await discoverItems(client(), process.argv[3]);
        break;
      case 'metrics':
        await db.refreshMetrics(process.argv[3] !== 'full');
        log('métricas recalculadas');
        break;
      default:
        console.error(`comando desconhecido: ${cmd}`);
        process.exitCode = 1;
    }
    log(`concluído em ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    if (travado) await db.destravarColeta().catch(() => {});
    await db.sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
