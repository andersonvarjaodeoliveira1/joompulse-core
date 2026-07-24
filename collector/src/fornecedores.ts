/**
 * Importador de catálogo de fornecedor.
 *
 * A estrutura de produtos locais não serve de nada vazia, e esse dado
 * não vem de API nenhuma — vem de planilha que o fornecedor manda, de
 * catálogo em PDF transcrito, ou de cadastro feito por você.
 *
 * Uso:
 *   npm run collect fornecedor ./utimix.csv
 *
 * Formato esperado (cabeçalho na primeira linha, separador , ou ;):
 *
 *   fornecedor;cnpj;telefone;email;site;cidade;estado;tipo;
 *   sku;produto;custo;moq;unidades_por_caixa;categoria;mlb
 *
 * Só "fornecedor", "produto" e "custo" são obrigatórios. O resto entra
 * se existir.
 *
 * A coluna "mlb" é a mais valiosa: se você souber o produto de catálogo
 * correspondente, a margem é calculada. Sem ela o importador tenta
 * casar pelo nome — e avisa quando não conseguir, em vez de inventar.
 */
import { readFileSync } from 'node:fs';
import { sql } from './db.js';

const log = (...a: unknown[]) => console.log(...a);

type Linha = Record<string, string>;

function lerCsv(caminho: string): Linha[] {
  const txt = readFileSync(caminho, 'utf8').replace(/^\uFEFF/, '');
  const linhas = txt.split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return [];

  const sep = (linhas[0].match(/;/g)?.length ?? 0) > (linhas[0].match(/,/g)?.length ?? 0) ? ';' : ',';

  const partir = (l: string): string[] => {
    const out: string[] = [];
    let atual = '';
    let aspas = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"') { aspas = !aspas; continue; }
      if (c === sep && !aspas) { out.push(atual.trim()); atual = ''; continue; }
      atual += c;
    }
    out.push(atual.trim());
    return out;
  };

  const cab = partir(linhas[0]).map((h) =>
    h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]/g, '_'));

  return linhas.slice(1).map((l) => {
    const v = partir(l);
    const o: Linha = {};
    cab.forEach((h, i) => { o[h] = v[i] ?? ''; });
    return o;
  });
}

const numero = (s: string): number | null => {
  if (!s) return null;
  // aceita "R$ 1.234,56" e "1234.56"
  const limpo = s.replace(/[^\d,.-]/g, '');
  const n = limpo.includes(',')
    ? parseFloat(limpo.replace(/\./g, '').replace(',', '.'))
    : parseFloat(limpo);
  return Number.isFinite(n) ? n : null;
};

/** Tenta achar o produto de catálogo pelo nome. Conservador de propósito. */
async function casarPorNome(nome: string): Promise<string | null> {
  const [r] = await sql<{ id: string; sim: number }[]>`
    select id, similarity(name, ${nome}) as sim
      from catalog_products
     where name % ${nome}
     order by sim desc
     limit 1
  `;
  // abaixo de 0.55 o risco de casar errado é alto — e margem calculada
  // contra o produto errado é pior que margem nenhuma.
  return r && r.sim >= 0.55 ? r.id : null;
}

export async function importarFornecedor(caminho: string) {
  const linhas = lerCsv(caminho);
  if (!linhas.length) { log('planilha vazia'); return; }

  log(`\n  ${linhas.length} linha(s) lidas de ${caminho}`);
  log('  ─────────────────────────────────────────────');

  const fornecedores = new Map<string, string>();
  let produtos = 0;
  let vinculados = 0;
  let porNome = 0;
  let semVinculo = 0;
  const problemas: string[] = [];

  for (const [i, l] of linhas.entries()) {
    const nomeForn = l.fornecedor || l.supplier || l.empresa;
    const nomeProd = l.produto || l.nome || l.product;
    const custo = numero(l.custo || l.preco || l.price || '');

    if (!nomeForn || !nomeProd || custo == null) {
      problemas.push(`linha ${i + 2}: faltou fornecedor, produto ou custo`);
      continue;
    }

    // fornecedor (uma vez por planilha)
    let fid = fornecedores.get(nomeForn);
    if (!fid) {
      const [f] = await sql<{ id: string }[]>`
        insert into suppliers (nome, cnpj, telefone, email, site, instagram,
                               cidade, estado, tipo, origem)
        values (${nomeForn}, ${l.cnpj || null}, ${l.telefone || l.whatsapp || null},
                ${l.email || null}, ${l.site || null}, ${l.instagram || null},
                ${l.cidade || null}, ${(l.estado || l.uf || '').toUpperCase() || null},
                ${l.tipo || 'distribuidor'}, 'planilha')
        returning id
      `;
      fid = f.id;
      fornecedores.set(nomeForn, fid);
    }

    // vínculo com o catálogo do ML
    let mlb: string | null = l.mlb || l.catalog_product_id || null;
    if (mlb) {
      const [existe] = await sql`select 1 from catalog_products where id = ${mlb}`;
      if (!existe) {
        problemas.push(`linha ${i + 2}: ${mlb} não está no catálogo coletado`);
        mlb = null;
      } else vinculados++;
    }
    if (!mlb) {
      mlb = await casarPorNome(nomeProd);
      if (mlb) porNome++; else semVinculo++;
    }

    await sql`
      insert into supplier_products
        (supplier_id, nome, descricao, imagem, sku, custo, moq,
         unidades_por_caixa, catalog_product_id, category_id)
      values (
        ${fid}, ${nomeProd}, ${l.descricao || null}, ${l.imagem || null},
        ${l.sku || null}, ${custo}, ${numero(l.moq || '')},
        ${numero(l.unidades_por_caixa || l.caixa || '') ?? 1},
        ${mlb}, ${l.categoria || l.category_id || null}
      )
      on conflict (supplier_id, sku) do update set
        nome = excluded.nome,
        custo = excluded.custo,
        catalog_product_id = coalesce(excluded.catalog_product_id, supplier_products.catalog_product_id),
        preco_desde = current_date
    `;
    produtos++;
  }

  log(`  ${fornecedores.size} fornecedor(es), ${produtos} produto(s)`);
  log(`  vínculo com o catálogo: ${vinculados} por MLB, ${porNome} por nome, ${semVinculo} sem`);

  if (semVinculo > 0) {
    log(`\n  Os ${semVinculo} sem vínculo aparecem na tela, mas SEM margem —`);
    log('  não dá para comparar com preço de mercado que não conhecemos.');
    log('  Preencha a coluna "mlb" na planilha para resolver.');
  }
  if (problemas.length) {
    log(`\n  ${problemas.length} problema(s):`);
    problemas.slice(0, 10).forEach((p) => log('    · ' + p));
    if (problemas.length > 10) log(`    · e mais ${problemas.length - 10}`);
  }
  log();
}

/** Modelo de planilha, para o fornecedor preencher. */
export function modeloCsv(): string {
  return [
    'fornecedor;cnpj;telefone;email;site;cidade;estado;tipo;sku;produto;custo;moq;unidades_por_caixa;mlb',
    'Utimix Importadora;12345678000199;11953007505;contato@utimix.com;utimix.com;São Paulo;SP;importador;BAL01;Balança Digital Corporal Bioimpedância Bluetooth;28,00;50;1;',
    'Utimix Importadora;;;;;;;;FON02;Fone Bluetooth TWS;19,90;100;1;',
  ].join('\n');
}
