/**
 * Diagnóstico da API do Mercado Livre.
 *
 * Testa cada endpoint um por um e imprime o que responde o quê.
 * Objetivo: descobrir com precisão qual superfície a sua aplicação
 * alcança, agora que /sites/MLB/search voltou 403.
 *
 * Rode com:  npx tsx test/diagnostico.ts
 */
import 'dotenv/config';
import { accessToken } from '../src/auth.js';
import { sql } from '../src/db.js';

const API = 'https://api.mercadolibre.com';

let token = '';
const achados: { rota: string; ok: boolean; nota: string }[] = [];

async function tenta(rotulo: string, path: string, opts: { silencioso?: boolean } = {}) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const texto = await res.text();

    if (res.ok) {
      let corpo: unknown;
      try { corpo = JSON.parse(texto); } catch { corpo = texto; }
      console.log(`  OK    ${rotulo}`);
      achados.push({ rota: rotulo, ok: true, nota: 'responde' });
      return corpo as any;
    }

    let motivo = `${res.status}`;
    try {
      const j = JSON.parse(texto);
      motivo += ` ${j.message ?? j.error ?? ''}`.trim();
    } catch { /* corpo não-JSON */ }

    console.log(`  ✗     ${rotulo}  ->  ${motivo}`);
    achados.push({ rota: rotulo, ok: false, nota: motivo });
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗     ${rotulo}  ->  ${msg}`);
    achados.push({ rota: rotulo, ok: false, nota: msg });
    return null;
  }
}

async function main() {
  token = await accessToken();

  // -------------------------------------------------------------------
  console.log('\n  1. A credencial está viva?');
  console.log('  ─────────────────────────────────────────');
  const eu = await tenta('/users/me', '/users/me');
  if (eu) console.log(`        conta ${eu.id} · ${eu.nickname} · ${eu.site_id}`);

  // -------------------------------------------------------------------
  console.log('\n  2. Catálogo e categorias (leitura estrutural)');
  console.log('  ─────────────────────────────────────────');
  await tenta('/sites/MLB', '/sites/MLB');
  const cat = await tenta('/categories/MLB1051', '/categories/MLB1051');
  if (cat) console.log(`        "${cat.name}" · ${cat.total_items_in_this_category ?? '?'} anúncios`);

  // -------------------------------------------------------------------
  // Aqui está o problema. Testamos todas as variações para saber se o
  // bloqueio é do endpoint inteiro ou só de alguma forma de uso.
  console.log('\n  3. Descoberta de anúncios — o gargalo');
  console.log('  ─────────────────────────────────────────');
  await tenta('busca por texto',        '/sites/MLB/search?q=creatina&limit=5');
  await tenta('busca por categoria',    '/sites/MLB/search?category=MLB1051&limit=5');
  await tenta('busca por vendedor',     '/sites/MLB/search?seller_id=' + (eu?.id ?? 0) + '&limit=5');
  await tenta('busca sem autenticação', 'https://api.mercadolibre.com/sites/MLB/search?q=creatina&limit=5');

  // Caminhos alternativos que talvez não estejam bloqueados.
  console.log('\n  4. Rotas alternativas de descoberta');
  console.log('  ─────────────────────────────────────────');
  const dest = await tenta('mais vendidos da categoria', '/highlights/MLB/category/MLB1051');
  await tenta('tendências de busca',                     '/trends/MLB');
  await tenta('tendências por categoria',                '/trends/MLB/MLB1051');
  const prods = await tenta('busca no catálogo',         '/products/search?status=active&site_id=MLB&q=creatina');
  await tenta('meus próprios anúncios',                  `/users/${eu?.id}/items/search?limit=5`);

  // -------------------------------------------------------------------
  // Se alguma rota acima devolveu IDs, dá para testar o enriquecimento.
  console.log('\n  5. Enriquecimento (precisa de IDs conhecidos)');
  console.log('  ─────────────────────────────────────────');

  let idTeste: string | null = process.argv[2] ?? null;

  if (!idTeste && dest?.content?.length) {
    idTeste = dest.content[0].id ?? null;
    if (idTeste) console.log(`        peguei um ID dos mais vendidos: ${idTeste}`);
  }
  if (!idTeste && prods?.results?.length) {
    const prodId = prods.results[0].id;
    const itens = await tenta('anúncios de um produto do catálogo', `/products/${prodId}/items`);
    if (itens?.results?.length) {
      idTeste = itens.results[0].item_id ?? itens.results[0].id ?? null;
      if (idTeste) console.log(`        peguei um ID do catálogo: ${idTeste}`);
    }
  }

  if (!idTeste) {
    console.log('  --    nenhum ID disponível para testar.');
    console.log('        Pegue um MLB do seu navegador (está na URL de qualquer');
    console.log('        anúncio) e rode:  npx tsx test/diagnostico.ts MLB1234567890');
  } else {
    const item = await tenta(`/items/${idTeste}`, `/items/${idTeste}`);
    const multi = await tenta('/items?ids= (multiget)', `/items?ids=${idTeste}`);

    // ESTA É A PERGUNTA QUE DECIDE O PRODUTO.
    const corpo = item ?? (Array.isArray(multi) ? multi[0]?.body : null);
    console.log('\n  6. O campo que sustenta todas as métricas');
    console.log('  ─────────────────────────────────────────');
    if (corpo) {
      const sq = corpo.sold_quantity;
      console.log(`        título          ${String(corpo.title).slice(0, 50)}`);
      console.log(`        price           ${corpo.price}`);
      console.log(`        sold_quantity   ${sq === undefined ? '(campo ausente)' : sq}`);
      console.log(`        available_qty   ${corpo.available_quantity ?? '(ausente)'}`);

      if (sq === undefined || sq === null) {
        console.log('\n        >> sold_quantity NÃO vem preenchido.');
        console.log('           Sem ele não há vendas estimadas. As métricas');
        console.log('           precisariam de outra fonte de sinal.');
      } else if (typeof sq === 'number' && sq > 0 && sq % 50 === 0 && sq >= 100) {
        console.log('\n        >> sold_quantity vem ARREDONDADO (múltiplo de 50).');
        console.log('           O ML mascara o número exato. Deltas pequenos');
        console.log('           somem; só dá para medir produtos de alto giro.');
      } else {
        console.log('\n        >> sold_quantity vem com número real. Bom sinal.');
      }
    }
  }

  // -------------------------------------------------------------------
  console.log('\n  ─────────────────────────────────────────');
  const ok = achados.filter((a) => a.ok);
  const falhou = achados.filter((a) => !a.ok);
  console.log(`  ${ok.length} rotas respondem, ${falhou.length} bloqueadas.\n`);
  if (ok.length) {
    console.log('  Disponíveis:');
    ok.forEach((a) => console.log(`    · ${a.rota}`));
  }
  if (falhou.length) {
    console.log('\n  Bloqueadas:');
    falhou.forEach((a) => console.log(`    · ${a.rota} — ${a.nota}`));
  }
  console.log();

  await sql.end();
}

main().catch(async (e) => {
  console.error('\n  EXCEÇÃO:', e instanceof Error ? e.message : e);
  await sql.end();
  process.exit(1);
});
