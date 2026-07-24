/**
 * Diagnóstico v3 — sem interpretação, só a resposta crua.
 *
 * As duas versões anteriores erraram pelo mesmo motivo: eu decidia o que
 * a resposta significava antes de olhar o que ela era. O v1 leu o corpo
 * de um 404. O v2 descartou 12 erros sem imprimir o motivo e concluiu
 * "campo ausente" a partir de zero amostras.
 *
 * Este aqui não conclui nada. Despeja o JSON e deixa a gente ler.
 *
 * Rode com:  npx tsx test/diagnostico3.ts
 */
import 'dotenv/config';
import { accessToken } from '../src/auth.js';
import { sql } from '../src/db.js';

const API = 'https://api.mercadolibre.com';
let token = '';

async function cru(path: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const texto = await res.text();
  let corpo: any = texto;
  try { corpo = JSON.parse(texto); } catch { /* deixa como texto */ }
  return { status: res.status, corpo };
}

const linha = (t: string) => console.log(`\n  ${t}\n  ${'─'.repeat(45)}`);

async function main() {
  token = await accessToken();

  // -------------------------------------------------------------------
  linha('1. Estrutura crua de /products/{id}/items');
  // -------------------------------------------------------------------
  const d = await cru('/highlights/MLB/category/MLB1051');
  const produtos: any[] = (d.corpo?.content ?? []).filter((c: any) => c.type === 'PRODUCT');

  if (!produtos.length) {
    console.log('  nenhum produto nos destaques — parando aqui.');
    await sql.end();
    return;
  }

  const pid = produtos[0].id;
  console.log(`  produto de teste: ${pid}\n`);

  const itens = await cru(`/products/${pid}/items`);
  console.log(`  status ${itens.status}`);
  console.log('  chaves da resposta:', Object.keys(itens.corpo ?? {}).join(', '));

  const primeiro = itens.corpo?.results?.[0];
  if (primeiro) {
    console.log('\n  PRIMEIRO RESULTADO, JSON COMPLETO:');
    console.log(JSON.stringify(primeiro, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
    console.log('\n  campos disponíveis:', Object.keys(primeiro).join(', '));
  } else {
    console.log('\n  resposta sem results. corpo inteiro:');
    console.log(JSON.stringify(itens.corpo, null, 2).slice(0, 1500));
  }

  // -------------------------------------------------------------------
  linha('2. Por que o multiget falhou');
  // -------------------------------------------------------------------
  // Testa cada candidato a campo de ID, um por um.
  const candidatos = ['item_id', 'id', 'catalog_product_id'];
  for (const campo of candidatos) {
    const valor = primeiro?.[campo];
    console.log(`  ${campo.padEnd(20)} = ${valor ?? '(não existe)'}`);
  }

  const idItem = primeiro?.item_id ?? primeiro?.id;
  if (idItem) {
    console.log(`\n  testando /items/${idItem} isolado:`);
    const um = await cru(`/items/${idItem}`);
    console.log(`  status ${um.status}`);
    if (um.status !== 200) {
      console.log('  corpo do erro:');
      console.log(JSON.stringify(um.corpo, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
    } else {
      console.log(`  título          ${um.corpo.title}`);
      console.log(`  price           ${um.corpo.price}`);
      console.log(`  sold_quantity   ${um.corpo.sold_quantity ?? '(ausente)'}`);
      console.log(`  available_qty   ${um.corpo.available_quantity ?? '(ausente)'}`);
      console.log(`  seller_id       ${um.corpo.seller_id}`);
    }

    console.log(`\n  testando multiget com o mesmo ID:`);
    const multi = await cru(`/items?ids=${idItem}`);
    console.log(`  status ${multi.status}`);
    console.log('  resposta crua:');
    console.log(JSON.stringify(multi.corpo, null, 2).slice(0, 1200)
      .split('\n').map((l) => '    ' + l).join('\n'));
  }

  // -------------------------------------------------------------------
  linha('3. O produto de catálogo já traz preço e venda?');
  // -------------------------------------------------------------------
  // Se /products/{id}/items já devolve os números, o multiget nem
  // precisa funcionar — a coleta sai direto daqui.
  const amostra: any[] = (itens.corpo?.results ?? []).slice(0, 8);
  if (amostra.length) {
    for (const r of amostra) {
      const id = r.item_id ?? r.id ?? '?';
      const preco = r.price ?? r.sale_price?.amount ?? '(sem preço)';
      const vend = r.sold_quantity ?? '(sem sold_quantity)';
      console.log(`  ${String(id).padEnd(16)} preço ${String(preco).padEnd(12)} vendidos ${vend}`);
    }
  }

  // -------------------------------------------------------------------
  linha('4. E a ficha do produto de catálogo?');
  // -------------------------------------------------------------------
  const prod = await cru(`/products/${pid}`);
  console.log(`  status ${prod.status}`);
  if (prod.status === 200) {
    const p = prod.corpo;
    console.log(`  nome            ${p.name}`);
    console.log(`  chaves:         ${Object.keys(p).join(', ')}`);
    if (p.buy_box_winner) {
      console.log('\n  BUY BOX WINNER (quem está ganhando o produto):');
      console.log(JSON.stringify(p.buy_box_winner, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
    }
  }

  console.log();
  await sql.end();
}

main().catch(async (e) => {
  console.error('\n  EXCEÇÃO:', e instanceof Error ? e.message : e);
  await sql.end();
  process.exit(1);
});
