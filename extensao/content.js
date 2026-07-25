/**
 * Gringa Radar dentro do Mercado Livre.
 *
 * Duas coisas que a primeira versão errava:
 *
 * 1. IDENTIFICAR O PRODUTO. A URL nem sempre traz um MLB utilizável.
 *    O ML tem pelo menos quatro formatos:
 *      /MLB-4881406189-titulo-_JM     -> anúncio
 *      /p/MLB54987753                 -> produto de catálogo
 *      /up/MLBU3782076252             -> "user product", agrupamento de
 *                                        variações de um vendedor
 *      ?item_id=MLB123                -> variação por parâmetro
 *
 *    O MLBU não é consultável na nossa base. A saída é ler o id do
 *    anúncio de dentro da página, que o ML deixa em vários lugares.
 *
 * 2. ONDE APARECER. Painel flutuante na borda funciona, mas fica fora
 *    do fluxo de leitura. O card agora entra na coluna de compra, ao
 *    lado do preço — onde o olho já está na hora de decidir. A aba
 *    flutuante fica como reserva para páginas sem ponto de encaixe.
 */

// =====================================================================
// 1. IDENTIFICAR O PRODUTO
// =====================================================================
function daUrl() {
  const u = location.href;

  const prod = u.match(/\/p\/(MLB\d+)/i);
  if (prod) return { id: prod[1].toUpperCase(), tipo: 'produto' };

  const param = u.match(/[?&]item_id=(MLB\d+)/i);
  if (param) return { id: param[1].toUpperCase(), tipo: 'anuncio' };

  // MLB-123456789 ou MLB123456789, mas NAO MLBU123 (user product)
  const item = u.match(/MLB-?(\d{8,})/i);
  if (item) return { id: 'MLB' + item[1], tipo: 'anuncio' };

  return null;
}

/**
 * Procura o id do anúncio dentro da página.
 *
 * Necessário nas URLs /up/MLBU..., onde o identificador da barra de
 * endereços não serve para consulta. Tentamos do mais estável para o
 * mais frágil.
 */
function daPagina() {
  const meta = document.querySelector(
    'meta[name="twitter:app:url:iphone"], meta[property="al:ios:url"], link[rel="canonical"]');
  if (meta) {
    const v = meta.getAttribute('content') || meta.getAttribute('href') || '';
    const m = v.match(/MLB-?(\d{8,})/i);
    if (m) return 'MLB' + m[1];
  }

  const input = document.querySelector('input[name="item_id"], input[name="itemId"]');
  if (input?.value) {
    const m = input.value.match(/MLB-?(\d{8,})/i);
    if (m) return 'MLB' + m[1];
  }

  const attr = document.querySelector('[data-item-id], [data-itemid]');
  if (attr) {
    const v = attr.getAttribute('data-item-id') || attr.getAttribute('data-itemid') || '';
    const m = v.match(/MLB-?(\d{8,})/i);
    if (m) return 'MLB' + m[1];
  }

  // Último recurso: primeiro MLB de 9+ dígitos entre aspas no HTML.
  // Frágil de propósito — só roda quando tudo acima falhou.
  const bruto = document.documentElement.innerHTML.match(/"(MLB\d{9,})"/);
  if (bruto) return bruto[1];

  return null;
}

function identificar() {
  const url = daUrl();
  if (url) return url;
  const pg = daPagina();
  return pg ? { id: pg, tipo: 'anuncio' } : null;
}

// =====================================================================
// 2. UTILITÁRIOS
// =====================================================================
const brl = (n) => n == null ? '—'
  : 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => n == null ? '—'
  : (Number(n) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + '%';
const esc = (s) => String(s ?? '').replace(/[<>&"]/g,
  (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const rpc = (nome, corpo) => new Promise((ok) => {
  let respondeu = false;
  // Se o service worker estiver morto, o callback pode nunca ser chamado.
  // Oito segundos e mais que suficiente para uma RPC; depois disso
  // resolvemos vazio e o painel mostra o aviso em vez de travar.
  const t = setTimeout(() => { if (!respondeu) { respondeu = true; ok(null); } }, 8000);
  try {
    chrome.runtime.sendMessage({ tipo: 'rpc', nome, corpo }, (r) => {
      if (chrome.runtime.lastError) { /* contexto invalidado */ }
      if (respondeu) return;
      respondeu = true; clearTimeout(t); ok(r ?? null);
    });
  } catch {
    if (!respondeu) { respondeu = true; clearTimeout(t); ok(null); }
  }
});

function categoriaDaPagina() {
  // O ML trocou o breadcrumb: era /c/MLB1132, virou /c/brinquedos-e-hobbies.
  // O slug não tem o id, então o link não serve mais. Mas a página ainda
  // carrega "category_id":"MLB2963" no JSON embutido — o dado chegou junto
  // com o HTML, é só ler.
  const h = document.documentElement.innerHTML;
  const m = h.match(/"category_id"\s*:\s*"(MLB\d+)"/);
  if (m) return m[1];

  // Formato antigo, caso volte em alguma página.
  for (const a of document.querySelectorAll('a[href*="/c/"], .andes-breadcrumb a')) {
    const mm = a.href?.match(/\/c\/(MLB\d{3,6})(?!\d)/);
    if (mm) return mm[1];
  }
  return null;
}


// =====================================================================
// 2b. O QUE A PRÓPRIA PÁGINA JÁ MOSTRA
//
// O Mercado Livre exibe "+100 vendidos" e o preço para qualquer
// visitante. A API não entrega esse número para anúncio de terceiro,
// mas a página entrega — e é a mesma página que o usuário já está
// olhando. Ler daqui não é contornar limite: é usar o que já chegou.
//
// Cuidado importante: o ML ARREDONDA. "+100 vendidos" pode ser 100 ou
// 149. Tudo derivado disso é aproximação, e o painel diz isso.
// =====================================================================
function lerPagina() {
  const txt = document.body.innerText || '';
  const o = { vendidos: null, aprox: false, preco: null, criado: null, titulo: null,
              nota: null, avaliacoes: null, vendedor: null, marca: null };

  // "+100 vendidos" | "100 vendidos" | "+1mil vendidos"
  const mv = txt.match(/(\+)?\s*([\d.]+)\s*(mil)?\s*vendid/i);
  if (mv) {
    let n = parseFloat(mv[2].replace(/\./g, ''));
    if (mv[3]) n *= 1000;
    if (Number.isFinite(n)) { o.vendidos = n; o.aprox = !!mv[1] || !!mv[3]; }
  }

  // preço: prioriza o meta, que vem sem formatação
  const meta = document.querySelector('meta[itemprop="price"], meta[property="product:price:amount"]');
  if (meta?.content) {
    const p = parseFloat(meta.content);
    if (Number.isFinite(p)) o.preco = p;
  }
  if (o.preco == null) {
    const frac = document.querySelector('.andes-money-amount__fraction');
    const cent = document.querySelector('.andes-money-amount__cents');
    if (frac) {
      const p = parseFloat(frac.textContent.replace(/\./g, '') + '.' + (cent?.textContent || '0'));
      if (Number.isFinite(p)) o.preco = p;
    }
  }

  const t = document.querySelector('h1.ui-pdp-title, h1');
  if (t) o.titulo = t.textContent.trim();

  // -------------------------------------------------------------------
  // Reputação, vendedor e marca — mesma lógica dos "vendidos": está na
  // tela do usuário, a API não entrega para anúncio de terceiro.
  //
  // Os seletores do ML mudam sem aviso, então cada campo tem fallback e
  // nenhum quebra a leitura se falhar. Campo ausente vira null e o
  // painel simplesmente não desenha aquela linha.
  // -------------------------------------------------------------------
  const mNota = document.querySelector('meta[itemprop="ratingValue"]');
  if (mNota?.content) {
    const n = parseFloat(mNota.content.replace(',', '.'));
    if (Number.isFinite(n)) o.nota = n;
  }
  if (o.nota == null) {
    const el = document.querySelector('.ui-pdp-review__rating');
    if (el) {
      const n = parseFloat(el.textContent.trim().replace(',', '.'));
      if (Number.isFinite(n)) o.nota = n;
    }
  }

  const mQtd = document.querySelector('meta[itemprop="reviewCount"], meta[itemprop="ratingCount"]');
  if (mQtd?.content) {
    const n = parseInt(mQtd.content.replace(/\D/g, ''), 10);
    if (Number.isFinite(n)) o.avaliacoes = n;
  }
  if (o.avaliacoes == null) {
    const m = txt.match(/([\d.]+)\s*avalia[çc]/i);
    if (m) {
      const n = parseInt(m[1].replace(/\./g, ''), 10);
      if (Number.isFinite(n)) o.avaliacoes = n;
    }
  }

  const vend = document.querySelector('.ui-pdp-seller__link-trigger, .ui-box-component__link');
  if (vend) o.vendedor = vend.textContent.trim().slice(0, 60);

  const mMarca = txt.match(/Marca\s*[:\n]\s*([^\n]{2,40})/i);
  if (mMarca) o.marca = mMarca[1].trim();

  const mCriado = txt.match(/(?:criado|publicado)\s+em\s+([^\n]{5,30})/i);
  if (mCriado) o.criado = mCriado[1].trim();

  return o;
}

/**
 * Divide as vendas totais pelo tempo de vida do anúncio.
 *
 * Sem a data de criação — que a página raramente mostra — usamos a
 * primeira vez que NÓS vimos o produto. É um piso, não a verdade: o
 * anúncio pode ser bem mais antigo que a nossa coleta. Por isso o
 * painel marca "no mínimo".
 */
function medias(vendidos, diasDeVida) {
  if (!vendidos || !diasDeVida || diasDeVida < 1) return null;
  const mes = vendidos / (diasDeVida / 30);
  return {
    mes: Math.round(mes),
    semana: Math.round(mes / 4.35),
    dia: Math.max(1, Math.round(mes / 30)),
    dias: Math.round(diasDeVida),
  };
}

// =====================================================================
// 3. ONDE ENCAIXAR
// =====================================================================
/**
 * O ML troca essas classes de tempos em tempos, então tentamos várias e
 * caímos na aba flutuante se nenhuma existir. Melhor degradar do que
 * sumir.
 */
function ancora() {
  const tentativas = [
    // Coluna do meio, logo abaixo de "Novo | +50 vendidos". O olho já
    // está aqui quando a pessoa avalia o anúncio.
    '.ui-pdp-header__product-state',
    '.ui-pdp-header__subtitle',
    '.ui-pdp-header__container',
    // pagina de catalogo /p/MLB... tem estrutura propria
    '.ui-pdp-container__row--product-header',
    '.ui-vpp-highlighted-specs',
    // Reservas na coluna de compra.
    '.ui-pdp-container__col-right .ui-box-component-pdp__visible--desktop',
    '.ui-pdp-container__col-right',
    '#buybox',
    '.ui-pdp-payment',
    '.ui-pdp-actions',
    '.ui-vpp-price',
  ];
  for (const sel of tentativas) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

// =====================================================================
// 4. O CARD
// =====================================================================
let alvo = null, dados = null, caixa = null, aba = null;
let estadoInsight = false;

/** Desenha a série de preço que a nossa coleta gravou. */
function grafico(serie) {
  if (!serie || serie.length < 2) {
    return `<div class="gr-c-nota" style="padding:10px 0;text-align:center">
      ${serie && serie.length === 1
        ? 'só uma leitura até agora — a linha aparece a partir da segunda'
        : 'ainda não coletamos preço deste produto'}</div>`;
  }
  const v = serie.map((p) => Number(p.preco_mediano));
  const mx = Math.max(...v), mn = Math.min(...v), rg = (mx - mn) || 1;
  const w = 250, h = 64;
  const pts = v.map((x, i) => [
    (i / (v.length - 1)) * w,
    h - ((x - mn) / rg) * (h - 12) - 6,
  ]);
  const dd = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return `
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"
      role="img" aria-label="Preço mediano em ${v.length} dias">
      <path d="${dd} L ${w} ${h} L 0 ${h} Z" fill="#7C3AED" opacity=".09"/>
      <path d="${dd}" fill="none" stroke="#7C3AED" stroke-width="2"/>
    </svg>
    <div class="gr-c-eixo"><span>${brl(mn)}</span><span>${v.length} dias</span><span>${brl(mx)}</span></div>`;
}

async function carregarPrecos() {
  const box = caixa && caixa.querySelector('#gr-precos');
  if (!box) return;
  const r = await rpc('historico_preco_anuncio', { p_mlb: alvo.id, p_dias: 90 });
  const alvoDiv = box.querySelector('.gr-c-load');
  if (alvoDiv) alvoDiv.outerHTML = grafico(r && r.dados);
}

function html(d) {
  if (d.status === 'sem_quota') {
    return `<div class="gr-c-vazio"><b>Consultas do mês esgotadas</b>
      <p>O contador zera no dia 1º.</p></div>`;
  }

  const pg = lerPagina();
  const conhecido = d.status === 'encontrado';

  // Bloco de ranking — só quando temos o produto na base.
  let topo = '';
  if (conhecido) {
    const s = d.delta_7d;
    const cor = s > 0 ? '#16A34A' : s < 0 ? '#DC2626' : '#8A93A0';

    // Desconto maximo praticado no produto: a distancia entre o anuncio
    // mais barato e o mais caro. Sai da faixa que ja temos, sem coleta nova.
    const desconto = (d.preco_max && d.preco_min && d.preco_max > 0)
      ? (d.preco_max - d.preco_min) / d.preco_max : null;

    // momentum e consistencia ja vinham do banco e o painel ignorava.
    const ROT_MOM = { subindo: ['Subindo', '#16A34A'], caindo: ['Caindo', '#DC2626'],
                      novo: ['Recem-chegado', '#7C3AED'], estavel: ['Estavel', '#8A93A0'] };
    const ROT_CON = { consolidado: ['Consolidado no topo', '#16A34A'],
                      alternando: ['Alternando', '#B45309'],
                      esporadico: ['Esporadico', '#8A93A0'] };
    const etiquetas = [];
    const em = ROT_MOM[String(d.momentum ?? '').toLowerCase()];
    if (em) etiquetas.push(`<span class="gr-c-tag" style="color:${em[1]};border-color:${em[1]}33">${em[0]}</span>`);
    const ec = ROT_CON[String(d.consistencia ?? '').toLowerCase()];
    if (ec) etiquetas.push(`<span class="gr-c-tag" style="color:${ec[1]};border-color:${ec[1]}33">${ec[0]}</span>`);
    topo = `
      <div class="gr-c-topo">
        <div class="gr-c-pos">${d.posicao ?? '—'}<span>º</span></div>
        <div class="gr-c-mv" style="color:${cor}">
          ${s == null ? 'sem histórico ainda'
            : s === 0 ? 'estável em 7 dias'
            : (s > 0 ? '▲ subiu ' : '▼ caiu ') + Math.abs(s) + ' em 7 dias'}
          <span>${esc(d.categoria ?? '')}</span>
        </div>
      </div>
      <div class="gr-c-grade">
        <div><span>Concorrentes</span><b>${d.concorrentes ?? '—'}</b></div>
        <div><span>Vendedores</span><b>${d.vendedores ?? '—'}</b></div>
        <div><span>Preço mediano</span><b>${brl(d.preco_mediano)}</b></div>
        <div><span>Melhor posição</span><b>${d.melhor_posicao != null ? d.melhor_posicao + 'º' : '—'}</b></div>
        <div><span>Dias no top 10</span><b>${d.dias_top10 ?? 0}/${d.dias_observados ?? 0}</b></div>
        <div><span>Usando Full</span><b>${pct(d.full_share)}</b></div>
        ${desconto != null ? `<div><span>Desconto máx.</span><b>${pct(desconto)}</b></div>` : ''}
        ${pg.nota != null ? `<div><span>Avaliação</span><b>${pg.nota.toLocaleString('pt-BR', { minimumFractionDigits: 1 })}${pg.avaliacoes != null ? ` <i style="font-style:normal;font-weight:500;color:#8A93A0">(${pg.avaliacoes.toLocaleString('pt-BR')})</i>` : ''}</b></div>` : ''}
      </div>
      ${etiquetas.length ? `<div class="gr-c-tags">${etiquetas.join('')}</div>` : ''}
      ${d.preco_min != null ? `<div class="gr-c-faixa">menor ${brl(d.preco_min)} · maior ${brl(d.preco_max)}</div>` : ''}
      ${pg.vendedor || pg.marca ? `<div class="gr-c-faixa">${[pg.vendedor && 'vendedor ' + esc(pg.vendedor), pg.marca && 'marca ' + esc(pg.marca)].filter(Boolean).join(' · ')}</div>` : ''}`;
  } else {
    const cat = categoriaDaPagina();
    topo = `<div class="gr-c-vazio">
      <b>${d.status === 'sem_ranking' ? 'Fora do top 20' : 'Ainda não coletado'}</b>
      <p>${d.status === 'sem_ranking'
        ? 'Conhecemos este anúncio, mas o produto nunca apareceu nos destaques.'
        : 'Fora da nossa cobertura — 37% das categorias do ML têm ranking público.'}</p>
      <button class="gr-c-btn gr-c-sec" id="gr-pedir">Pedir coleta deste produto</button>
      ${cat ? `<span class="gr-c-nota">categoria detectada: ${esc(cat)}</span>` : ''}</div>`;
  }

  // Insights vindos da própria página — funcionam mesmo sem o produto
  // estar na nossa base, porque o número está na tela do usuário.
  const temInsight = pg.vendidos != null && pg.preco != null;
  const insight = temInsight ? `
    <button class="gr-c-btn gr-c-sec" id="gr-ins">
      ${estadoInsight ? '▲ Ocultar insights' : '▼ Ver insights'}</button>
    <div class="gr-c-ins" ${estadoInsight ? '' : 'hidden'}>${blocosInsight(pg, d)}</div>` : '';

  return topo + insight + `
    <button class="gr-c-btn ${d.monitorado ? 'gr-c-off' : ''}" id="gr-mon"
      ${conhecido ? '' : 'hidden'}>
      ${d.monitorado ? '✓ No seu monitor' : 'Monitorar este produto'}</button>`;
}

/**
 * Os números derivados do que a página mostra.
 *
 * Tudo aqui é aproximação e o painel diz isso em voz alta. O ML
 * arredonda "+100 vendidos" — pode ser 100 ou 149 — e a base de tempo
 * é a primeira vez que vimos o produto, não a data real de criação do
 * anúncio. Números redondos com cara de precisão seriam pior que nada.
 */
function blocosInsight(pg, d) {
  const dias = d.dias_observados && d.dias_observados > 1 ? d.dias_observados : null;
  const m = dias ? medias(pg.vendidos, dias) : null;
  const receita = pg.vendidos * pg.preco;

  // Alíquotas padrão do Mercado Livre. Variam por categoria e por plano
  // do vendedor — servem para ordem de grandeza, não para contabilidade.
  const COMISSAO = 0.12, IMPOSTO = 0.07;

  return `
    <div class="gr-c-ib">
      <div class="gr-c-it">Vendas <i>segundo a página</i></div>
      <div class="gr-c-igrade">
        <div><span>Total</span><b>${pg.aprox ? '~' : ''}${pg.vendidos.toLocaleString('pt-BR')}</b></div>
        ${m ? `<div><span>Média mensal</span><b>${m.mes}</b></div>
               <div><span>Média semanal</span><b>${m.semana}</b></div>
               <div><span>Média diária</span><b>${m.dia}</b></div>`
            : `<div style="grid-column:span 3"><span>Médias</span>
                 <b style="font-size:12px;font-weight:500;color:#8A93A0">
                   precisam de histórico nosso</b></div>`}
      </div>
      ${m ? `<div class="gr-c-nota">base: ${m.dias} dia(s) de observação — no mínimo,
             o anúncio pode ser mais antigo</div>` : ''}
    </div>

    <div class="gr-c-ib">
      <div class="gr-c-it">Receita e custos <i>estimados</i></div>
      <div class="gr-c-igrade">
        <div><span>Receita total</span><b>${brl(receita)}</b></div>
        <div><span>Comissão 12%</span><b>${brl(receita * COMISSAO)}</b></div>
        <div><span>Imposto 7%</span><b>${brl(receita * IMPOSTO)}</b></div>
        <div><span>Sobra bruta</span>
          <b style="color:#16A34A">${brl(receita * (1 - COMISSAO - IMPOSTO))}</b></div>
      </div>
      <div class="gr-c-nota">alíquotas padrão; variam por categoria e plano do vendedor</div>
    </div>

    <div class="gr-c-ib" id="gr-precos">
      <div class="gr-c-it">Variação de preço <i>coleta nossa</i></div>
      <div class="gr-c-load" style="padding:14px 0">carregando…</div>
    </div>

    <div class="gr-c-aviso">O Mercado Livre arredonda o número de vendidos.
      Use como ordem de grandeza, não como contabilidade.</div>`;
}

function ligarBotoes(d) {
  const pedir = caixa && caixa.querySelector('#gr-pedir');
  if (pedir) pedir.onclick = async () => {
    pedir.disabled = true; pedir.textContent = 'enviando…';
    const r = await rpc('solicitar_coleta',
      { p_mlb: alvo.id, p_categoria: categoriaDaPagina(), p_url: location.href });
    pedir.textContent = r && r.dados && r.dados.ok
      ? `✓ Pedido registrado (${r.dados.pedidos})` : 'não deu';
  };

  const ins = caixa && caixa.querySelector('#gr-ins');
  if (ins) ins.onclick = () => {
    estadoInsight = !estadoInsight;
    const corpo = caixa.querySelector('.gr-c-corpo');
    corpo.innerHTML = html(dados);
    ligarBotoes(dados);
    if (estadoInsight) carregarPrecos();
  };

  const mon = caixa && caixa.querySelector('#gr-mon');
  if (mon && !d.monitorado) mon.onclick = async () => {
    mon.disabled = true; mon.textContent = 'adicionando…';
    const r = await rpc('monitorar_produto', { p_produto: d.produto });
    if (r && r.dados && r.dados.ok) {
      d.monitorado = true;
      mon.className = 'gr-c-btn gr-c-off'; mon.textContent = '✓ No seu monitor';
    } else {
      mon.disabled = false;
      mon.textContent = r && r.dados && r.dados.motivo === 'limite_do_plano'
        ? `limite de ${r.dados.limite} atingido` : 'não deu';
    }
  };
}

function montarCard() {
  const onde = ancora();
  caixa = document.createElement('div');
  caixa.id = 'gr-card';
  caixa.innerHTML = `
    <div class="gr-c-cab">
      <svg viewBox="0 0 56 56" width="16" height="16" aria-hidden="true">
        <circle cx="28" cy="28" r="23" fill="none" stroke="#7C3AED" stroke-width="5"/>
        <path d="M28 28 L46 12" stroke="#7C3AED" stroke-width="5" stroke-linecap="round"/>
        <circle cx="28" cy="28" r="5" fill="#7C3AED"/></svg>
      <span>Gringa <b>Radar</b></span>
    </div>
    <div class="gr-c-corpo"><div class="gr-c-load">consultando…</div></div>`;

  if (onde) {
    // depois do bloco de estado do produto, nao antes do titulo
    onde.parentNode.insertBefore(caixa, onde.nextSibling);
    caixa.classList.add('gr-c-inline');
  } else {
    aba = document.createElement('div');
    aba.id = 'gr-flutua';
    aba.appendChild(caixa);
    document.body.appendChild(aba);
    caixa.classList.add('gr-c-flutua');
  }
}

// =====================================================================
// 5. CICLO
// =====================================================================
async function consultar() {
  const corpo = caixa && caixa.querySelector('.gr-c-corpo');
  if (!corpo) return;
  corpo.innerHTML = '<div class="gr-c-load">consultando…</div>';

  const r = await rpc('resolver_anuncio', { p_mlb: alvo.id });

  // Sem resposta nenhuma: o service worker morreu (acontece sempre que a
  // extensao e recarregada com abas do ML ja abertas). Antes isso deixava
  // o painel em "consultando..." para sempre. Agora ele diz o que fazer.
  if (!r) {
    corpo.innerHTML = `<div class="gr-c-vazio"><b>Conexao perdida</b>
      <p>Recarregue a pagina (F5) para reconectar a extensao.</p></div>`;
    return;
  }

  if (r && r.erro === 'sem_sessao') {
    corpo.innerHTML = `<div class="gr-c-vazio"><b>Entre na sua conta</b>
      <p>Clique no ícone da extensão na barra do Chrome.</p></div>`;
    return;
  }
  if (r && r.erro) {
    corpo.innerHTML = `<div class="gr-c-vazio"><b>Não deu para consultar</b>
      <p>${esc(r.detalhe || 'recarregue a página')}</p></div>`;
    return;
  }

  dados = r.dados;
  corpo.innerHTML = html(dados);
  ligarBotoes(dados);
}

function limpar() {
  if (caixa) caixa.remove();
  if (aba) aba.remove();
  caixa = null; aba = null; dados = null;
}

function verificar() {
  const novo = identificar();

  if (!novo) { limpar(); alvo = null; return; }
  if (alvo && novo.id === alvo.id && caixa && caixa.isConnected) return;

  limpar();
  alvo = novo;
  montarCard();
  consultar();
}

// O ML troca de página sem recarregar em boa parte do site, e o bloco de
// compra às vezes só aparece depois do primeiro desenho.
let ultima = location.href;
new MutationObserver(() => {
  if (location.href !== ultima) { ultima = location.href; setTimeout(verificar, 500); }
  else if (alvo && caixa && !caixa.isConnected) { setTimeout(verificar, 300); }
}).observe(document, { subtree: true, childList: true });

setTimeout(verificar, 600);
