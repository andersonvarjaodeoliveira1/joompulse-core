/**
 * Diagnóstico v2 — corrige o erro do v1.
 *
 * O endpoint de destaques devolve uma MISTURA de dois tipos:
 *   type: "ITEM"    -> id é um anúncio,   consulta em /items/{id}
 *   type: "PRODUCT" -> id é um produto de catálogo, consulta em
 *                      /products/{id}/items para chegar nos anúncios
 *
 * O v1 mandava tudo para /items/{id} e tomava 404. Aí lia o corpo da
 * resposta sem checar o código e concluía que sold_quantity não existia.
 * Conclusão inválida: o campo nunca chegou a ser testado.
 *
 * Esta versão resolve os dois caminhos e só então examina o campo,
 * em vários anúncios, para saber se vem cheio, ausente ou arredondado.
 *
 * Rode com:  npx tsx test/diagnostico2.ts
 */
import 'dotenv/config';
import { accessToken } from '../src/auth.js';
import { sql } from '../src/db.js';

const API = 'https://api.mercadolibre.com';
let token = '';

async function get<T = any>(path: string): Promise<T | null> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function main() {
  token = await accessToken();

  // -------------------------------------------------------------------
  // 1. Descoberta pelos destaques, agora separando os dois tipos.
  // -------------------------------------------------------------------
  console.log('\n  1. O que os destaques realmente devolvem');
  console.log('  ─────────────────────────────────────────────');

  const categorias = ['MLB1051', 'MLB1276', 'MLB1648'];
  const idsAnuncio = new Set<string>();
  const idsProduto = new Set<string>();

  for (const cat of categorias) {
    const d = await get(`/highlights/MLB/category/${cat}`);
    const conteudo: any[] = d?.content ?? [];
    const itens = conteudo.filter((c) => c.type === 'ITEM');
    const prods = conteudo.filter((c) => c.type === 'PRODUCT');
    itens.forEach((c) => idsAnuncio.add(c.id));
    prods.forEach((c) => idsProduto.add(c.id));
    console.log(`        ${cat}: ${conteudo.length} destaques  (${itens.length} anúncios, ${prods.length} produtos)`);
  }

  console.log(`\n        total: ${idsAnuncio.size} anúncios diretos, ${idsProduto.size} produtos de catálogo`);

  // -------------------------------------------------------------------
  // 2. Produto de catálogo -> anúncios que o vendem.
  // -------------------------------------------------------------------
  console.log('\n  2. Produto de catálogo vira anúncio?');
  console.log('  ─────────────────────────────────────────────');

  let viaProduto = 0;
  for (const pid of [...idsProduto].slice(0, 3)) {
    const r = await get(`/products/${pid}/items`);
    const achados: any[] = r?.results ?? [];
    achados.forEach((i) => {
      const id = i.item_id ?? i.id;
      if (id) { idsAnuncio.add(id); viaProduto++; }
    });
    console.log(`        ${pid} -> ${achados.length} anúncios`);
  }
  if (viaProduto > 0) {
    console.log(`\n        cada produto de catálogo rende vários anúncios concorrentes.`);
    console.log(`        é exatamente o que a análise de concorrência precisa.`);
  }

  // -------------------------------------------------------------------
  // 3. A PERGUNTA QUE DECIDE O PRODUTO.
  // -------------------------------------------------------------------
  console.log('\n  3. sold_quantity vem preenchido?');
  console.log('  ─────────────────────────────────────────────');

  const amostra = [...idsAnuncio].slice(0, 12);
  if (!amostra.length) {
    console.log('        nenhum anúncio encontrado para testar.');
    await sql.end();
    return;
  }

  const res = await get<any[]>(`/items?ids=${amostra.join(',')}`);
  const bons = (res ?? []).filter((r) => r.code === 200 && r.body);
  const ruins = (res ?? []).filter((r) => r.code !== 200);

  console.log(`        ${bons.length} anúncios retornados, ${ruins.length} com erro\n`);

  let comCampo = 0;
  let arredondados = 0;

  for (const r of bons) {
    const b = r.body;
    const sq = b.sold_quantity;
    const temCampo = sq !== undefined && sq !== null;
    if (temCampo) comCampo++;
    if (temCampo && sq >= 100 && sq % 50 === 0) arredondados++;

    console.log(
      `        ${b.id}  R$ ${String(b.price ?? '?').padEnd(9)} ` +
      `vendidos: ${temCampo ? String(sq).padEnd(8) : '(ausente)'} ` +
      `${String(b.title ?? '').slice(0, 32)}`,
    );
  }

  console.log('\n  ─────────────────────────────────────────────');
  console.log(`  ${comCampo} de ${bons.length} anúncios trazem sold_quantity.`);

  if (comCampo === 0) {
    console.log('\n  >> O campo NÃO existe na resposta.');
    console.log('     Sem ele não há vendas estimadas pelo método atual.');
    console.log('     Alternativa: medir available_quantity decrescente,');
    console.log('     que é ruidoso mas correlaciona com venda.');
  } else if (arredondados > bons.length * 0.6) {
    console.log('\n  >> O campo vem ARREDONDADO na maioria dos casos.');
    console.log('     O ML mascara o número exato em faixas. Variações');
    console.log('     pequenas somem; só dá para medir produtos de giro alto.');
  } else {
    console.log('\n  >> O campo vem com número real.');
    console.log('     As métricas de venda estimada funcionam como projetadas.');
    console.log('     O projeto é viável pelo caminho dos destaques.');
  }

  // -------------------------------------------------------------------
  // 4. Quanto do mercado dá para alcançar por esse caminho?
  // -------------------------------------------------------------------
  console.log('\n  4. Alcance estimado');
  console.log('  ─────────────────────────────────────────────');
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from categories where is_leaf`;
  const porCat = idsAnuncio.size / categorias.length;
  console.log(`        ${n} categorias folha no seu banco`);
  console.log(`        ~${Math.round(porCat)} anúncios por categoria nos destaques`);
  console.log(`        alcance projetado: ~${Math.round(n * porCat).toLocaleString('pt-BR')} anúncios`);
  console.log(`\n        não é o catálogo inteiro, mas são os que vendem.`);

  console.log();
  await sql.end();
}

main().catch(async (e) => {
  console.error('\n  EXCEÇÃO:', e instanceof Error ? e.message : e);
  await sql.end();
  process.exit(1);
});
