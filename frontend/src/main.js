/** Copyright (c) 2026 Gringa Radar. Todos os direitos reservados. */
import './styles.css';

import { createClient } from '@supabase/supabase-js';
const sb = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
const $ = s => document.querySelector(s);
let monitorPollId = null; // atualização automática do Monitor — ver render()
const S = { view:'home', marketplace: localStorage.getItem('gr_mkt') || 'meli', mktAberto:false,
            produtos:[], categorias:[], categoriasRecentes:[], catDetalhe:null, catDetalheHist:[], categoriaDestaque:null, detalhe:null, quota:null, buscou:false,
            monitorados:[], alertas:[], pedidos:[], aba:'lista', alertaFoco:null, alertaAberto:null,
            digest:null, avisos:[],
            diario:[], diarioMeta:null, diarioAba:'todos', diarioOffset:0, diarioLoaded:false,
            modo:'avancada', F:{ p_com_foto:true }, catSel:null, catLista:[], contagem:null,
            buscaOpen:new Set(['essencial']),
            catAberto:false, catArvore:{}, catAbertos:new Set(), calcCats:[],
            clipesVista:null, clipesProdutos:{imagens:[], video:[]}, clipesAdd:false, clipesBusy:false,
            planos:[], periodoPlano:'mes', checkoutBusy:null, pagoMsg:null,
            assistOpen:false, assistMsgs:[], assistBusy:false,
            vendedores:[], vendBusca:'', vendResultado:[], vendBuscando:false, vendAdd:false,
            locaisCategorias:[], locaisCatSel:new Set(), locaisAba:'todos', locaisFiltrosAbertos:true,
            locaisFavoritos:new Set(JSON.parse(localStorage.getItem('gr_locais_fav')||'[]')),
            locaisCriado:null, locaisCaixaMin:null, locaisCaixaMax:null, locaisOffset:0, histMon:{},
            locaisMeliOn:false, locaisMeliCache:{}, locaisMeliBuscando:false,
            catalogos:[], catalogosBusy:false, catalogosMsg:null, catalogosLoaded:false,
            detalheAba:'catalogo', similares:[], similaresCarregado:false, detalheLocal:null,
            locais:[], contatos:{}, LF:{}, ref:'', refAviso:null, refVivo:null, refBusy:false, refPedidoOk:null,
            sel:null, selecao:new Set() };

const brl = n => n==null?'—':'R$ '+Number(n).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const num = n => n==null?'—':Number(n).toLocaleString('pt-BR');
const pct = n => n==null?'—':(Number(n)*100).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';
const esc = s => String(s??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const NOME_PLANO = { free:'Gratuito', starter:'Starter', pro:'Pro', business:'Business' };

/** Rótulos reais do /users/{id} do ML — level_id e power_seller_status. */
const REP_LABEL = {
  '5_green':'Verde', '4_light_green':'Verde-claro', '3_yellow':'Amarelo',
  '2_orange':'Laranja', '1_red':'Vermelho',
};
const MED_LABEL = { platinum:'MercadoLíder Platinum', gold:'MercadoLíder Gold', silver:'MercadoLíder Silver' };
const repChip = level => {
  if (!level) return '<span class="chip">Sem reputação ainda</span>';
  const cor = level.startsWith('5')||level.startsWith('4') ? 'g' : level.startsWith('3') ? 'y' : 'r';
  return `<span class="chip ${cor}">${esc(REP_LABEL[level] ?? level)}</span>`;
};
const medChip = m => m ? `<span class="chip p">${esc(MED_LABEL[m] ?? m)}</span>` : '';
/** Bloco compacto: reputação + medalha + vendas históricas (API). Sem seguidores — o ML não publica na API. */
const sellerBits = (c) => {
  const bits = [repChip(c.reputacao ?? c.reputation_level)];
  const med = medChip(c.medalha ?? c.power_seller_status);
  if (med) bits.push(med);
  const tx = c.transacoes ?? c.transactions_total;
  if (tx != null) bits.push(`<span class="sb">${num(tx)} venda(s) no histórico do ML</span>`);
  return bits.join(' ');
};

const gmsg = (t,ok) => $('#gmsg').innerHTML = `<div class="msg ${ok?'ok':'err'}">${esc(t)}</div>`;
$('#go').onclick = async () => {
  const { error } = await sb.auth.signInWithPassword({ email:$('#em').value.trim(), password:$('#pw').value });
  if (error) gmsg(/Invalid/.test(error.message)?'E-mail ou senha incorretos.':error.message);
};
$('#reg').onclick = async () => {
  const { error } = await sb.auth.signUp({ email:$('#em').value.trim(), password:$('#pw').value });
  gmsg(error ? error.message : 'Conta criada. Se pedir confirmação, olhe seu e-mail.', !error);
};
$('#pw').onkeydown = e => { if (e.key==='Enter') $('#go').click(); };
$('#sair').onclick = () => sb.auth.signOut();
(function(){
  const salvo = localStorage.getItem('gr_tema') || 'claro';
  document.documentElement.setAttribute('data-tema', salvo);
  const btn = $('#tema'); if (btn) btn.textContent = salvo === 'escuro' ? '☀️' : '🌙';
})();
$('#tema').onclick = () => {
  const atual = document.documentElement.getAttribute('data-tema') === 'escuro' ? 'claro' : 'escuro';
  document.documentElement.setAttribute('data-tema', atual);
  localStorage.setItem('gr_tema', atual);
  $('#tema').textContent = atual === 'escuro' ? '☀️' : '🌙';
};
$('#abrirAssist').onclick = () => { S.assistOpen = !S.assistOpen; renderAssist(); };
$('#assistClose').onclick = () => { S.assistOpen = false; renderAssist(); };
$('#assistSend').onclick = enviarPerguntaAssistente;
$('#assistInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enviarPerguntaAssistente(); });
$('#irAssinatura').onclick = () => { S.view = 'assinatura'; render(); };
$('#stripx').onclick = () => $('#strip').remove();

sb.auth.onAuthStateChange((_e,s) => {
  if (s){ $('#gate').classList.add('hide'); $('#app').classList.remove('hide'); boot(); }
  else { $('#app').classList.add('hide'); $('#gate').classList.remove('hide'); }
});
const boot = async () => {
  const [,,d, dig, av] = await Promise.all([
    quota(), carregarMonitor(), sb.rpc('categoria_destaque'),
    sb.rpc('digest_hoje'), sb.rpc('listar_avisos_sistema', { p_limite: 10 }),
  ]);
  S.categoriaDestaque = d.data?.[0] ?? d.data ?? null;
  S.digest = dig?.data && typeof dig.data === 'object' && Object.keys(dig.data).length
    ? dig.data : null;
  S.avisos = av?.data ?? [];
  lerUrl();
  render();
};

// A extensao abre o app apontando para uma tela: #view=monitor&aba=fila.
// Sem isso qualquer link cai na home e a pessoa procura sozinha.
function lerUrl(){
  const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const v = h.get('view');
  if (v) S.view = v;
  const ab = h.get('aba');
  if (ab) S.aba = ab;
  // Retorno do Checkout Pro: /app/?pago=ok|falha|pendente&plano=pro
  const q = new URLSearchParams(location.search || '');
  const pago = q.get('pago');
  if (pago) {
    S.view = 'assinatura';
    if (pago === 'ok') {
      S.pagoMsg = { ok:true, texto:`Pagamento recebido${q.get('plano') ? ` (${NOME_PLANO[q.get('plano')] ?? q.get('plano')})` : ''}. Em instantes o plano ativa via webhook — atualize a página se o badge ainda mostrar o plano antigo.` };
      quota();
    } else if (pago === 'pendente') {
      S.pagoMsg = { ok:false, texto:'Pagamento pendente no Mercado Pago. Assim que confirmar, o plano libera sozinho.' };
    } else {
      S.pagoMsg = { ok:false, texto:'Pagamento não concluído. Você pode tentar de novo quando quiser.' };
    }
    history.replaceState(null, '', location.pathname + (location.hash || ''));
  }
}
window.addEventListener('hashchange', () => { lerUrl(); render(); });

async function quota(){
  const { data, error } = await sb.rpc('quota_status');
  if (error) return;
  S.quota = data;
  $('#pl').textContent = ({free:'Plano Gratuito',starter:'Starter',pro:'Pro',business:'Business'})[data.plan] ?? data.plan;
  pintaQuota();
}
function pintaQuota(){
  const f = S.quota?.features?.product_search; if (!f) return;
  const el = $('#q');
  if (f.unlimited){ el.className='qbar'; el.innerHTML='<span class="lb">Buscas</span><b>ilimitadas</b>'; return; }
  const p = f.limit ? f.remaining/f.limit : 0;
  el.className = 'qbar' + (f.remaining===0?' dry':'');
  el.innerHTML = `<span class="lb">Buscas</span><span class="track"><u style="width:${(p*100).toFixed(0)}%"></u></span><b>${f.remaining}/${f.limit}</b>`;
}
const seca = () => S.quota?.features?.product_search?.remaining===0
                && !S.quota?.features?.product_search?.unlimited;

const sq = (bg,fg,d) => `<span class="sq" style="background:${bg}">
  <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="${fg}" stroke-width="1.7" stroke-linecap="round">${d}</svg></span>`;
const I = {
  busca:'<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/>',
  cat:'<path d="M3 16V9m5 7V4m5 12v-5m5 5V7"/>',
  conc:'<path d="M4 4h5v12H4zM11 8h5v8h-5z"/>',
  mon:'<path d="M5 3h10v14l-5-3-5 3z"/>',
  calc:'<rect x="4" y="3" width="12" height="14" rx="2"/><path d="M7 7h6M7 11h2M7 14h2"/>',
  rad:'<circle cx="10" cy="10" r="7"/><path d="M10 3v7l5 3"/>',
  loja:'<path d="M3 7l1.5-4h11L17 7M3 7h14v10H3zM3 7a2.5 2.5 0 005 0 2.5 2.5 0 005 0 2.5 2.5 0 004 0"/>',
  cad:'<circle cx="10" cy="7" r="3"/><path d="M4 17c0-3.3 2.7-5 6-5s6 1.7 6 5"/>',
};

const V = {};

function pintaMarketplace(){
  const shopee = S.marketplace === 'shopee';
  const brand = $('#brand-mkt');
  if (brand) brand.textContent = shopee ? 'SHOPEE' : 'MERCADO LIVRE';
  const label = $('#mkt_label');
  if (label) label.textContent = shopee ? 'Shopee' : 'Mercado Livre';
  const dot = $('#mkt_dot');
  if (dot) {
    dot.className = 'dot ' + (shopee ? 'shopee' : 'meli');
    dot.textContent = shopee ? 'S' : '🤝';
  }
  const drop = $('#mkt_drop');
  if (drop) drop.classList.toggle('hide', !S.mktAberto);
  const btn = $('#mkt_btn');
  if (btn) btn.setAttribute('aria-expanded', String(!!S.mktAberto));
  document.querySelectorAll('[data-mkt]').forEach(b => {
    const on = b.dataset.mkt === S.marketplace;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    const ck = b.querySelector('.ck');
    if (ck) ck.classList.toggle('hide', !on);
  });
}

function setMarketplace(mkt){
  if (mkt !== 'meli' && mkt !== 'shopee') return;
  S.marketplace = mkt;
  S.mktAberto = false;
  localStorage.setItem('gr_mkt', mkt);
  if (mkt === 'shopee') S.view = 'shopee';
  else if (S.view === 'shopee') S.view = 'home';
  render();
}

V.shopee = () => `
  <h1 class="pg">Shopee</h1>
  <p class="sub">Mesmo formato do Mercado Livre — ranking, concorrência e oportunidades — quando a coleta estiver no ar.</p>
  <div class="shopee-hero">
    <div class="art" aria-hidden="true">S</div>
    <span class="sp-badge" style="background:rgba(255,255,255,.2);color:#fff;margin-bottom:10px">Em preparação</span>
    <h3>Radar da Shopee a caminho</h3>
    <p>Ainda não coletamos ranking nem anúncios da Shopee. Esta aba já está pronta no app; os dados entram quando a integração e a coleta diária forem ligadas — sem inventar número.</p>
  </div>
  <h2 class="sc">O que vai aparecer aqui</h2>
  <p class="sc2">O mesmo jeito que você já usa no Mercado Livre, adaptado à Shopee.</p>
  <div class="sp-grid">
    <div class="sp-card">${sq('#FFF1ED','#EE4D2D',I.busca)}<b>Busca de produtos</b><p>Produtos em alta na Shopee, com posição e preço quando a API permitir.</p></div>
    <div class="sp-card">${sq('#FFEDD5','#EA580C',I.cat)}<b>Categorias</b><p>Onde entrar: rotatividade e estrutura de mercado por categoria.</p></div>
    <div class="sp-card">${sq('#DCFCE7','#16A34A',I.mon)}<b>Monitor</b><p>Acompanhar produtos e alertas de mudança, no mesmo fluxo do MeLi.</p></div>
    <div class="sp-card">${sq('#EDE9FE','#7C3AED',I.calc)}<b>Margem e custo</b><p>Cruzar preço da Shopee com fornecedor local quando houver dado.</p></div>
  </div>
  <div class="tip" style="margin-top:18px"><b>Por que ainda está vazio.</b> Hoje a coleta diária e as RPCs do app leem só o Mercado Livre.
    Assim que a pipeline da Shopee existir, esta aba passa a listar produtos de verdade — sem placeholder inventado.</div>
  <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
    <button class="btn" data-mkt="meli">Voltar ao Mercado Livre</button>
  </div>`;

V.home = () => { const alertasNovos = S.alertas.filter(a=>!a.lido).length; const cd = S.categoriaDestaque;
  const dig = S.digest;
  const avisosNovos = (S.avisos || []).filter(a => !a.lido).length;
  return `<div class="cols"><div>
  <h1 class="pg">Bem-vindo ao Gringa Radar</h1>
  <p class="sub">Acompanhe o ranking, analise a concorrência e ache o produto certo antes dos outros.</p>
  ${dig && (dig.novos_ranking!=null || dig.posicoes!=null) ? `
  <div class="tip" style="margin:0 0 16px">
    <b>Coleta de ${esc(fmtDiaChart(dig.dia))}.</b>
    ${num(dig.novos_ranking)} <button class="lnk" data-go-diario="novos" style="padding:0;font-size:inherit;color:inherit;text-decoration:underline;font-weight:600">produto(s) novo(s) no ranking</button> ·
    ${num(dig.novos_catalogo)} novo(s) no catálogo ·
    ${num(dig.posicoes)} posições lidas.
    ${avisosNovos?` · <button class="lnk" id="avisos_lidos" style="padding:0;font-size:inherit;color:inherit;text-decoration:underline">${avisosNovos} aviso(s) não lido(s)</button>`:''}
  </div>` : ''}
  ${(S.avisos||[]).filter(a=>!a.lido).slice(0,3).map(a => `
    <div class="card cbox" style="margin-bottom:10px;background:var(--tint)">
      <div class="ct">${esc(a.tipo==='coleta_diaria'?'Coleta diária':a.tipo)}</div>
      <div style="font-weight:600;margin:4px 0">${esc(a.titulo)}</div>
      <div class="sb">${esc(a.detalhe||'')}</div>
    </div>`).join('')}
  <div class="qa" style="margin-bottom:18px">
    <button class="qc" data-go="monitor" style="align-items:flex-start;text-align:left">
      ${sq('#DCFCE7','#16A34A',I.mon)}<span><b style="font-size:20px;display:block">${num(S.monitorados.length)}</b>produto(s) monitorado(s)</span></button>
    <button class="qc" data-go="monitor" style="align-items:flex-start;text-align:left">
      ${sq(alertasNovos?'#FEE2E2':'#F3F4F6', alertasNovos?'#DC2626':'#6B7280',I.rad)}<span><b style="font-size:20px;display:block">${num(alertasNovos)}</b>alerta(s) novo(s)</span></button>
    <button class="qc" data-go-diario="novos" style="align-items:flex-start;text-align:left">${sq('#DBEAFE','#2563EB',I.busca)}<span><b style="font-size:20px;display:block">${dig?num(dig.novos_ranking):'—'}</b>novo(s) no ranking hoje</span></button>
    ${cd?`<button class="qc" data-cd-go="${esc(cd.category_id)}" data-cd-nome="${esc(cd.categoria)}" style="align-items:flex-start;text-align:left">
      ${sq('#FFEDD5','#EA580C',I.cat)}<span><b style="font-size:14px;display:block">${esc(cd.categoria)}</b>
      categoria em destaque hoje · <span class="chip ${cd.oportunidade==='alta'?'g':'y'}" style="font-size:10px">${esc(cd.oportunidade)}</span></span></button>`:''}
  </div>
  <div class="hero">
    <svg class="art" width="190" height="190" viewBox="0 0 56 56" aria-hidden="true">
      <circle cx="28" cy="28" r="24" fill="none" stroke="#fff" stroke-width="2"/>
      <circle cx="28" cy="28" r="15" fill="none" stroke="#fff" stroke-width="1.5"/>
      <path d="M28 28 L46 12" stroke="#fff" stroke-width="2.5"/></svg>
    <h3>Comece pela busca de produtos</h3>
    <p>Veja quem está no topo de cada categoria, quanto custa e quantos vendedores disputam o mesmo produto.</p>
    <button class="b" data-go="produtos">Buscar produtos</button>
  </div>
  <h2 class="sc">Ações rápidas</h2>
  <p class="sc2">Economize tempo com as ferramentas de análise de produto e mercado.</p>
  <div class="qa">
    <button class="qc" data-go="diario">${sq('#E0E7FF','#4338CA',I.rad)}<span>Conteúdo diário</span></button>
    <button class="qc" data-go="produtos">${sq('#EDE9FE','#7C3AED',I.busca)}<span>Busca de produtos</span></button>
    <button class="qc" data-go="categorias">${sq('#FFEDD5','#EA580C',I.cat)}<span>Análise de categoria</span></button>
    <button class="qc" data-go="produtos">${sq('#DBEAFE','#2563EB',I.conc)}<span>Análise da concorrência</span></button>
    <button class="qc" data-go="monitor">${sq('#DCFCE7','#16A34A',I.mon)}<span>Monitor de produtos</span></button>
    <button class="qc" data-go="fornecedores">${sq('#DBEAFE','#2563EB',I.loja)}<span>Produtos dos fornecedores</span></button>
    <button class="qc" data-go="locais">${sq('#FEF3C7','#D97706',I.loja)}<span>Produtos locais</span></button>
    <button class="qc" data-go="extensao">${sq('#EDE9FE','#7C3AED',I.rad)}<span>Extensão Chrome</span></button>
    <button class="qc" data-go="calc">${sq('#FCE7F3','#DB2777',I.calc)}<span>Calculadora de margem</span></button>
  </div></div>
  <aside>
    <h2 class="sc" style="margin-top:0">Recursos</h2>
    <p class="sc2">O que já está no ar e o que vem em seguida.</p>
    <div class="rcard">${sq('#EDE9FE','#7C3AED',I.rad)}<div><b>Coleta diária</b>
      <p>O ranking é lido todo dia. Quanto mais dias, mais preciso o movimento.</p></div></div>
    <div class="rcard">${sq('#DBEAFE','#2563EB',I.conc)}<div><b>Concorrência real</b>
      <p>Todos os vendedores do mesmo produto, com o preço de cada um.</p></div></div>
    <div class="rcard">${sq('#FEF9C3','#CA8A04',I.mon)}<div><b>Estimativa de vendas</b>
      <p>Chega quando houver contas conectadas para calibrar a curva.</p></div></div>
  </aside></div>`; };

const PREDEF = [
  { k:'subindo',  t:'Subindo rápido',       f:{ p_momentum:'subindo', p_delta_min:5 } },
  { k:'calmo',    t:'Pouca concorrência',   f:{ p_nivel_conc:'baixa' } },
  { k:'firme',    t:'Desempenho comprovado',f:{ p_maturidade:'comprovado' } },
  { k:'novo',     t:'Nova oportunidade',    f:{ p_maturidade:'nova' } },
  { k:'volatil',  t:'Preço bagunçado',      f:{ p_estabilidade:'volatil' } },
  { k:'semfull',  t:'Brecha no Full',       f:{ p_full_max:0.3 } },
];

const SEM = {
  p_maturidade: { rot:'Maturidade no ranking', obrig:true, opcoes:[
    { v:'nova',         t:'Nova oportunidade',    d:'Entrou no ranking nos últimos 14 dias' },
    { v:'consolidando', t:'Consolidando',         d:'Duas semanas ou mais, ainda alternando dentro e fora do top 10' },
    { v:'comprovado',   t:'Desempenho comprovado',d:'Três semanas ou mais, com 80% do tempo no top 10' } ] },
  p_nivel_conc: { rot:'Nível de concorrência', opcoes:[
    { v:'baixa', t:'Baixa', d:'Até 5 vendedores disputando. Bom para começar' },
    { v:'media', t:'Média', d:'Entre 6 e 20 vendedores no mesmo produto' },
    { v:'alta',  t:'Alta',  d:'Mais de 20 disputando. Precisa de diferencial claro' } ] },
  p_estabilidade: { rot:'Estabilidade de preço', opcoes:[
    { v:'estavel',   t:'Estável',   d:'Menos de 25% entre o maior e o menor preço' },
    { v:'oscilante', t:'Oscilante', d:'Entre 25% e 60% de diferença' },
    { v:'volatil',   t:'Volátil',   d:'Mais de 60%. Mercado desorganizado, espaço para posicionar' } ] },
};

function semSelect(campo){
  const c = SEM[campo], val = S.F[campo];
  const esc2 = c.opcoes.find(o=>o.v===val);
  const aberto = S.sel === campo;
  return `<div class="sem">
    <label>${c.obrig?'<i>*</i> ':''}${c.rot}</label>
    <button class="semb ${esc2?'':'vazio'}" data-sem="${campo}">${esc2?esc(esc2.t):'Selecionar'}</button>
    ${aberto?`<div class="semd">${c.opcoes.map(o=>
      `<button class="semo" data-sv="${campo}|${o.v}"><b>${esc(o.t)}</b><span>${esc(o.d)}</span></button>`
      ).join('')}</div>`:''}
  </div>`;
}

function chipsAtivos(){
  const F = S.F, out = [];
  const add = (t, k) => out.push(`<span class="fchip">${t}<button data-rmf="${k}">×</button></span>`);
  if (S.catSel)          add(`Categoria: ${esc(S.catSel.nome)}`, 'p_categoria');
  if (F.p_texto)         add(`Texto: ${esc(F.p_texto)}`, 'p_texto');
  if (F.p_pos_min!=null||F.p_pos_max!=null) add(`Posição ${F.p_pos_min??1}–${F.p_pos_max??20}`, 'pos');
  if (F.p_melhor_pos)    add(`Já foi top ${F.p_melhor_pos}`, 'p_melhor_pos');
  if (F.p_preco_min!=null||F.p_preco_max!=null) add(`Preço ${brl(F.p_preco_min??0)}–${F.p_preco_max!=null?brl(F.p_preco_max):'∞'}`, 'preco');
  if (F.p_momentum)      add(`Movimento: ${esc(F.p_momentum)}`, 'p_momentum');
  if (F.p_delta_min)     add(`Subiu ${F.p_delta_min}+`, 'p_delta_min');
  if (F.p_consistencia)  add(`Consistência: ${esc(F.p_consistencia)}`, 'p_consistencia');
  if (F.p_conc_min!=null||F.p_conc_max!=null) add(`Concorrentes ${F.p_conc_min??0}–${F.p_conc_max??'∞'}`, 'conc');
  if (F.p_nivel_conc)    add(`Concorrência: ${esc(F.p_nivel_conc)}`, 'p_nivel_conc');
  if (F.p_dispersao_min) add(`Dispersão ${pct(F.p_dispersao_min)}+`, 'p_dispersao_min');
  if (F.p_full_max!=null) add(`Full até ${pct(F.p_full_max)}`, 'p_full_max');
  if (F.p_full_min!=null) add(`Full ≥ ${pct(F.p_full_min)}`, 'p_full_min');
  if (F.p_oficial_max!=null) add(`Loja oficial ≤ ${pct(F.p_oficial_max)}`, 'p_oficial_max');
  if (F.p_maturidade)    add(`Maturidade: ${esc(F.p_maturidade)}`, 'p_maturidade');
  if (F.p_estabilidade)  add(`Preço: ${esc(F.p_estabilidade)}`, 'p_estabilidade');
  if (F.p_visto_min!=null||F.p_visto_max!=null) add(`Na base ${F.p_visto_min??0}–${F.p_visto_max??'∞'} dias`, 'visto');
  if (F.p_dias_min!=null||F.p_dias_max!=null) add(`Observado ${F.p_dias_min??0}–${F.p_dias_max??'∞'} dias`, 'obs');
  if (F.p_top10_min)     add(`Top 10 ≥ ${F.p_top10_min} dias`, 'p_top10_min');
  if (F.p_top10_rate_min!=null) add(`Taxa top 10 ≥ ${pct(F.p_top10_rate_min)}`, 'p_top10_rate_min');
  if (F.p_com_foto===true)  add('Com foto', 'p_com_foto');
  if (F.p_com_foto===false) add('Sem foto', 'p_com_foto');
  if (F.p_vend_min!=null||F.p_vend_max!=null) add(`Vendedores ${F.p_vend_min??0}–${F.p_vend_max??'∞'}`, 'vend');
  if (F.p_caiu_min)      add(`Caiu ${F.p_caiu_min}+`, 'p_caiu_min');
  return out;
}

/** Preset de faixa De/Até — ativo quando min/max batem exatamente. */
function faixaOn(curMin, curMax, a, z){
  const eq = (x,y) => (x==null||x==='') && (y==null||y==='') || Number(x)===Number(y);
  return eq(curMin, a===''?null:a) && eq(curMax, z===''?null:z);
}
function qcFaixa(attr, curMin, curMax, opcoes){
  return `<div class="qc2">${opcoes.map(([t,a,z]) =>
    `<button type="button" class="${faixaOn(curMin,curMax,a,z)?'on':''}" data-${attr}="${a}|${z}">${t}</button>`
  ).join('')}</div>`;
}


/** Árvore de categorias, no estilo do JoomPulse: raízes abertas de cara,
 *  seta ▸ expande sem sair da posição. Folha não tem seta (nada abaixo). */
function catArvoreHtml(parentId, depth){
  const chave = parentId ?? '_raiz';
  const nos = S.catArvore[chave];
  if (!nos) return '<div class="catcarr">carregando…</div>';
  return nos.map(n => {
    const aberto = S.catAbertos.has(n.id);
    return `<div class="catno" style="padding-left:${depth*14}px">
      <button class="catarrow ${n.is_leaf?'folha':''}" data-toggle="${esc(n.id)}">${aberto?'▾':'▸'}</button>
      <button class="catnome" data-cid="${esc(n.id)}" data-cn="${esc(n.nome)}">${esc(n.nome)}</button>
    </div>${aberto?catArvoreHtml(n.id, depth+1):''}`;
  }).join('');
}

V.produtos = () => {
  const F = S.F, av = S.modo==='avancada', chips = chipsAtivos();
  const painel = S.filtrosAbertos || !S.buscou;
  const open = (k) => (S.buscaOpen?.has(k) ? 'open' : '');

  const catBlock = S.catSel
    ? `<span class="chosen">${esc(S.catSel.nome)} <button id="catx">×</button></span>`
    : `<div class="catwrap"><input id="f_cat" placeholder="Ex.: suplementos, panelas…" autocomplete="off">
       ${S.catAberto?`<div class="catdrop">${
         S.catLista.length?S.catLista.map(c=>
           `<button class="catop" data-cid="${esc(c.id)}" data-cn="${esc(c.nome)}">
              <b>${esc(c.nome)}</b><span>${esc(c.caminho)} · ${c.produtos} produtos</span></button>`).join('')
         :catArvoreHtml(null,0)
       }</div>`:''}
       </div>`;

  const fullVal = F.p_full_min!=null ? 'alto' : F.p_full_max!=null ? 'baixo' : 'ambos';
  const ofiVal = F.p_oficial_max===0 ? 'sem' : F.p_oficial_max!=null ? 'pouca' : 'ambos';

  const filtrosAvancados = `
  <div class="fsecs">
    <details class="fsec" data-sec="essencial" ${open('essencial')}>
      <summary>Essenciais <span class="hint">maturidade, preço estável, foto</span></summary>
      <div class="fsec-body">
        <div class="fgrid2">
          <div>
            ${semSelect('p_maturidade')}
            ${semSelect('p_estabilidade')}
          </div>
          <div>
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Foto no catálogo</label>
            <div class="qc2">
              <button type="button" class="${F.p_com_foto===true?'on':''}" data-foto="1">Com foto</button>
              <button type="button" class="${F.p_com_foto===false?'on':''}" data-foto="0">Sem foto</button>
            </div>
            <div class="indisp" style="margin-top:8px">Sem foto e sem nome ficam de fora por padrão.</div>
          </div>
        </div>
      </div>
    </details>

    <details class="fsec" data-sec="ranking" ${open('ranking')}>
      <summary>Posição e movimento <span class="hint">top 20, tendência</span></summary>
      <div class="fsec-body">
        <div class="fgrid2">
          <div>
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Posição hoje</label>
            ${qcFaixa('rf', F.p_pos_min, F.p_pos_max, [
              ['Top 5','1','5'],['Top 10','1','10'],['11–20','11','20'],
            ])}
            <div class="duo" style="margin-bottom:12px">
              <input id="f_pmin" type="number" placeholder="De" value="${F.p_pos_min??''}">
              <input id="f_pmax" type="number" placeholder="Até" value="${F.p_pos_max??''}">
            </div>
            <div class="frow"><label>Já esteve pelo menos em</label>
              <input id="f_best" type="number" placeholder="ex: 3" value="${F.p_melhor_pos??''}"></div>
          </div>
          <div>
            <div class="frow"><label>Movimento em 7 dias</label>
              <select id="f_mov"><option value="">Qualquer</option>
                <option value="subindo" ${F.p_momentum==='subindo'?'selected':''}>Subindo</option>
                <option value="estavel" ${F.p_momentum==='estavel'?'selected':''}>Estável</option>
                <option value="caindo" ${F.p_momentum==='caindo'?'selected':''}>Caindo</option>
                <option value="novo" ${F.p_momentum==='novo'?'selected':''}>Novo no ranking</option>
              </select></div>
            <div class="frow"><label>Subiu pelo menos</label>
              <input id="f_delta" type="number" placeholder="ex: 5 posições" value="${F.p_delta_min??''}"></div>
            <div class="frow"><label>Caiu pelo menos (7 dias)</label>
              <input id="f_caiu" type="number" placeholder="ex: 3" value="${F.p_caiu_min??''}"></div>
            <div class="frow"><label>Consistência</label>
              <select id="f_cons"><option value="">Qualquer</option>
                <option value="consolidado" ${F.p_consistencia==='consolidado'?'selected':''}>Consolidado</option>
                <option value="recorrente" ${F.p_consistencia==='recorrente'?'selected':''}>Recorrente</option>
                <option value="passageiro" ${F.p_consistencia==='passageiro'?'selected':''}>Passageiro</option>
              </select></div>
          </div>
        </div>
      </div>
    </details>

    <details class="fsec" data-sec="preco" ${open('preco')}>
      <summary>Preço e envio <span class="hint">faixa, Full, loja oficial</span></summary>
      <div class="fsec-body">
        <div class="fgrid2">
          <div>
            <h3 style="font-size:13px;margin:0 0 8px">Preço mediano</h3>
            ${qcFaixa('pf', F.p_preco_min, F.p_preco_max, [
              ['R$ 0–100','0','100'],['R$ 100–250','100','250'],['R$ 250+','250',''],
            ])}
            <div class="duo">
              <input id="f_vmin" type="number" placeholder="De R$" value="${F.p_preco_min??''}">
              <input id="f_vmax" type="number" placeholder="Até R$" value="${F.p_preco_max??''}">
            </div>
          </div>
          <div>
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Share de Full</label>
            <div class="radios">
              <label><input type="radio" name="full" value="ambos" ${fullVal==='ambos'?'checked':''}>Ambos</label>
              <label><input type="radio" name="full" value="baixo" ${fullVal==='baixo'?'checked':''}>Até 30% Full</label>
              <label><input type="radio" name="full" value="alto" ${fullVal==='alto'?'checked':''}>70%+ Full</label>
            </div>
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin:10px 0 6px">Loja oficial</label>
            <div class="radios">
              <label><input type="radio" name="ofi" value="" ${ofiVal==='ambos'?'checked':''}>Ambos</label>
              <label><input type="radio" name="ofi" value="0" ${ofiVal==='sem'?'checked':''}>Sem loja oficial</label>
              <label><input type="radio" name="ofi" value="0.3" ${ofiVal==='pouca'?'checked':''}>Até 30% oficial</label>
            </div>
            <div class="indisp">Fatia real de anúncios Full / oficiais na coleta.</div>
          </div>
        </div>
      </div>
    </details>

    <details class="fsec" data-sec="conc" ${open('conc')}>
      <summary>Concorrência <span class="hint">anúncios, vendedores, dispersão</span></summary>
      <div class="fsec-body">
        <div class="fgrid2">
          <div>
            ${semSelect('p_nivel_conc')}
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Nº de anúncios</label>
            ${qcFaixa('cf', F.p_conc_min, F.p_conc_max, [
              ['1–5','1','5'],['6–20','6','20'],['21+','21',''],
            ])}
            <div class="duo" style="margin-bottom:12px">
              <input id="f_cmin" type="number" placeholder="De" value="${F.p_conc_min??''}">
              <input id="f_cmax" type="number" placeholder="Até" value="${F.p_conc_max??''}">
            </div>
          </div>
          <div>
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Nº de vendedores</label>
            ${qcFaixa('sf', F.p_vend_min, F.p_vend_max, [
              ['1–3','1','3'],['4–10','4','10'],['11+','11',''],
            ])}
            <div class="duo" style="margin-bottom:12px">
              <input id="f_smin" type="number" placeholder="De" value="${F.p_vend_min??''}">
              <input id="f_smax" type="number" placeholder="Até" value="${F.p_vend_max??''}">
            </div>
            <div class="frow"><label>Dispersão de preço mínima</label>
              <select id="f_disp"><option value="">Qualquer</option>
                <option value="0.2" ${F.p_dispersao_min==0.2?'selected':''}>Acima de 20%</option>
                <option value="0.4" ${F.p_dispersao_min==0.4?'selected':''}>Acima de 40%</option>
                <option value="0.7" ${F.p_dispersao_min==0.7?'selected':''}>Acima de 70%</option>
              </select></div>
          </div>
        </div>
      </div>
    </details>

    <details class="fsec" data-sec="hist" ${open('hist')}>
      <summary>Histórico na base <span class="hint">dias observados, top 10</span></summary>
      <div class="fsec-body">
        <div class="indisp" style="margin-bottom:10px">Dados da nossa coleta — não é receita/vendas do ML.</div>
        <div class="fgrid2">
          <div>
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Dias na nossa base</label>
            ${qcFaixa('vf', F.p_visto_min, F.p_visto_max, [
              ['0–7 dias','0','7'],['8–30 dias','8','30'],['31+ dias','31',''],
            ])}
            <div class="duo" style="margin-bottom:12px">
              <input id="f_vmin_visto" type="number" placeholder="De" value="${F.p_visto_min??''}">
              <input id="f_vmax_visto" type="number" placeholder="Até" value="${F.p_visto_max??''}">
            </div>
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Dias observados no ranking</label>
            ${qcFaixa('of', F.p_dias_min, F.p_dias_max, [
              ['Até 7','','7'],['8–21','8','21'],['22+','22',''],
            ])}
            <div class="duo">
              <input id="f_omin" type="number" placeholder="De" value="${F.p_dias_min??''}">
              <input id="f_omax" type="number" placeholder="Até" value="${F.p_dias_max??''}">
            </div>
          </div>
          <div>
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Dias no top 10 (mínimo)</label>
            <div class="qc2" style="margin-bottom:12px">
              <button type="button" class="${F.p_top10_min==1?'on':''}" data-t10="1">1+</button>
              <button type="button" class="${F.p_top10_min==3?'on':''}" data-t10="3">3+</button>
              <button type="button" class="${F.p_top10_min==7?'on':''}" data-t10="7">7+</button>
            </div>
            <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Taxa no top 10</label>
            <div class="qc2" style="margin-bottom:12px">
              <button type="button" class="${F.p_top10_rate_min==0.3?'on':''}" data-t10r="0.3">≥ 30%</button>
              <button type="button" class="${F.p_top10_rate_min==0.5?'on':''}" data-t10r="0.5">≥ 50%</button>
              <button type="button" class="${F.p_top10_rate_min==0.7?'on':''}" data-t10r="0.7">≥ 70%</button>
            </div>
            <div class="frow"><label>Dias no top 10 (mín. exato)</label>
              <input id="f_top10" type="number" placeholder="ex: 5" value="${F.p_top10_min??''}"></div>
          </div>
        </div>
      </div>
    </details>
  </div>`;

  const filtrosSimples = `<div class="fgrid2" style="margin-bottom:8px">
      <div>${semSelect('p_maturidade')}${semSelect('p_nivel_conc')}</div>
      <div>${semSelect('p_estabilidade')}
        <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:6px">Foto</label>
        <div class="qc2">
          <button type="button" class="${F.p_com_foto===true?'on':''}" data-foto="1">Com foto</button>
          <button type="button" class="${F.p_com_foto===false?'on':''}" data-foto="0">Sem foto</button>
        </div>
      </div>
    </div>`;

  return `
  <div class="rhead">
    <div><h1 class="pg">${S.buscou?'Resultados da busca':'Busca de produtos'}</h1>
      <p class="sub" style="margin:0">Rankings do Mercado Livre com movimento, preço e concorrência — só o que a API entrega de verdade.</p></div>
    <span style="flex:1"></span>
    ${S.buscou?`<button class="btn g" id="b_tog">${painel?'Ocultar filtros':'Ajustar filtros'}</button>`:''}
  </div>

  ${chips.length?`<div class="chips"><span class="lb">Ativos</span>${chips.join('')}</div>`:''}

  ${painel?`<div class="busca-panel">
    <div class="modo-mini">
      <button class="mb ${av?'on':''}" data-md="avancada">Filtros avançados</button>
      <button class="mb ${av?'':'on'}" data-md="simples">Busca rápida</button>
    </div>

    <div class="busca-bar">
      <div class="frow"><label>O que você procura</label>
        <input id="f_txt" value="${esc(F.p_texto??'')}" placeholder="nome, marca ou modelo"></div>
      <div class="frow"><label>Categoria</label>${catBlock}</div>
      <button class="btn" id="b_go" ${seca()?'disabled':''}>Procurar</button>
    </div>

    <div class="busca-ref">
      <div class="frow"><label>Ou cole um MLB / link do anúncio</label>
        <input id="f_ref" value="${esc(S.ref??'')}" placeholder="MLB123… ou https://produto.mercadolivre.com.br/…"
          ${S.refBusy?'disabled':''}></div>
      <button class="btn g" id="b_ref" ${S.refBusy?'disabled':''}>${S.refBusy?'Buscando…':'Localizar'}</button>
    </div>
    ${S.refAviso?`<div class="msg err" style="margin:0 0 12px">${esc(S.refAviso)}</div>`:''}
    ${S.refPedidoOk?`<div class="msg ok" style="margin:0 0 12px">${esc(S.refPedidoOk)}</div>`:''}
    ${S.refVivo?`<div class="card cbox" style="margin:0 0 14px;display:flex;gap:14px;align-items:flex-start">
      ${S.refVivo.imagem?`<img class="thumb" src="${esc(S.refVivo.imagem)}" alt="" style="width:64px;height:64px;border-radius:8px">`:''}
      <div style="flex:1;min-width:0">
        <div class="sb" style="margin-bottom:2px">Encontrado ao vivo no Mercado Livre
          ${S.refVivo.tipo==='item'?' · anúncio':' · produto de catálogo'}
          · ainda sem histórico no Gringa Radar</div>
        <div class="nm" style="font-size:15px">${esc(S.refVivo.nome||S.refVivo.id)}</div>
        <div class="sb">${esc(S.refVivo.id)}${S.refVivo.mlb_anuncio?` · anúncio ${esc(S.refVivo.mlb_anuncio)}`:''}
          ${S.refVivo.preco!=null?` · ${brl(S.refVivo.preco)}`:''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          ${S.refVivo.permalink?`<a class="btn g mini" href="${esc(S.refVivo.permalink)}" target="_blank" rel="noopener">Ver no ML</a>`:''}
          <button class="btn mini" id="b_pedir_coleta">Pedir coleta deste anúncio</button>
          <button class="btn g mini" id="b_ref_limpar">Fechar</button>
        </div>
      </div>
    </div>`:''}

    <div class="atalhos"><span class="lb">Atalhos</span>${PREDEF.map(p=>
      `<button class="pd ${S.pred===p.k?'on':''}" data-pd="${p.k}">${p.t}</button>`).join('')}</div>

    ${av ? filtrosAvancados : filtrosSimples}

    <div class="rodape sticky">
      <span class="obs cnt">${S.contagem==null?'Ajuste os filtros — a contagem não gasta busca':`<b>${num(S.contagem)}</b> produto(s) batem com esses filtros`}</span>
      <button class="btn g" id="b_cl">Limpar</button>
      <button class="btn" id="b_go2" ${seca()?'disabled':''}>Procurar</button>
    </div>
  </div>`:''}

  ${S.buscou||seca()?`<div class="rbar">
    <span class="rcount"><b>${num(S.produtos.length)}</b> produto(s)</span>
    <span style="flex:1"></span>
    <span class="seg">
      <button class="${S.periodo==='7'?'on':''}" data-per="7">7 dias</button>
      <button class="${S.periodo==='30'?'on':''}" data-per="30">30 dias</button>
    </span>
    <select id="f_ord" style="padding:7px 11px;border:1px solid var(--line);border-radius:9px;font-size:13px">
      <option value="posicao" ${(!F.p_ordem||F.p_ordem==='posicao')?'selected':''}>Posição</option>
      <option value="movimento" ${F.p_ordem==='movimento'?'selected':''}>Quem mais subiu</option>
      <option value="concorrencia" ${F.p_ordem==='concorrencia'?'selected':''}>Menos concorrência</option>
      <option value="consistencia" ${F.p_ordem==='consistencia'?'selected':''}>Mais consistente</option>
      <option value="preco" ${F.p_ordem==='preco'?'selected':''}>Maior preço</option>
    </select>
    <button class="exp" id="b_exp">⤓ CSV</button>
  </div>`:''}

  ${S.selecao.size?`<div class="selbar"><b>${S.selecao.size}</b> selecionado(s)
    <span style="flex:1"></span>
    <button class="btn" id="b_lote">Monitorar selecionados</button>
    <button class="btn g" id="b_nada">Limpar seleção</button></div>`:''}

  <div class="card" id="res">${seca()?wall():S.buscou?tprod():
    `<div class="none"><b>Comece por um atalho ou digite o que procura</b>A contagem ao lado de Procurar não consome sua quota.</div>`}</div>
  <div class="tip"><b>Lista limpa.</b> Por padrão só entram produtos com foto. Receita, vendas e avaliações
    não aparecem nos filtros: a API do Mercado Livre não entrega isso pra terceiro.</div>`;
};

function tprod(){
  if (!S.produtos.length) return '<div class="none"><b>Nada encontrado</b>Tente afrouxar os filtros.</div>';
  const lim = S.quota?.features?.rows_full;
  const livres = (lim?.unlimited || lim?.limit === -1) ? Infinity : (lim?.limit ?? 5);
  const per = S.periodo === '30' ? 'delta_30d' : 'delta_7d';
  const visiveis = S.produtos.filter(p => {
    const nomeOk = p.name && String(p.name).trim() && String(p.name).trim() !== p.product_id;
    const fotoOk = !!p.picture;
    return nomeOk || fotoOk;
  });
  if (!visiveis.length) return '<div class="none"><b>Nada com foto ou nome</b>Afrouxe o filtro de foto ou amplie a busca.</div>';

  const linhas = visiveis.map((p,i)=>{
    const b = i >= livres ? 'blur' : '';
    const tr = i >= livres ? 'locked' : '';
    const meta = [];
    if (p.momentum) meta.push(`<span class="chip">${esc(p.momentum)}</span>`);
    if (p.full_share!=null) meta.push(`<span class="chip ${p.full_share>=.5?'g':''}">Full ${pct(p.full_share)}</span>`);
    if (p.days_in_top10!=null) meta.push(`<span class="chip">Top10 ${p.days_in_top10}/${p.days_observed??'—'}</span>`);
    return `<tr class="k ${tr}" data-p="${esc(p.product_id)}">
      <td style="width:34px"><input type="checkbox" data-ck="${esc(p.product_id)}"
        ${S.selecao.has(p.product_id)?'checked':''} ${i>=livres?'disabled':''}></td>
      <td style="max-width:340px"><div class="prow">
        ${p.picture?`<img class="thumb" src="${esc(p.picture)}" alt="" loading="lazy">`:`<span class="thumb"></span>`}
        <div><div class="nm">${esc(p.name ?? (p.tipo!=='PRODUCT'
          ? 'Sem ficha pública — Mercado Livre bloqueia esse dado para terceiros'
          : p.product_id))}</div>
          <div class="sb">${esc(p.category_name ?? '')} · ${esc(p.product_id)}</div>
          ${meta.length?`<div class="prod-meta">${meta.join('')}</div>`:''}
        </div>
      </div></td>
      <td class="n">${p.position_now!=null?`<span class="pos" title="${esc(String(p.position_now))}° em ${esc(p.category_name??'—')}">${p.position_now}</span>`:'<span class="pos">—</span>'}</td>
      <td class="n ${b}"><span>${mov(p[per])}</span></td>
      <td class="n ${b}"><span>${num(p.listings)}</span></td>
      <td class="n ${b}"><span>${brl(p.median_price)}</span></td>
      <td class="n ${b}" style="font-size:13px;color:var(--ink-3)"><span>${
        p.min_price!=null?brl(p.min_price)+' – '+brl(p.max_price):'—'}</span></td>
    </tr>`;
  }).join('');

  const travadas = Math.max(0, visiveis.length - livres);
  return `<table><thead><tr>
      <th style="width:34px"><input type="checkbox" id="ck_all"></th>
      <th>Produto</th><th class="n">Posição</th>
      <th class="n">Mov. ${S.periodo==='30'?'30d':'7d'}</th>
      <th class="n">Anúncios</th>
      <th class="n">Preço med.</th><th class="n">Faixa</th>
    </tr></thead><tbody>${linhas}</tbody></table>
    ${travadas>0?`<div class="upsell"><b>${travadas} produto(s) com dados ocultos</b>
      <p>O plano gratuito mostra os ${livres} primeiros por completo. Os outros aparecem borrados
        para você ver o tamanho do resultado antes de decidir.</p>
      <button class="btn">Ver planos</button></div>`:''}`;
}
const mov = d => d==null ? '<span class="mv f">—</span>'
  : d===0 ? '<span class="mv f">—</span>'
  : `<span class="mv ${d>0?'u':'d'}">${d>0?'▲ +':'▼ '}${Math.abs(d)}</span>`;
const wall = () => `<div class="wall"><h3>Suas buscas do mês acabaram</h3>
  <p>O contador zera no dia 1º. Planos pagos liberam de 100 a ilimitadas.</p>
  <button class="btn">Ver planos</button></div>`;

V.categorias = () => `
  <h1 class="pg">Categorias</h1>
  <p class="sub">Onde entrar. A rotatividade mostra quantos produtos do top 20 são novos em relação a 7 dias atrás.</p>
  <div class="filters">
    <div class="fld"><label>Nome da categoria</label><input id="c_txt" placeholder="ex: suplementos"></div>
    <div class="acts"><button class="btn" id="c_go">Carregar</button></div>
  </div>
  ${S.categoriasRecentes.length?`<div class="card" style="margin-bottom:14px">
    <div class="ct">Categorias recentes</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${S.categoriasRecentes.map(c=>`<button class="chip ${c.oportunidade==='alta'?'g':c.oportunidade==='media'?'y':'p'}"
        data-crec="${esc(c.category_id)}" style="cursor:pointer;border:none" title="Buscado em ${new Date(c.ultima_busca).toLocaleDateString('pt-BR')}">
        ${esc(c.nome)}${c.oportunidade?` · ${esc(c.oportunidade)}`:''}
      </button>`).join('')}
    </div>
  </div>`:''}
  <div class="card" id="cres">${S.categorias.length?tcat():
    `<div class="none"><b>Clique em Carregar</b>Cada carga consome uma unidade da quota de categorias.</div>`}</div>
  <div class="tip"><b>Por que rotatividade e não faturamento.</b> A API do Mercado Livre não entrega
    número de vendas de anúncio de terceiro. Ela entrega posição — e a troca de nomes no topo diz
    mais sobre chance de entrada do que um faturamento estimado diria.</div>`;

function tcat(){
  if (!S.categorias.length) return '<div class="none"><b>Nada encontrado</b></div>';
  return `<table><thead><tr><th>Categoria</th><th class="n">Oportunidade</th>
    <th class="n">Rotatividade 7d</th><th class="n">Produtos</th><th class="n">Concorrentes/prod</th>
    <th class="n">Preço mediano</th><th class="n">Dias</th></tr></thead><tbody>${S.categorias.map(c=>`
    <tr class="k" data-cid="${esc(c.category_id)}" data-cn="${esc(c.categoria)}"><td><div class="nm">${esc(c.categoria)}</div>
      <div class="sb">${esc((c.path_names||[]).slice(0,2).join(' › '))}</div></td>
      <td class="n"><span class="chip ${c.oportunidade==='alta'?'g':c.oportunidade==='media'?'y':'p'}">${esc(c.oportunidade)}</span></td>
      <td class="n">${c.rotatividade_7d!=null?`${pct(c.rotatividade_7d)} <span class="sb" style="display:inline">(${c.entrantes})</span>`:'<span style="color:var(--ink-3)">sem base</span>'}</td>
      <td class="n">${num(c.produtos_rankeados)}</td>
      <td class="n">${c.concorrentes_medio ?? '—'}</td>
      <td class="n">${brl(c.preco_mediano)}</td>
      <td class="n" style="color:var(--ink-3)">${c.dias_observados ?? 0}</td>
    </tr>`).join('')}</tbody></table>`;
}

V.catdetalhe = () => {
  const c = S.catDetalhe;
  return `
  <button class="btn g mini" id="cd_voltar" style="margin-bottom:14px">‹ Categorias</button>
  ${!c ? '<div class="card"><div class="load">carregando…</div></div>' : `
  <div class="rhead">
    <div><div class="sb">${esc((c.path_names||[]).join(' › '))}</div>
      <h1 class="pg" style="margin-top:2px">${esc(c.categoria)}</h1></div>
    <span style="flex:1"></span>
    <span class="chip ${c.oportunidade==='alta'?'g':c.oportunidade==='media'?'y':'p'}" style="font-size:13px">${esc(c.oportunidade)}</span>
  </div>
  <div class="stats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:14px 0">
    <div class="card cbox"><div class="ct">Rotatividade 7d</div>
      <div class="v" style="font-size:22px;font-weight:700">${c.rotatividade_7d!=null?pct(c.rotatividade_7d):'—'}</div>
      <div class="sb">${c.entrantes} entrante(s) no top ${c.produtos_rankeados}</div></div>
    <div class="card cbox"><div class="ct">Preço mediano</div>
      <div class="v" style="font-size:22px;font-weight:700">${brl(c.preco_mediano)}</div></div>
    <div class="card cbox"><div class="ct">Concorrentes/produto</div>
      <div class="v" style="font-size:22px;font-weight:700">${c.concorrentes_medio ?? '—'}</div>
      <div class="sb">${num(c.anuncios_totais)} anúncio(s) no total</div></div>
    <div class="card cbox"><div class="ct">Dispersão de preço</div>
      <div class="v" style="font-size:22px;font-weight:700">${c.dispersao_media!=null?pct(c.dispersao_media):'—'}</div>
      <div class="sb">quanto maior, mais desorganizado o mercado</div></div>
    <div class="card cbox"><div class="ct">Vendido via Full</div>
      <div class="v" style="font-size:22px;font-weight:700">${c.full_medio!=null?pct(c.full_medio):'—'}</div></div>
    <div class="card cbox"><div class="ct">Dias observados</div>
      <div class="v" style="font-size:22px;font-weight:700">${c.dias_observados ?? 0}</div></div>
  </div>
  <div class="tip" style="margin-bottom:14px"><b>Sem Receita e Vendas aqui.</b> Testamos ao vivo: o Mercado Livre
    não entrega quantidade vendida de anúncio de terceiro por nenhum caminho que a conta tem acesso — nem no
    endpoint de catálogo, nem no de itens. Qualquer número de receita por categoria seria inventado. O que dá
    pra afirmar com dado real é estrutura de mercado: rotatividade, concorrência e preço, acima.</div>
  <div class="card" style="margin-bottom:14px">
    <div class="ct">Tendência real (30 dias)</div>
    ${sparkCategoria(S.catDetalheHist)}
  </div>
  <h2 style="font-size:16px;margin:18px 0 10px">Produtos desta categoria</h2>
  <div class="card" id="res">${S.buscou?tprod():'<div class="load">carregando produtos…</div>'}</div>
  `}`;
};

V.locais = () => {
  const q = S.quota?.features?.supplier_unlock;
  const aberto = S.locaisFiltrosAbertos;
  return `
  <h1 class="pg">Produtos locais</h1>
  <p class="sub">Fornecedores no Brasil com preço de custo, comparado ao que o produto está valendo no Mercado Livre.</p>
  <div class="cfld" style="max-width:520px;display:flex;gap:8px;margin-bottom:14px">
    <input id="l_txt" placeholder="Pesquisar por nome do produto">
    <button class="btn" id="l_go" style="flex:none">Buscar</button>
  </div>
  <div style="display:grid;grid-template-columns:${aberto?'260px 1fr':'44px 1fr'};gap:20px;align-items:start">
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        ${aberto?'<b style="font-size:15px">Filtros</b>':''}
        <button class="btn g mini" id="l_toggle_f" style="padding:6px 10px">${aberto?'‹':'›'}</button>
      </div>
      ${aberto?`<div class="card cbox">
        <div class="ct">Categorias</div>
        <div style="max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:2px">
          ${S.locaisCategorias.map(c=>`<label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px;cursor:pointer">
            <input type="checkbox" data-lcat="${esc(c.id)}" ${S.locaisCatSel.has(c.id)?'checked':''}>
            <span style="flex:1">${esc(c.nome)}</span><span class="sb">${num(c.total)}</span>
          </label>`).join('')}
        </div>
      </div>
      <div class="card cbox" style="margin-top:12px">
        <div style="display:flex;align-items:center;gap:10px">
          <button id="l_meli_tog" role="switch" aria-checked="${S.locaisMeliOn}"
            style="width:38px;height:22px;border-radius:99px;border:0;background:${S.locaisMeliOn?'var(--brand)':'var(--line)'};position:relative;flex:none;cursor:pointer">
            <span style="position:absolute;top:2px;left:${S.locaisMeliOn?'18px':'2px'};width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s"></span>
          </button>
          <span style="flex:1;font-size:13.5px">Encontrado no MeLi</span>
        </div>
        <div class="sb" style="margin-top:6px">Busca ao vivo no catálogo do Mercado Livre pelo nome do produto,
          pros que ainda não têm vínculo direto.${S.locaisMeliBuscando?' Buscando…':''}</div>
      </div>
      <div class="card cbox" style="margin-top:12px">
        <div class="ct">Faixa de custo personalizada</div>
        <div class="crow"><div class="cfld"><label>De</label><input type="number" id="l_custo_min" placeholder="R$"></div>
          <div class="cfld"><label>Até</label><input type="number" id="l_custo_max" placeholder="R$"></div></div>
      </div>
      <div class="card cbox" style="margin-top:12px">
        <div class="ct">Anúncio criado</div>
        <div class="radios" style="flex-direction:column;gap:8px;padding:4px 0">
          ${[[null,'Qualquer época'],[7,'Nos últimos 7 dias'],[30,'Nos últimos 30 dias'],[90,'Nos últimos 90 dias']].map(([v,l])=>
            `<label><input type="radio" name="l_criado" value="${v??''}" ${S.locaisCriado===v?'checked':''}>${l}</label>`).join('')}
        </div>
      </div>
      <div class="card cbox" style="margin-top:12px">
        <div class="ct">Itens por caixa</div>
        <div class="radios" style="flex-direction:column;gap:8px;padding:4px 0">
          ${[[null,null,'Qualquer'],[null,10,'Até 10'],[null,50,'Até 50'],[null,100,'Até 100'],[100,null,'100+']].map(([mn,mx,l])=>
            `<label><input type="radio" name="l_caixa" value="${mn??''}|${mx??''}" ${S.locaisCaixaMin===mn&&S.locaisCaixaMax===mx?'checked':''}>${l}</label>`).join('')}
        </div>
      </div>
      <div class="card cbox" style="margin-top:12px">
        <div class="ct">Margem bruta mínima</div>
        <select id="l_marg"><option value="">Qualquer</option>
          <option value="0.3">Acima de 30%</option><option value="0.5">Acima de 50%</option>
          <option value="0.7">Acima de 70%</option></select>
      </div>`:''}
    </div>
    <div>
      <div class="tabs" style="margin-bottom:14px">
        <button class="tb ${S.locaisAba==='todos'?'on':''}" data-lab="todos">Todos os produtos</button>
        <button class="tb ${S.locaisAba==='favoritos'?'on':''}" data-lab="favoritos">Favoritos (${S.locaisFavoritos.size})</button>
      </div>
      <div class="sb" style="margin-bottom:12px">${num(S.locais.length)} produto(s) encontrado(s)</div>
      ${q ? `<div class="tip" style="margin:0 0 16px">
        <b>Desbloqueios restantes neste mês: ${q.unlimited?'ilimitados':q.remaining}.</b>
        Ver os contatos de um fornecedor consome um. Reabrir um que você já liberou é grátis.</div>`:''}
      <div id="lres">${cardsLocais()}</div>
    </div>
  </div>`;
};

async function buscarMeliParaLocais(){
  const alvos = S.locais.filter(p => !p.catalog_product_id && !S.locaisMeliCache[p.produto_id]);
  if (!alvos.length) return;
  S.locaisMeliBuscando = true; render();
  const LOTE = 3;
  for (let i=0; i<alvos.length; i+=LOTE){
    if (!S.locaisMeliOn) break; // usuario desligou no meio da busca
    const fatia = alvos.slice(i, i+LOTE);
    await Promise.all(fatia.map(async p => {
      const { data, error } = await sb.functions.invoke('ml-busca-catalogo', { body: { texto:p.nome } });
      S.locaisMeliCache[p.produto_id] = error ? { ok:false } : data;
    }));
    render();
  }
  S.locaisMeliBuscando = false; render();
}
async function carregarCategoriasLocais(){
  if (S.locaisCategorias.length) return;
  const { data } = await sb.rpc('categorias_locais_contagem');
  S.locaisCategorias = data ?? [];
}

function cardsLocais(){
  const lista = S.locaisAba === 'favoritos'
    ? S.locais.filter(p => S.locaisFavoritos.has(p.produto_id))
    : S.locais;
  if (!lista.length) return `<div class="card"><div class="none">
    <b>${S.locaisAba==='favoritos'?'Nenhum favorito ainda':'Nada encontrado'}</b>
    ${S.locaisAba==='favoritos'?'Clique no ♡ de um produto pra guardar aqui.'
      :'Sem fornecedor cadastrado ainda — importe com <code>npm run collect fornecedor arquivo.csv</code>.'}</div></div>`;
  return `<div class="lgrid">${lista.map(p=>{
    const c = S.contatos[p.fornecedor_id];
    const fav = S.locaisFavoritos.has(p.produto_id);
    // Sem vinculo direto com o catalogo: se "Encontrado no MeLi" estiver
    // ligado, usa o achado da busca ao vivo (mesmo nome local, preco real
    // do match) em vez do "sem base" de sempre.
    const achado = !p.catalog_product_id && S.locaisMeliOn ? S.locaisMeliCache[p.produto_id] : null;
    const matchId = p.catalog_product_id || (achado?.encontrado ? achado.catalog_product_id : null);
    const precoMl = p.preco_medio_ml ?? (achado?.encontrado ? achado.preco_mediano : null);
    const margemMl = p.margem_bruta ?? ((precoMl && p.custo!=null && precoMl>0) ? (precoMl-p.custo)/precoMl : null);
    return `<div class="lc">
      <div class="lhead">
        <div style="position:relative">
          ${p.imagem ? `<img class="limg" src="${esc(p.imagem)}" alt="" ${matchId?`style="cursor:pointer" data-labrir="${esc(matchId)}" data-lprodid="${esc(p.produto_id)}" data-lcusto="${p.custo??''}" data-lforn="${esc(p.fornecedor??'')}" data-lfornid="${esc(p.fornecedor_id??'')}" title="Ver dados de varejo"`:''}>`
                     : `<div class="limg">sem foto</div>`}
          ${p.catalog_product_id?`<span class="chip g" style="position:absolute;bottom:4px;left:4px;font-size:10px">No catálogo ML</span>`
            : achado?.encontrado?`<span class="chip y" style="position:absolute;bottom:4px;left:4px;font-size:10px">Encontrado no MeLi</span>`
            : (S.locaisMeliOn && S.locaisMeliBuscando)?`<span class="chip" style="position:absolute;bottom:4px;left:4px;font-size:10px">buscando…</span>`:''}
          <button class="btn g mini" data-lfav="${esc(p.produto_id)}"
            style="position:absolute;top:4px;right:4px;padding:2px 6px;line-height:1">${fav?'♥':'♡'}</button>
        </div>
        <div><div class="lnome">${esc(p.nome)}</div>
          <div class="sb">${p.unidades_por_caixa ?? 1} por caixa${p.moq?` · mínimo ${p.moq}`:''}
            ${p.criado_em?` · publicado em ${new Date(p.criado_em).toLocaleDateString('pt-BR')}`:''}</div></div>
      </div>
      <div class="lbody">
        <div class="lprice">
          <div class="k">Custo do fornecedor</div>
          <div class="v">${brl(p.custo)}</div>
          <div class="sb">preço válido desde ${esc(p.preco_desde ?? '—')}</div>
          <div class="lmini">
            <div><div class="k">Preço médio no ML</div>
              <div class="v">${precoMl!=null?brl(precoMl):'—'}</div></div>
            <div><div class="k">Margem bruta</div>
              <div class="v" style="color:${margemMl>=0.4?'var(--up)':margemMl!=null?'var(--warn)':'var(--ink-3)'}">
                ${margemMl!=null?'≈'+pct(margemMl):'sem base'}</div></div>
          </div>
          ${p.posicao_ml!=null?`<div class="sb" style="margin-top:9px">
            ${p.posicao_ml}º no ranking · ${p.concorrentes_ml ?? 0} concorrente(s)</div>`:''}
        </div>
      </div>
      <div class="lfoot">
        <div class="lforn"><b>${esc(p.fornecedor)}</b>
          ${esc(p.cidade ?? '')}${p.estado?' · '+esc(p.estado):''}
          ${p.verificado?' <span class="chip g">verificado</span>':''}</div>
        ${c ? `<div class="ct2">
            ${c.telefone?`<a href="tel:${esc(c.telefone)}">☎ ${esc(c.telefone)}</a>`:''}
            ${c.email?`<a href="mailto:${esc(c.email)}">✉ ${esc(c.email)}</a>`:''}
            ${c.site?`<a href="https://${esc(c.site)}" target="_blank" rel="noopener">🌐 ${esc(c.site)}</a>`:''}
            ${c.instagram?`<span>◎ ${esc(c.instagram)}</span>`:''}
          </div>
          <div class="aviso">Contatos vindos do catálogo do fornecedor. Não verificamos a conduta dele —
            confira antes de fechar pedido.</div>`
          : `<button class="lock" data-unl="${esc(p.fornecedor_id)}">🔒 Mostrar contatos</button>`}
      </div>
    </div>`;
  }).join('')}</div>
  ${S.locaisAba==='todos' && S.locais.length > 0 && S.locais.length % 60 === 0
    ? `<div style="text-align:center;margin-top:16px"><button class="btn" id="l_mais">Carregar mais</button></div>` : ''}`;
}

V.diario = () => {
  const meta = S.diarioMeta || {};
  const aba = S.diarioAba || 'todos';
  const lista = S.diario || [];
  return `
  <h1 class="pg">Conteúdo diário</h1>
  <p class="sub">Produtos da última coleta no Mercado Livre
    ${meta.dia ? `· <b>${esc(fmtDiaChart(meta.dia))}</b>` : ''}
    — atualiza sozinho depois da coleta (~03:10).</p>
  <div class="tabs" style="margin-bottom:14px">
    <button class="tb ${aba==='todos'?'on':''}" data-daba="todos">Todos (${num(meta.total)})</button>
    <button class="tb ${aba==='novos'?'on':''}" data-daba="novos">Só novos (${num(meta.novos)})</button>
  </div>
  ${meta.erro
    ? `<div class="card"><div class="none"><b>Não deu pra carregar</b>${esc(meta.erro)}</div></div>`
    : !S.diarioLoaded
    ? '<div class="card"><div class="load">carregando produtos da última coleta…</div></div>'
    : !lista.length
      ? `<div class="card"><div class="none"><b>Nada nesta lista ainda</b>
          A coleta diária (~03:10) preenche e atualiza esta aba automaticamente.</div></div>`
      : `<div class="card"><table><thead><tr>
          <th>Produto</th><th class="n">Posição</th><th class="n">Preço med.</th>
          <th class="n">Anúncios</th><th>Movimento</th><th></th>
        </tr></thead><tbody>${lista.map(p => {
          const d = p.delta_7d;
          const mov = d==null ? '—' : d>0 ? `↑ ${d}` : d<0 ? `↓ ${Math.abs(d)}` : '—';
          const cor = d>0 ? 'var(--up)' : d<0 ? 'var(--dn)' : 'var(--ink-3)';
          return `<tr class="k" data-p="${esc(p.product_id)}">
            <td style="max-width:360px"><div style="display:flex;gap:10px;align-items:center">
              ${p.imagem?`<img src="${esc(p.imagem)}" alt="" width="40" height="40"
                style="border-radius:6px;object-fit:cover;flex:none;background:#f2f2f5">`:''}
              <div style="min-width:0">
                <div class="nm">${esc(p.nome)}
                  ${p.novo?' <span class="chip g">novo</span>':''}</div>
                <div class="sb">${esc(p.categoria||'—')} · ${esc(p.product_id)}</div>
              </div></div></td>
            <td class="n"><span class="pos">${p.posicao ?? '—'}</span></td>
            <td class="n">${brl(p.preco_mediano)}</td>
            <td class="n">${num(p.concorrentes)}</td>
            <td style="color:${cor};font-weight:600">${mov}
              ${p.momentum?`<div class="sb">${esc(p.momentum)}</div>`:''}</td>
            <td class="n"><button class="btn mini g" data-p="${esc(p.product_id)}">Ver</button></td>
          </tr>`;
        }).join('')}</tbody></table></div>
        ${lista.length >= 60 && lista.length % 60 === 0
          ? `<div style="text-align:center;margin-top:14px"><button class="btn" id="d_mais">Carregar mais</button></div>` : ''}`}
  <div class="tip" style="margin-top:16px"><b>O que é “novo”.</b> Produto que apareceu no ranking público
    (top 20 da categoria) nesta coleta e nunca tinha entrado nas coletas anteriores.
    Posição = melhor colocação do produto no dia entre as categorias lidas.
    Itens sem foto e sem nome ficam de fora da lista.</div>`;
};

async function carregarDiario(acumular = false){
  const soNovos = S.diarioAba === 'novos';
  if (!acumular) S.diarioOffset = 0;
  try {
    const [lista, meta] = await Promise.all([
      sb.rpc('conteudo_diario', {
        p_dia: null,
        p_so_novos: soNovos,
        p_limite: 60,
        p_offset: S.diarioOffset,
      }),
      sb.rpc('contar_conteudo_diario', { p_dia: null, p_so_novos: soNovos }),
    ]);
    if (lista.error || meta.error) {
      S.diario = [];
      S.diarioMeta = { erro: (lista.error || meta.error).message };
    } else {
      S.diario = acumular ? [...S.diario, ...(lista.data ?? [])] : (lista.data ?? []);
      S.diarioMeta = meta.data ?? {};
    }
  } catch (e) {
    S.diario = [];
    S.diarioMeta = { erro: e?.message || 'Falha ao carregar conteúdo diário' };
  }
  S.diarioLoaded = true;
}

V.fornecedores = () => {
  const msg = S.catalogosMsg;
  const lista = S.catalogos;
  const stChip = s => s==='email_enviado' ? '<span class="chip g">e-mail enviado</span>'
    : s==='erro_email' ? '<span class="chip r">salvo · e-mail pendente</span>'
    : '<span class="chip y">recebido</span>';
  return `
  <h1 class="pg">Produtos dos fornecedores <span class="beta">Beta</span></h1>
  <p class="sub">Carregue catálogos de fornecedores em PDF. Guardamos o arquivo no banco (Storage) e
    enviamos automaticamente para análise. Depois do processamento, os itens entram em
    <button class="lnk" data-go="locais" style="padding:0;font-size:inherit;color:var(--brand)">Produtos locais</button>.</p>
  <div class="tip" style="margin-bottom:16px"><b>O que esta aba faz de verdade.</b>
    Sobe o PDF, registra metadados e dispara o e-mail com o anexo.
    A conversão automática do PDF em tabela (SKU, preço, EAN, fotos) ainda não roda sozinha —
    não inventamos produtos a partir do arquivo.</div>
  <div class="dropz" id="cat_drop" ${S.catalogosBusy?'style="opacity:.6;pointer-events:none"':''}>
    <div class="dz-ico" aria-hidden="true">📄</div>
    <div class="dz-t">${S.catalogosBusy?'Enviando catálogo…':'Carregue ou solte catálogos aqui'}</div>
    <p class="dz-d">Vários PDFs dos seus fornecedores. Máximo 20&nbsp;MB por arquivo.</p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:14px">
      <input id="cat_forn" placeholder="Nome do fornecedor (opcional)" style="padding:9px 12px;border:1px solid var(--line);border-radius:9px;min-width:220px;background:var(--card)">
      <input id="cat_notas" placeholder="Notas (opcional)" style="padding:9px 12px;border:1px solid var(--line);border-radius:9px;min-width:220px;background:var(--card)">
    </div>
    <button class="btn" id="cat_pick" ${S.catalogosBusy?'disabled':''}>⬆ Escolha os catálogos</button>
    <input type="file" id="cat_file" accept="application/pdf,.pdf" multiple hidden>
  </div>
  ${msg?`<div class="msg ${msg.ok?'ok':'err'}" style="margin-top:14px">${esc(msg.t)}</div>`:''}
  <h2 class="sc">Seus envios</h2>
  <p class="sc2">Histórico dos PDFs que você mandou nesta conta.</p>
  <div class="card">${!S.catalogosLoaded
    ? '<div class="load">carregando…</div>'
    : !lista.length
      ? `<div class="none"><b>Nenhum catálogo ainda</b>Escolha um PDF acima pra começar.</div>`
      : `<table><thead><tr><th>Arquivo</th><th>Fornecedor</th><th class="n">Tamanho</th><th>Status</th><th class="n">Enviado em</th></tr></thead><tbody>${
        lista.map(c=>`<tr>
          <td><div class="nm">${esc(c.nome_arquivo)}</div>
            ${c.email_erro?`<div class="sb" style="color:var(--dn)">${esc(c.email_erro)}</div>`:''}</td>
          <td>${esc(c.fornecedor_nome||'—')}</td>
          <td class="n">${c.tamanho_bytes!=null?(c.tamanho_bytes/1024/1024).toFixed(2)+' MB':'—'}</td>
          <td>${stChip(c.status)}</td>
          <td class="n">${c.criado_em?new Date(c.criado_em).toLocaleString('pt-BR'):'—'}</td>
        </tr>`).join('')
      }</tbody></table>`}</div>
  <div class="feat2">
    <div class="fcard">
      <h3>Carregue qualquer catálogo</h3>
      <p>O PDF fica no Storage com o seu usuário e o e-mail vai com o anexo pra análise.
        Quando o catálogo for importado (CSV / produtos locais), você compara custo com o MeLi.</p>
    </div>
    <div class="fcard">
      <h3>Depois: dados de mercado</h3>
      <p>Com o produto já em Produtos locais (e vínculo de catálogo MeLi quando houver),
        você vê preço e concorrência reais — sem inventar receita ou vendas do PDF.</p>
    </div>
  </div>`;
};

async function carregarCatalogos(){
  const { data, error } = await sb.rpc('listar_meus_catalogos', { p_limite: 50 });
  if (error) { S.catalogosMsg = { ok:false, t: error.message }; S.catalogos = []; }
  else S.catalogos = data ?? [];
  S.catalogosLoaded = true;
}

async function enviarCatalogos(files){
  const pdfs = [...files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) {
    S.catalogosMsg = { ok:false, t:'Só aceitamos PDF.' }; render(); return;
  }
  const big = pdfs.find(f => f.size > 20 * 1024 * 1024);
  if (big) {
    S.catalogosMsg = { ok:false, t:`${big.name} passa de 20 MB.` }; render(); return;
  }
  const { data: sess } = await sb.auth.getSession();
  const user = sess?.session?.user;
  if (!user) { S.catalogosMsg = { ok:false, t:'Faça login de novo.' }; render(); return; }

  const forn = ($('#cat_forn')?.value || '').trim() || null;
  const notas = ($('#cat_notas')?.value || '').trim() || null;
  S.catalogosBusy = true; S.catalogosMsg = null; render();
  let okN = 0, failN = 0, emailOk = 0;

  for (const file of pdfs) {
    const path = `${user.id}/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await sb.storage.from('catalogos').upload(path, file, {
      contentType: 'application/pdf', upsert: false,
    });
    if (upErr) { failN++; continue; }

    const { data: row, error: insErr } = await sb.from('supplier_catalogs').insert({
      user_id: user.id,
      nome_arquivo: file.name,
      storage_path: path,
      tamanho_bytes: file.size,
      mime: 'application/pdf',
      fornecedor_nome: forn,
      notas,
    }).select('id').single();
    if (insErr || !row) { failN++; continue; }

    const { data: mail, error: mailErr } = await sb.functions.invoke('enviar-catalogo', {
      body: { catalog_id: row.id },
    });
    okN++;
    if (!mailErr && mail?.email_enviado) emailOk++;
  }

  S.catalogosBusy = false;
  await carregarCatalogos();
  if (failN && !okN) S.catalogosMsg = { ok:false, t:`Falha ao enviar ${failN} arquivo(s).` };
  else if (okN) S.catalogosMsg = {
    ok: true,
    t: emailOk === okN
      ? `${okN} catálogo(s) salvos e enviados por e-mail.`
      : `${okN} catálogo(s) salvos.${emailOk?` ${emailOk} com e-mail.`:' E-mail ainda não disparou — o arquivo ficou guardado.'}${failN?` ${failN} falhou(aram).`:''}`,
  };
  render();
}

function wireCatalogos(){
  const drop = $('#cat_drop');
  const file = $('#cat_file');
  if (!drop || !file) return;
  if ($('#cat_pick')) $('#cat_pick').onclick = () => file.click();
  file.onchange = () => { if (file.files?.length) enviarCatalogos(file.files); file.value = ''; };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('on'); };
  drop.ondragleave = () => drop.classList.remove('on');
  drop.ondrop = e => {
    e.preventDefault(); drop.classList.remove('on');
    if (e.dataTransfer?.files?.length) enviarCatalogos(e.dataTransfer.files);
  };
}

V.monitor = () => {
  const novos = S.alertas.filter(a=>!a.lido).length;
  return `<h1 class="pg">Monitor</h1>
  <p class="sub">Produtos que você acompanha. Os alertas são gerados depois de cada coleta — mesmo que você não abra o app.</p>
  <div class="tabs">
    <button class="tb ${S.aba==='lista'?'on':''}" data-ab="lista">Acompanhando (${S.monitorados.length})</button>
    <button class="tb ${S.aba==='fila'?'on':''}" data-ab="fila">Aguardando coleta (${S.pedidos.filter(p=>p.status==='pendente').length})</button>
    <button class="tb ${S.aba==='alertas'?'on':''}" data-ab="alertas">Alertas${novos?` <span class="badge">${novos}</span>`:''}</button>
    <button class="tb ${S.aba==='vendedores'?'on':''}" data-ab="vendedores">Vendedores (${S.vendedores.length})</button>
    ${S.aba==='alertas'&&novos?'<button class="btn g" id="lidos" style="margin-left:auto">Marcar como lidos</button>':''}
  </div>
  <div class="card" id="mres">${S.aba==='lista'?tmon():S.aba==='fila'?tfila():S.aba==='vendedores'?tvend():talert()}</div>
  <div class="tip"><b>O que dispara alerta.</b> Mudança de posição, top 10, preço mediano, concorrentes —
    e também mudança de <b>vendidos</b> quando a extensão lê de novo a página do anúncio.
    Clique em <b>Ver dados do alerta</b> para ver antes → depois. No máximo um aviso por tipo por dia.</div>`;
};

function tfila(){
  if (!S.pedidos.length) return `<div class="none"><b>Nenhum pedido de coleta</b>
    Abra um produto fora da cobertura no Mercado Livre, pela extensao, e clique em Pedir coleta.</div>`;
  const rot = { pendente:['Na fila','u'], atendido:['Coletado','u'],
    sem_item:['Fora do alcance da coleta','d'], sem_destaque:['Sem ranking publico','d'] };
  return `<table><thead><tr><th>Produto</th><th class="n">Preco</th><th class="n">Vendidos</th>
    <th class="n">Receita acumulada</th><th>Categoria</th><th class="n">Pedidos</th>
    <th>Situacao</th><th class="n">Pedido em</th><th></th></tr></thead><tbody>${
    S.pedidos.map(p=>{
      const r = rot[p.status] || [p.status,'f'];
      // Foto do dia do pedido, lida da pagina do ML pela extensao. Nao e
      // dado vivo: por isso a data aparece junto e some quando a coleta atende.
      const f = p.snapshot || {};
      const receita = (f.vendidos != null && f.preco != null) ? f.vendidos * f.preco : null;
      return `<tr class="k" data-p="${p.produto?esc(p.produto):''}" data-url="${p.url?esc(p.url):''}">
      <td style="max-width:320px"><div style="display:flex;gap:10px;align-items:center">
        ${f.imagem?`<img src="${esc(f.imagem)}" alt="" width="44" height="44"
           style="border-radius:6px;object-fit:cover;flex:none;background:#f2f2f5">`:''}
        <div style="min-width:0">
          <div class="nm">${esc(f.titulo || p.mlb)}</div>
          <div class="sb">${esc(p.mlb)}${f.vendedor?' · '+esc(f.vendedor):''}
          ${p.url?` · <a href="${esc(p.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">ver no ML</a>`:''}</div>
        </div></div></td>
      <td class="n">${f.preco!=null?brl(f.preco):'—'}</td>
      <td class="n">${f.vendidos!=null?(f.aprox?'~':'')+num(f.vendidos):'—'}</td>
      <td class="n">${receita!=null?brl(receita):'—'}</td>
      <td>${esc(p.categoria ?? p.category_id ?? '—')}</td>
      <td class="n">${p.pedidos ?? 1}</td>
      <td><span class="mv ${r[1]}">${r[0]}</span></td>
      <td class="n">${p.criado_em ? new Date(p.criado_em).toLocaleDateString('pt-BR') : '—'}</td>
      <td class="n"><div style="display:flex;gap:6px;justify-content:flex-end">
        ${p.produto?`<button class="btn mini" data-seg="${esc(p.produto)}">Monitorar</button>`:''}
        <button class="btn g mini" data-rmped="${esc(p.mlb)}" title="Remover da fila">Remover</button>
      </div></td>
    </tr>`;}).join('')}</tbody></table>
  <div class="tip"><b>Preco, vendidos e receita sao a leitura da pagina no dia do pedido</b> —
    o Mercado Livre arredonda o numero de vendidos, entao use como ordem de grandeza. A receita e ACUMULADA desde que o anuncio existe, nao mensal — o ML nao publica a data de criacao, entao nao da para dividir pelo tempo. Posicao no
    ranking e concorrentes so aparecem depois da coleta.<br><br>
    <b>Como funciona.</b> A coleta roda uma vez por dia e atende primeiro o que mais
    gente pediu. Categoria sem ranking publico do Mercado Livre fica marcada como tal e nao e
    tentada de novo — cerca de 63% das categorias estao nessa situacao.<br><br>
    <b>"Fora do alcance da coleta"</b> só aparece quando a busca no catálogo do Mercado Livre
    também não achou o produto (pelo título da página). Antes esse rótulo saía cedo demais —
    a API de anúncio (<code>/items</code>) é bloqueada pra terceiro, mas a de catálogo funciona
    e a coleta agora usa ela. Pedidos antigos foram recolocados na fila pra reprocessar.</div>`;
}
function tmon(){
  if (!S.monitorados.length) return `<div class="none"><b>Nada sendo acompanhado</b>
    Abra um produto na busca e clique em Monitorar.</div>`;
  return `<table><thead><tr>
    <th>Produto</th>
    <th>Tendência (21d)</th>
    <th class="n">Posição</th>
    <th class="n">Preço</th>
    <th class="n">Vendidos</th>
    <th class="n">Concorrentes</th>
    <th class="n">Alertas</th>
    <th></th>
  </tr></thead><tbody>${
    S.monitorados.map(m=>{
      const f = m.snapshot || {};
      const vendidos = m.vendidos ?? f.vendidos ?? null;
      const aprox = m.vendidos_aprox ?? f.aprox;
      const precoSnap = m.vendidos_preco ?? f.preco ?? null;
      const receita = (vendidos != null && precoSnap != null) ? vendidos * precoSnap : null;
      const deltaV = m.delta_vendidos;
      const lidoEm = m.vendas_lido_em || f.lido_em;
      const lidoTxt = lidoEm ? new Date(lidoEm).toLocaleDateString('pt-BR') : null;
      const delta = m.delta_desde_inicio;
      const deltaHtml = delta == null ? '<span class="mv f">—</span>'
        : `<span class="mv ${delta>0?'u':delta<0?'d':'f'}">${
            delta>0?'▲ +':delta<0?'▼ ':''}${delta===0?'—':Math.abs(delta)}</span>`;
      const varP = m.variacao_preco;
      const varHtml = varP == null ? '—'
        : `<span class="mv ${varP<0?'u':varP>0?'d':'f'}">${varP>0?'+':''}${pct(varP)}</span>`;
      const deltaVHtml = deltaV == null ? ''
        : `<div class="sb" style="margin-top:3px"><span class="mv ${deltaV>0?'u':deltaV<0?'d':'f'}">${
            deltaV>0?'▲ +':deltaV<0?'▼ ':''}${deltaV===0?'—':num(Math.abs(deltaV))}</span> vs leitura anterior</div>`;
      return `<tr class="k" data-p="${esc(m.product_id)}">
      <td style="width:260px;max-width:280px"><div style="display:flex;gap:10px;align-items:center">
        ${(m.imagem||f.imagem)?`<img src="${esc(m.imagem||f.imagem)}" alt="" width="40" height="40"
          style="border-radius:6px;object-fit:cover;flex:none;background:var(--bg-2)">`:`<span class="thumb" style="width:40px;height:40px;flex:none"></span>`}
        <div style="min-width:0;flex:1">
          <div class="nm" title="${esc(m.nome ?? m.product_id)}"
            style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13.5px">${esc(m.nome ?? m.product_id)}</div>
          <div class="sb" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.categoria ?? '')}</div>
          ${receita!=null?`<div class="mon-meta"><span>Receita acum. <b>${brl(receita)}</b></span></div>`:''}
        </div></div></td>
      <td>${sparkMini(S.histMon[m.product_id]||[])}</td>
      <td class="n">
        <span class="pos">${m.pos_atual ?? '—'}</span>
        <div class="sb" style="margin-top:4px">${deltaHtml} · entrou em ${m.pos_inicial ?? '—'}º</div>
      </td>
      <td class="n">
        <div style="font-weight:500">${brl(m.preco_atual)}</div>
        <div class="sb" style="margin-top:4px">${varHtml}</div>
      </td>
      <td class="n">
        ${vendidos!=null
          ? `<div style="font-weight:500">${aprox?'~':''}${num(vendidos)}</div>
             ${deltaVHtml}
             <div class="sb" style="margin-top:3px">${lidoTxt?`lido ${lidoTxt}`:'abra no ML c/ extensão'}</div>`
          : `<span class="sb">—</span><div class="sb">abra no ML c/ extensão</div>`}
      </td>
      <td class="n">${num(m.concorrentes)}</td>
      <td class="n">${m.alertas_novos>0?`<span class="chip p">${m.alertas_novos}</span>`:'—'}</td>
      <td class="n"><button class="btn g mini" data-rm="${esc(m.product_id)}">Remover</button></td>
    </tr>`;}).join('')}</tbody></table>
  <div class="tip"><b>O que atualiza sozinho todo dia (~03:10).</b>
    Posição no ranking, preço mediano e concorrentes — vêm da coleta da API.
    <b>Vendidos</b> o Mercado Livre não entrega pra terceiro pela API: só atualizam quando você
    abre o anúncio com a extensão Gringa Radar instalada (grava histórico e alerta se mudou).
    O ML arredonda “+100 vendidos”; use como ordem de grandeza. Receita = vendidos × preço daquela leitura (acumulada, não mensal).</div>`;
}

function tvend(){
  const buscaBox = `<div class="card cbox" style="margin-bottom:12px">
    <div style="display:flex;gap:8px">
      <input id="v_busca" placeholder="nome do vendedor (ex: NORTINOX)" value="${esc(S.vendBusca)}">
      <button class="btn" id="v_ir" ${S.vendBuscando?'disabled':''}>${S.vendBuscando?'...':'Buscar'}</button>
    </div>
    ${S.vendResultado.length ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
      ${S.vendResultado.map(r => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
        <div style="flex:1;min-width:0"><div class="nm" style="font-size:13.5px">${esc(r.nickname ?? r.id)}
          ${r.is_official_store?' <span class="chip p">Loja oficial</span>':''}</div>
          <div class="sb" style="margin:3px 0">${esc([r.city,r.state].filter(Boolean).join(' · ') || '—')} · ${num(r.anuncios_vistos)} anúncio(s) na nossa base</div>
          <div>${sellerBits(r)}</div></div>
        <button class="btn mini" data-vadd="${r.id}">Acompanhar</button>
      </div>`).join('')}
    </div>` : (S.vendBusca.trim().length>=2 && !S.vendBuscando ? '<div class="sb" style="margin-top:8px">Nada encontrado com esse nome.</div>' : '')}
  </div>`;

  if (!S.vendedores.length) return buscaBox + `<div class="none"><b>Ainda não há nada aqui</b>
    Busque um vendedor acima pra começar a acompanhar.</div>`;

  return buscaBox + `<table><thead><tr><th>Vendedor</th><th>Cidade/UF</th><th></th></tr></thead><tbody>${
    S.vendedores.map(v => { const s = v.sellers || {}; return `<tr>
      <td><div class="nm">${esc(s.nickname ?? v.seller_id)}${s.is_official_store?' <span class="chip p">Loja oficial</span>':''}</div>
        ${s.permalink?`<div class="sb"><a href="${esc(s.permalink)}" target="_blank" rel="noopener">ver perfil no ML</a></div>`:''}</td>
      <td>${esc([s.city,s.state].filter(Boolean).join(' · ') || '—')}</td>
      <td class="n"><button class="btn g mini" data-vrm="${v.seller_id}">Remover</button></td>
    </tr>`; }).join('')}</tbody></table>
    <div class="hint" style="margin-top:10px">Ao buscar, a reputação e a medalha vêm do último snapshot coletado via API do ML.
      Seguidores o Mercado Livre não publica na API — não inventamos esse número.</div>`;
}

function chaveAlerta(a, i){
  return String(a?.id ?? '') + '|' + String(a?.product_id ?? '') + '|' + String(a?.tipo ?? '') + '|' + String(a?.dia ?? '') + '|' + i;
}

function talert(){
  if (!S.alertas.length) return `<div class="none"><b>Nenhum alerta ainda</b>
    Eles aparecem a partir da segunda coleta, quando houver o que comparar.</div>`;
  const cor = t => t==='entrou_top10'||t==='subiu'||t==='preco_caiu' ? 'g'
                 : t==='saiu_top10'||t==='caiu'||t==='preco_subiu' ? 'r' : 'p';
  return `<div class="feed">${S.alertas.map((a,i)=>{
    const key = chaveAlerta(a, i);
    const aberto = S.alertaAberto === key;
    const tipoRot = TIPO_ALERTA[a.tipo] || a.tipo || 'Alerta';
    return `
    <div class="al ${a.lido?'':'novo'}" style="cursor:default;flex-wrap:wrap;align-items:flex-start">
      <span class="dt ${cor(a.tipo)}" style="margin-top:8px"></span>
      <div style="flex:1;min-width:180px">
        <div class="nm">${esc(a.titulo)}</div>
        <div class="sb">${esc(a.nome ?? a.product_id)}${a.detalhe?' · '+esc(a.detalhe):''}</div>
        <div class="sb" style="margin-top:2px">${esc(fmtDiaChart(a.dia))}</div>
      </div>
      <div style="display:flex;gap:8px;flex:none;flex-wrap:wrap">
        <button type="button" class="btn ${aberto?'':'g'} mini" data-aexp="${esc(key)}">${aberto?'Ocultar detalhes':'Ver dados do alerta'}</button>
        ${a.product_id?`<button type="button" class="btn mini" data-aficha="${esc(a.product_id)}">Ver ficha</button>`:''}
      </div>
      ${aberto?`<div class="al-panel">
        <div class="ct">${esc(tipoRot)}</div>
        ${a.detalhe?`<p style="margin:0 0 10px;color:var(--ink-2);font-size:13.5px">${esc(a.detalhe)}</p>`:''}
        <div class="al-delta" style="margin:0">
          <div class="lado"><div class="k">Antes</div><div class="v">${fmtValorAlerta(a.tipo, a.antes)}</div></div>
          <div class="seta" aria-hidden="true">→</div>
          <div class="lado"><div class="k">Depois</div>
            <div class="v" style="color:${cor(a.tipo)==='g'?'var(--up)':cor(a.tipo)==='r'?'var(--dn)':'var(--brand)'}">${fmtValorAlerta(a.tipo, a.depois)}</div>
          </div>
        </div>
        <p class="sb" style="margin:12px 0 0">Gravado em ${esc(fmtDiaChart(a.dia))}
          ${a.product_id?' · '+esc(a.product_id):''}
          ${a.lido?' · lido':' · novo'}</p>
      </div>`:''}
    </div>`;
  }).join('')}</div>`;
}

const TIPO_ALERTA = {
  subiu: 'Subiu no ranking',
  caiu: 'Caiu no ranking',
  entrou_top10: 'Entrou no top 10',
  saiu_top10: 'Saiu do top 10',
  preco_subiu: 'Preço mediano subiu',
  preco_caiu: 'Preço mediano caiu',
  concorrencia: 'Mudança de concorrência',
  vendas_subiu: 'Vendidos subiu (página)',
  vendas_caiu: 'Vendidos caiu (página)',
};

function fmtValorAlerta(tipo, v){
  if (v == null || v === '') return '—';
  if (tipo === 'preco_subiu' || tipo === 'preco_caiu') return brl(v);
  if (tipo === 'concorrencia') return num(v) + ' anúncio(s)';
  if (tipo === 'vendas_subiu' || tipo === 'vendas_caiu') return num(v) + ' vendido(s)';
  return num(v) + 'º';
}

function marcarAlertaLido(a){
  if (!a || a.lido) return;
  a.lido = true;
  if (a.id != null) sb.from('product_alerts').update({ lido: true }).eq('id', a.id).then(() => {});
}

function abrirAlertaPorChave(key){
  S.alertaAberto = S.alertaAberto === key ? null : key;
  if (S.alertaAberto) {
    const i = S.alertas.findIndex((a, idx) => chaveAlerta(a, idx) === key);
    if (i >= 0) marcarAlertaLido(S.alertas[i]);
  }
  S.view = 'monitor';
  S.aba = 'alertas';
  render();
}

V.alerta = () => {
  // Mantido por compatibilidade; o fluxo principal expande na lista.
  const a = S.alertaFoco;
  if (!a) {
    S.view = 'monitor'; S.aba = 'alertas';
    return V.monitor();
  }
  const key = chaveAlerta(a, Math.max(0, S.alertas.indexOf(a)));
  S.alertaAberto = key;
  S.view = 'monitor'; S.aba = 'alertas';
  return V.monitor();
};

async function abrirAlerta(id){
  const i = S.alertas.findIndex(x => String(x.id) === String(id));
  if (i < 0) return;
  abrirAlertaPorChave(chaveAlerta(S.alertas[i], i));
}

V.detalhe = () => {
  const d = S.detalhe; if (!d) return '<div class="none">Nada selecionado.</div>';
  const pri = d.historico[0], ult = d.historico[d.historico.length-1];
  const seguido = S.monitorados.some(m=>m.product_id===d.produto.product_id);
  return `<div style="display:flex;gap:8px;margin-bottom:14px">
    <button class="btn g" id="volta">← Voltar</button>
    <button class="btn ${seguido?'g':''}" id="mon">${seguido?'✓ Monitorando':'+ Monitorar'}</button>
  </div>
  <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:4px">
    ${d.produto.picture?`<img src="${esc(d.produto.picture)}" alt="" width="64" height="64" style="border-radius:10px;object-fit:cover;flex:none;background:#f2f2f5">`:''}
    <div>
      <h1 class="pg" style="margin-bottom:2px">${esc(d.produto.name ?? d.produto.product_id)}</h1>
      <p class="sub" style="margin:0">${esc(d.produto.category_name ?? '')} · ${esc(d.produto.product_id)}
        ${d.produto.brand?` · ${esc(d.produto.brand)}`:''}
        ${d.produto.permalink?` · <a href="${esc(d.produto.permalink)}" target="_blank" rel="noopener">ver no Mercado Livre</a>`:''}</p>
    </div>
  </div>
  ${S.detalheLocal?`<div class="card cbox" style="margin:14px 0;background:var(--tint)">
    <div class="ct">Custo do fornecedor local</div>
    <div class="v" style="font-size:20px;font-weight:700">${brl(S.detalheLocal.custo)}</div>
    ${S.detalheLocal.fornecedor?`<div class="sb">${esc(S.detalheLocal.fornecedor)}</div>`:''}
    ${(S.detalheLocal.custo!=null && d.produto.median_price>0)?`<div class="sb" style="margin-top:4px">
      Margem bruta estimada: <b>${pct((d.produto.median_price-S.detalheLocal.custo)/d.produto.median_price)}</b>
      (preço mediano do Mercado Livre − custo do fornecedor)</div>`:''}
  </div>
  ${S.detalheLocal.fornecedorId?(() => {
    const cont = S.contatos[S.detalheLocal.fornecedorId];
    return `<div class="card cbox" style="margin-bottom:14px">
      <div class="ct">Fornecedor local</div>
      <div style="font-weight:600;font-size:15px;margin:4px 0 8px">${esc(S.detalheLocal.fornecedor ?? '—')}</div>
      ${cont ? `<div class="ct2">
          ${cont.telefone?`<a href="tel:${esc(cont.telefone)}">☎ ${esc(cont.telefone)}</a>`:''}
          ${cont.email?`<a href="mailto:${esc(cont.email)}">✉ ${esc(cont.email)}</a>`:''}
          ${cont.site?`<a href="https://${esc(cont.site)}" target="_blank" rel="noopener">🌐 ${esc(cont.site)}</a>`:''}
          ${cont.instagram?`<span>◎ ${esc(cont.instagram)}</span>`:''}
        </div>
        <div class="aviso">Contatos vindos do catálogo do fornecedor. Não verificamos a conduta dele —
          confira antes de fechar pedido.</div>`
        : `<button class="lock" data-unl="${esc(S.detalheLocal.fornecedorId)}">🔒 Mostrar contatos</button>`}
    </div>`;
  })():''}`:''}
  <div class="g2">
    <div class="card"><div class="cbox">
      <div class="ct">Posição e preço — ${d.historico.length} dia(s). Linha roxa = posição (pra cima = subiu); linha verde = preço mediano.</div>
      ${spark2(d.historico)}
      ${pri?`<div class="sb" style="display:flex;justify-content:space-between;margin-top:8px">
        <span>${pri.dia}${pri.posicao!=null?' · '+pri.posicao+'º':''}${pri.preco!=null?' · '+brl(pri.preco):''}</span>
        <span>${ult.dia}${ult.posicao!=null?' · '+ult.posicao+'º':''}${ult.preco!=null?' · '+brl(ult.preco):''}</span></div>`:''}
      ${d.produto.position_now==null?`<div class="hint" style="margin-top:8px">Sem posição no ranking público — o Mercado Livre só publica o top 20 da categoria. Preço e concorrentes abaixo vêm da coleta de anúncios do catálogo.</div>`:''}
    </div></div>
    <div class="card">
      <div class="stat"><div class="k">Posição hoje</div><div class="v">${d.produto.position_now!=null?d.produto.position_now+'º':'—'}</div></div>
      <div class="stat"><div class="k">Melhor posição</div><div class="v">${d.produto.best_position!=null?d.produto.best_position+'º':'—'}</div></div>
      <div class="stat"><div class="k">Dias no top 10</div><div class="v">${d.produto.days_in_top10 ?? 0}/${d.produto.days_observed ?? 0}</div></div>
      <div class="stat"><div class="k">Preço mediano</div><div class="v">${brl(d.produto.median_price)}</div></div>
      <div class="stat"><div class="k">Faixa de preço (${num(d.produto.listings)} anúncio(s))</div>
        <div class="v" style="font-size:16px">${d.produto.min_price!=null?brl(d.produto.min_price)+' – '+brl(d.produto.max_price):'—'}</div></div>
    </div>
  </div>
  <div class="tabs" style="margin-top:18px">
    <button class="tb ${S.detalheAba==='catalogo'?'on':''}" data-dab="catalogo">Produtos do catálogo (${d.concorrentes.length})</button>
    <button class="tb ${S.detalheAba==='similares'?'on':''}" data-dab="similares">Produtos similares</button>
  </div>
  <div class="card">${S.detalheAba==='catalogo' ? (d.concorrentes.length?`<table><thead><tr>
    <th>Anúncio</th><th class="n">Preço</th><th>Vendedor</th><th>Reputação</th><th>Detalhes da listagem</th>
    </tr></thead><tbody>${d.concorrentes.map(c=>{
      const link = c.permalink || (c.nickname ? `https://perfil.mercadolivre.com.br/${encodeURIComponent(c.nickname)}` : null);
      const onde = [c.cidade, c.estado].filter(Boolean).join(' · ') || '—';
      return `<tr class="${link?'k':''}" ${link?`data-open="${esc(link)}"`:''}>
      <td class="sb">${esc(c.item_id)}</td>
      <td class="n" style="font-weight:500">${brl(c.preco)}</td>
      <td><div class="nm" style="font-size:13.5px">${link?`<a href="${esc(link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(c.nickname ?? c.seller_id)}</a>`:esc(c.nickname ?? c.seller_id ?? '—')}
        ${c.oficial?' <span class="chip g">Oficial</span>':''}</div>
        <div class="sb">${esc(onde)}</div></td>
      <td>${sellerBits(c)}</td>
      <td>${c.full?'<span class="chip y">Full</span>':'<span class="chip">Comum</span>'}
          ${c.frete_gratis?' <span class="chip">Frete grátis</span>':''}</td>
    </tr>`;}).join('')}</tbody></table>
    <div class="hint" style="margin-top:10px">Reputação, medalha e vendas históricas vêm do perfil público do vendedor no Mercado Livre
      (<code>/users/{id}</code>). Seguidores o ML não publica na API — por isso não aparecem aqui.</div>`
    :'<div class="none"><b>Sem concorrentes coletados</b>Rode <code>npm run collect produtos</code>.</div>')
  : (!S.similaresCarregado ? '<div class="load">carregando…</div>' : S.similares.length ? `<table><thead><tr>
    <th>Produto</th><th class="n">Posição</th><th class="n">Preço mediano</th><th class="n">Anúncios</th></tr></thead><tbody>${
    S.similares.map(sp=>`<tr class="k" data-p="${esc(sp.product_id)}">
      <td style="max-width:280px"><div style="display:flex;gap:10px;align-items:center">
        ${sp.picture?`<img src="${esc(sp.picture)}" width="36" height="36" style="border-radius:6px;object-fit:cover;flex:none;background:#f2f2f5">`:''}
        <div class="nm" style="font-size:13.5px">${esc(sp.name ?? sp.product_id)}</div></div></td>
      <td class="n"><span class="pos">${sp.position_now ?? '—'}</span></td>
      <td class="n">${brl(sp.median_price)}</td>
      <td class="n">${num(sp.listings)}</td>
    </tr>`).join('')}</tbody></table>`
    : '<div class="none"><b>Nada parecido rankeado ainda nessa categoria</b></div>')}</div>`;
};
function spark(v,w=560,h=110){
  if (!v.length) return '<div class="none">sem histórico ainda</div>';
  const mx=Math.max(...v), mn=Math.min(...v), rg=(mx-mn)||1;
  const p = v.map((x,i)=>[(i/Math.max(v.length-1,1))*w, ((x-mn)/rg)*(h-18)+9]);
  const d = p.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"
    role="img" aria-label="Histórico de ${v.length} dias">
    <path d="${d} L ${w} ${h} L 0 ${h} Z" fill="#7C3AED" opacity=".08"/>
    <path d="${d}" fill="none" stroke="#7C3AED" stroke-width="2.2" stroke-linejoin="round"/>
    ${p.map(q=>`<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="2.6" fill="#7C3AED"/>`).join('')}</svg>`;
}

/** Posição + preço juntos, eixos independentes. Aceita série só de um dos dois. */
function fmtDiaChart(d){
  if (d == null) return '—';
  const s = String(d).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  try { return new Date(d).toLocaleDateString('pt-BR'); } catch { return String(d); }
}
function spark2(hist,w=560,h=170){
  if (!hist.length) return '<div class="none">sem histórico ainda</div>';
  const temPos = hist.some(x=>x.posicao!=null);
  const temPreco = hist.some(x=>x.preco!=null);
  if (!temPos && !temPreco) return '<div class="none">sem histórico ainda</div>';
  const linha = (getY,cor,invertido,serie) => {
    const pts = hist.map((x,i)=>{
      const v = getY(x); if (v==null) return null;
      return [(i/Math.max(hist.length-1,1))*w, v, x];
    }).filter(Boolean);
    if (!pts.length) return { path:'', dots:'', hits:'' };
    const ys = pts.map(p=>p[1]);
    const mx=Math.max(...ys), mn=Math.min(...ys), rg=(mx-mn)||1;
    const py = y => invertido ? ((y-mn)/rg)*(h-30)+15 : (h-30) - ((y-mn)/rg)*(h-30) - 15;
    const path = pts.length===1 ? ''
      : `<path d="${pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+py(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="${cor}" stroke-width="2.2" stroke-linejoin="round"/>`;
    const dots = pts.map(p=>`<circle class="cht-dot" cx="${p[0].toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="4" fill="${cor}" stroke="var(--card)" stroke-width="1.5"/>`).join('');
    const hits = pts.map(p=>{
      const x = p[2];
      return `<circle class="cht-hit" cx="${p[0].toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="14" fill="transparent"
        data-dia="${esc(fmtDiaChart(x.dia))}" data-serie="${serie}"
        data-pos="${x.posicao!=null?x.posicao:''}" data-preco="${x.preco!=null?x.preco:''}"/>`;
    }).join('');
    return { path, dots, hits };
  };
  const Lpos = temPos ? linha(x=>x.posicao, '#7C3AED', true, 'pos') : { path:'', dots:'', hits:'' };
  const Lpre = temPreco ? linha(x=>x.preco, '#16A34A', false, 'preco') : { path:'', dots:'', hits:'' };
  return `<div class="cht">
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Histórico">
      ${Lpos.path}${Lpre.path}${Lpos.dots}${Lpre.dots}${Lpos.hits}${Lpre.hits}
    </svg>
    <div class="cht-tip" hidden></div>
  </div>
  <div style="display:flex;gap:16px;margin-top:6px;font-size:12px;color:var(--ink-3)">
    ${temPos?'<span>● posição</span>':''}
    ${temPreco?'<span style="color:var(--up)">● preço mediano</span>':''}
    <span style="margin-left:auto">passe o mouse nas bolinhas pra ver dia e valor</span>
  </div>`;
}

/** Mini-gráfico do Monitor: posição (roxa) + preço (verde). Aceita série só de preço. */
function sparkMini(hist,w=168,h=44){
  if (!hist.length) {
    return `<div class="spark-wrap"><div class="spark-empty">sem série ainda</div>
      <div class="spark-leg"><span><i style="background:var(--brand)"></i>posição</span>
      <span><i style="background:var(--up)"></i>preço</span></div></div>`;
  }
  const temPos = hist.some(x => x.posicao != null);
  const temPreco = hist.some(x => x.preco != null);
  if (!temPos && !temPreco) {
    return `<div class="spark-wrap"><div class="spark-empty">sem série ainda</div></div>`;
  }

  const linha = (getY, cor, invertido, label) => {
    const pts = hist.map((x, i) => {
      const v = getY(x); if (v == null) return null;
      return [(i / Math.max(hist.length - 1, 1)) * w, v, x];
    }).filter(Boolean);
    if (!pts.length) return '';
    const ys = pts.map(p => p[1]);
    const mx = Math.max(...ys), mn = Math.min(...ys), rg = (mx - mn) || 1;
    const py = y => invertido ? ((y - mn) / rg) * (h - 8) + 4
                              : (h - 4) - ((y - mn) / rg) * (h - 8);
    if (pts.length === 1) {
      const p = pts[0];
      const txt = label === 'pos' ? `${p[1]}º` : brl(p[1]);
      return `<circle cx="${p[0].toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="3" style="fill:${cor}">
        <title>${esc(p[2].dia)} · ${txt}</title></circle>`;
    }
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + py(p[1]).toFixed(1)).join(' ');
    const ult = pts[pts.length - 1];
    const pontos = pts.map(p => {
      const txt = label === 'pos' ? `${p[1]}º` : brl(p[1]);
      return `<circle cx="${p[0].toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="2" style="fill:${cor}">
        <title>${esc(p[2].dia)} · ${txt}</title></circle>`;
    }).join('');
    return `<path d="${d}" fill="none" style="stroke:${cor}" stroke-width="1.8" stroke-linejoin="round"/>
      ${pontos}
      <circle cx="${ult[0].toFixed(1)}" cy="${py(ult[1]).toFixed(1)}" r="2.8" style="fill:${cor}"/>`;
  };

  return `<div class="spark-wrap">
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" role="img" aria-label="Tendência 21 dias">
      ${temPos ? linha(x => x.posicao, 'var(--brand)', true, 'pos') : ''}
      ${temPreco ? linha(x => x.preco, 'var(--up)', false, 'preco') : ''}
    </svg>
    <div class="spark-leg">
      ${temPos ? '<span><i style="background:var(--brand)"></i>posição</span>' : ''}
      ${temPreco ? '<span><i style="background:var(--up)"></i>preço</span>' : ''}
      ${!temPos && temPreco ? '<span>fora do top 20</span>' : ''}
    </div>
  </div>`;
}

/** Mesmo desenho do spark2, mas pra série de categoria: produtos no top + preço mediano do dia. */
function sparkCategoria(hist,w=560,h=170){
  if (hist.length<2) return '<div class="none">sem histórico ainda — volte depois de alguns dias de coleta</div>';
  const linha = (getY,cor,serie) => {
    const pts = hist.map((x,i)=>{
      const v = getY(x); if (v==null) return null;
      return [(i/Math.max(hist.length-1,1))*w, v, x];
    }).filter(Boolean);
    if (pts.length<2) return { path:'', dots:'', hits:'' };
    const ys = pts.map(p=>p[1]);
    const mx=Math.max(...ys), mn=Math.min(...ys), rg=(mx-mn)||1;
    const py = y => (h-30) - ((y-mn)/rg)*(h-30) - 15;
    const path = `<path d="${pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+py(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="${cor}" stroke-width="2.2" stroke-linejoin="round"/>`;
    const dots = pts.map(p=>`<circle class="cht-dot" cx="${p[0].toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="4" fill="${cor}" stroke="var(--card)" stroke-width="1.5"/>`).join('');
    const hits = pts.map(p=>{
      const x = p[2];
      return `<circle class="cht-hit" cx="${p[0].toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="14" fill="transparent"
        data-dia="${esc(fmtDiaChart(x.dia))}" data-serie="${serie}"
        data-produtos="${x.produtos_no_top!=null?x.produtos_no_top:''}"
        data-preco="${x.preco_mediano!=null?x.preco_mediano:''}"/>`;
    }).join('');
    return { path, dots, hits };
  };
  const La = linha(x=>x.produtos_no_top, '#7C3AED', 'prod');
  const Lb = linha(x=>x.preco_mediano, '#16A34A', 'preco');
  return `<div class="cht">
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Histórico da categoria">
      ${La.path}${Lb.path}${La.dots}${Lb.dots}${La.hits}${Lb.hits}
    </svg>
    <div class="cht-tip" hidden></div>
  </div>
  <div style="display:flex;gap:16px;margin-top:6px;font-size:12px;color:var(--ink-3)">
    <span>● produtos no top 20</span><span style="color:var(--up)">● preço mediano</span>
    <span style="margin-left:auto">passe o mouse nas bolinhas pra ver dia e valor</span>
  </div>`;
}

function wireChartTips(){
  document.querySelectorAll('.cht').forEach(wrap => {
    const tip = wrap.querySelector('.cht-tip');
    if (!tip) return;
    const move = (e) => {
      const r = wrap.getBoundingClientRect();
      let left = e.clientX - r.left + 14;
      let top = e.clientY - r.top - 8;
      tip.hidden = false;
      // Evita sair pela direita / cima
      const tw = tip.offsetWidth || 160, th = tip.offsetHeight || 50;
      if (left + tw > r.width - 4) left = Math.max(4, r.width - tw - 4);
      if (top - th < 4) top = e.clientY - r.top + th + 16;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    };
    wrap.querySelectorAll('.cht-hit').forEach(el => {
      el.onmouseenter = (e) => {
        const dia = el.dataset.dia || '—';
        const lines = [`<b>${esc(dia)}</b>`];
        if (el.dataset.pos !== undefined && el.dataset.pos !== '')
          lines.push(`<span>Posição: <b style="display:inline">${esc(el.dataset.pos)}º</b></span>`);
        if (el.dataset.produtos !== undefined && el.dataset.produtos !== '')
          lines.push(`<span>Produtos no top: <b style="display:inline">${esc(el.dataset.produtos)}</b></span>`);
        if (el.dataset.preco !== undefined && el.dataset.preco !== '')
          lines.push(`<span>Preço mediano: <b style="display:inline">${brl(Number(el.dataset.preco))}</b></span>`);
        if (lines.length === 1) lines.push('<span>Sem valor neste ponto</span>');
        tip.innerHTML = lines.join('');
        move(e);
      };
      el.onmousemove = move;
      el.onmouseleave = () => { tip.hidden = true; };
    });
  });
}

// Anexo I do Simples Nacional (comércio) — faixas oficiais, estáveis desde a
// LC 155/2016. Alíquota efetiva = ((RBT12 × alíquota nominal) − parcela a
// deduzir) / RBT12. É a única tabela de custo aqui calculada por fórmula:
// comissão do ML e tabela de frete variam por categoria/reputação de um jeito
// que muda sem aviso e sem fonte pública confiável pra travar em código —
// por isso ficam editáveis, com valor inicial só como ponto de partida.
const SIMPLES_ANEXO1 = [
  { ate: 180000,   aliq: .04,  pd: 0 },
  { ate: 360000,   aliq: .073, pd: 5940 },
  { ate: 720000,   aliq: .095, pd: 13860 },
  { ate: 1800000,  aliq: .107, pd: 22500 },
  { ate: 3600000,  aliq: .143, pd: 87300 },
  { ate: 4800000,  aliq: .19,  pd: 378000 },
];
function aliquotaSimples(rbt12){
  const r = Math.max(0, rbt12 || 0);
  const faixa = SIMPLES_ANEXO1.find(f => r <= f.ate) ?? SIMPLES_ANEXO1[SIMPLES_ANEXO1.length - 1];
  if (r <= 0) return faixa.aliq * 100;
  return Math.max(0, ((r * faixa.aliq) - faixa.pd) / r) * 100;
}

const COMISSAO_PADRAO = { classico: 12, premium: 17 };

function presetsCalc(){
  try { return JSON.parse(localStorage.getItem('gr_calc_presets') || '[]'); }
  catch { return []; }
}

V.calc = () => {
  const presets = presetsCalc();
  return `<h1 class="pg">Calculadora de margem</h1>
  <p class="sub">O número que decide a compra. Comissão, frete e imposto saem antes do lucro.</p>
  ${presets.length ? `<div class="presets">${presets.map((p,i)=>
    `<span class="preset"><button data-loadp="${i}" style="opacity:1;color:inherit">${esc(p.nome)}</button>
     <button data-delp="${i}">×</button></span>`).join('')}</div>` : ''}
  <div class="g2">
    <div>
      <div class="card cbox">
        <div class="ct">Produto</div>
        <div class="cfld" style="margin-bottom:10px">
          <label>Link ou código do produto <i>(opcional — puxa o preço mediano da nossa base)</i></label>
          <div style="display:flex;gap:8px">
            <input id="pc_link" placeholder="cole o link do Mercado Livre ou o MLB">
            <button class="btn" id="pc_aplicar" style="flex:none">Aplicar</button>
          </div>
        </div>
        <div class="crow">
          <div class="cfld"><label>Preço de venda, R$ *</label><input type="number" id="pc_venda" value="199.90" step="0.01"></div>
          <div class="cfld"><label>Preço de compra, R$ *</label><input type="number" id="pc_compra" value="70.00" step="0.01"></div>
        </div>
        <div class="cfld"><label>Vendas por mês</label><input type="number" id="pc_vendas" value="1" min="0" step="1"></div>
      </div>

      <details class="csec" open>
        <summary>Comissões <span class="sub2" id="pc_com_resumo"></span></summary>
        <div class="cbody">
          <div class="cattag">
            <span style="font-size:13px;color:var(--ink-2)">Categorias:</span>
            ${S.calcCats.map((c,i)=>`<span class="preset">${esc(c)}<button data-catdel="${i}">×</button></span>`).join('')}
            <input id="pc_cat_add" placeholder="ex: Eletrônicos (só anotação — não muda a %)">
            <button class="btn" id="pc_cat_addbtn" style="padding:6px 12px;font-size:12.5px">Add</button>
          </div>
          <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:5px">Tipo de anúncio</label>
          <div class="radios">
            <label><input type="radio" name="pc_tipo" value="classico" checked>Clássico</label>
            <label><input type="radio" name="pc_tipo" value="premium">Premium</label>
          </div>
          <div class="crow">
            <div class="cfld"><label>Comissão, %</label>
              <input type="number" id="pc_comissao" value="${COMISSAO_PADRAO.classico}" step="0.1"></div>
            <div class="cfld"><label>Comissão em R$</label><div class="roval" id="pc_comissao_rs">R$ 0,00</div></div>
          </div>
          <div class="hint">É aplicada uma média de comissão (11%–19% conforme categoria) — confira o valor exato na Central do Vendedor.</div>
          <div class="cfld chk" style="padding-top:10px">
            <input type="checkbox" id="pc_taxafixa" checked>
            <label for="pc_taxafixa" style="font-size:12.5px">Cobrar taxa fixa em vendas abaixo de R$79 (<input type="number" id="pc_taxafixa_v" value="6.50" step="0.01" style="width:60px;padding:3px 5px;border:1px solid var(--line);border-radius:6px">)</label>
          </div>
        </div>
      </details>

      <details class="csec">
        <summary>Envio <span class="sub2" id="pc_env_resumo"></span></summary>
        <div class="cbody">
          <div class="cfld" style="margin-bottom:10px"><label>Reputação do vendedor</label>
            <select id="pc_reput"><option value="verde">Verde / MercadoLíder</option><option value="amarelo">Amarela</option><option value="vermelho">Vermelha</option><option value="nova">Sem reputação</option></select></div>
          <div class="crow3">
            <div class="cfld"><label>Peso, kg</label><input type="number" id="pc_peso" value="0.5" step="0.01"></div>
            <div class="cfld"><label>Altura, cm</label><input type="number" id="pc_altura" step="0.1" placeholder="—"></div>
            <div class="cfld"><label>Largura, cm</label><input type="number" id="pc_largura" step="0.1" placeholder="—"></div>
            <div class="cfld"><label>Comprimento, cm</label><input type="number" id="pc_comprimento" step="0.1" placeholder="—"></div>
          </div>
          <div class="hint" id="pc_cubagem_hint" style="margin:-4px 0 10px"></div>
          <label style="display:block;font-size:12.5px;font-weight:500;color:var(--ink-2);margin-bottom:5px">Frete grátis</label>
          <div class="radios">
            <label><input type="radio" name="pc_gratis" value="sim" checked>Sim</label>
            <label><input type="radio" name="pc_gratis" value="nao">Não</label>
          </div>
          <div class="cfld" style="margin-top:6px"><label>Custo de envio pra mim, R$</label>
            <input type="number" id="pc_frete" value="0" step="0.01"></div>
          <div class="hint">Preço aproximado pra você bancar o frete grátis — confira no simulador de frete do Mercado Livre, a tabela deles varia por peso, preço e reputação.</div>
        </div>
      </details>

      <details class="csec">
        <summary>Impostos <span class="sub2" id="pc_imp_resumo"></span></summary>
        <div class="cbody">
          <div class="cfld" style="margin-bottom:10px"><label>Regime fiscal</label>
            <select id="pc_regime">
              <option value="simples">Simples Nacional</option>
              <option value="mei">MEI</option>
              <option value="presumido">Lucro Presumido</option>
              <option value="nenhum">Nenhum / pessoa física</option>
            </select></div>
          <div class="crow" id="pc_receita_wrap">
            <div class="cfld"><label>Receita bruta anual (faixa)</label>
              <select id="pc_faixa">
                <option value="180000">Até R$ 180.000,00</option>
                <option value="360000">R$ 180.000,01 – R$ 360.000,00</option>
                <option value="720000">R$ 360.000,01 – R$ 720.000,00</option>
                <option value="1800000">R$ 720.000,01 – R$ 1.800.000,00</option>
                <option value="3600000">R$ 1.800.000,01 – R$ 3.600.000,00</option>
                <option value="4800000">R$ 3.600.000,01 – R$ 4.800.000,00</option>
              </select></div>
            <div class="cfld"><label>Receita bruta, últimos 12 meses, R$</label>
              <input type="number" id="pc_receita" value="120000" step="1000"></div>
          </div>
          <div class="cfld"><label>Impostos, % <i>(Simples calcula sozinho pelo Anexo I; outros regimes, digite)</i></label>
            <input type="number" id="pc_imposto" value="4" step="0.1"></div>
        </div>
      </details>

      <details class="csec">
        <summary>Custo adicional <span class="sub2" id="pc_extra_resumo"></span></summary>
        <div class="cbody">
          <div class="cfld"><label>Embalagem, ADS, outros — por unidade, R$</label>
            <input type="number" id="pc_extra" value="0" step="0.01"></div>
        </div>
      </details>

      <div style="display:flex;gap:10px;margin-top:4px">
        <button class="btn" id="pc_calc">Calcular</button>
        <button class="btn" id="pc_limpar" style="background:var(--card);color:var(--ink-2);border:1px solid var(--line)">Limpar</button>
        <button class="btn" id="pc_salvar" style="background:var(--card);color:var(--brand-2);border:1px solid var(--soft)">Salvar como predefinição</button>
      </div>
    </div>
    <div class="card cbox" id="kout" style="align-self:flex-start;position:sticky;top:16px"></div>
  </div>
  <div class="tip"><b>Comissão e frete são pontos de partida, não a tabela oficial.</b> O Mercado Livre
    varia comissão por categoria (11%–19%) e o custo de frete grátis por mais de 250 combinações de peso,
    preço e reputação — confira o valor exato na Central do Vendedor antes de decidir. Só o imposto do
    Simples Nacional é calculado pela tabela oficial (Anexo I).</div>`;
};

function calc(){
  const g = id => parseFloat(document.getElementById(id)?.value) || 0;
  const gi = id => document.getElementById(id)?.value;
  const checked = id => !!document.getElementById(id)?.checked;
  const radio = (name, fallback) => document.querySelector(`input[name=${name}]:checked`)?.value ?? fallback;

  const venda = g('pc_venda'), compra = g('pc_compra'), qtd = Math.max(0, g('pc_vendas'));
  const tipo = radio('pc_tipo', 'classico');
  let comissaoPct = g('pc_comissao');
  const taxaFixa = checked('pc_taxafixa') && venda > 0 && venda < 79 ? g('pc_taxafixa_v') : 0;

  const gratis = radio('pc_gratis', 'sim') === 'sim';
  const freteUn = gratis ? g('pc_frete') : 0;

  const regime = gi('pc_regime') || 'nenhum';
  let impostoPct = g('pc_imposto');
  if (regime === 'simples') impostoPct = aliquotaSimples(g('pc_receita'));

  const extra = g('pc_extra');

  const comissaoR = venda * comissaoPct / 100;
  const impostoR = venda * impostoPct / 100;
  const despesas = compra + comissaoR + taxaFixa + freteUn + impostoR + extra;
  const receitaBruta = venda;
  const lucro = receitaBruta - despesas;
  const margemLiquida = venda ? lucro / venda : null;
  const margemBruta = venda ? (venda - compra) / venda : null;

  // resumos nas abas fechadas, pra não precisar abrir tudo pra conferir
  const rc = $('#pc_com_resumo'); if (rc) rc.textContent = `${comissaoPct}%${taxaFixa?' + taxa fixa':''}`;
  const re = $('#pc_env_resumo'); if (re) re.textContent = gratis ? brl(freteUn) : 'frete pago pelo comprador';
  const ri = $('#pc_imp_resumo'); if (ri) ri.textContent = `${impostoPct.toFixed(2)}%`;
  const rx = $('#pc_extra_resumo'); if (rx) rx.textContent = extra ? brl(extra) : 'nenhum';
  const rvR = $('#pc_comissao_rs'); if (rvR) rvR.textContent = brl(comissaoR);
  const wrapReceita = $('#pc_receita_wrap'); if (wrapReceita) wrapReceita.style.display = regime === 'simples' ? '' : 'none';

  // peso cúbico: fórmula padrão de transportadoras (A×L×C em cm ÷ 6000 = kg).
  // Informativo — não muda o custo de envio, que continua editável.
  const cub = $('#pc_cubagem_hint');
  if (cub) {
    const alt = g('pc_altura'), larg = g('pc_largura'), comp = g('pc_comprimento'), peso = g('pc_peso');
    if (alt && larg && comp) {
      const pesoCubico = (alt * larg * comp) / 6000;
      const considerado = Math.max(peso, pesoCubico);
      cub.textContent = `Peso cúbico: ${pesoCubico.toFixed(2)}kg — peso considerado pela transportadora: ${considerado.toFixed(2)}kg`;
    } else {
      cub.textContent = '';
    }
  }

  const impostoInput = $('#pc_imposto');
  if (impostoInput) {
    impostoInput.disabled = regime === 'simples';
    if (regime === 'simples') impostoInput.value = impostoPct.toFixed(2);
  }

  const o = $('#kout'); if (!o) return;
  const faltando = !venda || !compra;
  const cor = lucro > 0 ? 'var(--up)' : 'var(--dn)';

  o.innerHTML = `
    <div class="stat"><div class="k">Margem líquida</div>
      <div class="v" style="color:${cor}">${margemLiquida!=null?pct(margemLiquida):'—'}</div></div>
    <div class="stat"><div class="k">Lucro líquido</div>
      <div class="v" style="color:${cor}">${brl(lucro)}</div></div>
    ${faltando?`<div class="cwarn">⚠️ Preencha preço de venda e preço de compra pra ter a margem líquida correta.</div>`:''}
    <details class="cdet" style="margin-top:6px"><summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--ink-2);padding:10px 0">Cálculo detalhado</summary>
      <div class="grp">Margem bruta</div>
      <div class="row"><span>Margem bruta</span><b>${margemBruta!=null?pct(margemBruta):'—'}</b></div>
      <div class="row"><span>Receita bruta</span><b>${brl(receitaBruta)}</b></div>

      <div class="grp">Por unidade</div>
      <div class="row"><span>Despesas totais</span><b class="neg">−${brl(despesas)}</b></div>
      <div class="row"><span>Receita (lucro líquido)</span><b style="color:${cor}">${brl(lucro)}</b></div>

      <div class="grp">Incluindo todas as vendas do mês</div>
      <div class="row"><span>Vendas mensais</span><b>${num(qtd)}</b></div>
      <div class="row"><span>Despesas totais</span><b class="neg">−${brl(despesas*qtd)}</b></div>
      <div class="row"><span>Receita (lucro líquido)</span><b style="color:${cor}">${brl(lucro*qtd)}</b></div>

      <div class="grp">Todas as despesas (por unidade)</div>
      <div class="row"><span>Preço de compra</span><b class="neg">−${brl(compra)}</b></div>
      <div class="row"><span>Comissão (${comissaoPct}%)</span><b class="neg">−${brl(comissaoR)}</b></div>
      ${taxaFixa?`<div class="row"><span>Taxa fixa</span><b class="neg">−${brl(taxaFixa)}</b></div>`:''}
      <div class="row"><span>Frete</span><b class="neg">−${brl(freteUn)}</b></div>
      <div class="row"><span>Impostos (${impostoPct.toFixed(2)}%)</span><b class="neg">−${brl(impostoR)}</b></div>
      <div class="row"><span>Custos adicionais</span><b class="neg">−${brl(extra)}</b></div>
    </details>`;
}

const CALC_IDS = ['pc_venda','pc_compra','pc_vendas','pc_comissao','pc_taxafixa','pc_taxafixa_v',
  'pc_peso','pc_altura','pc_largura','pc_comprimento','pc_reput','pc_frete',
  'pc_regime','pc_receita','pc_imposto','pc_extra'];
const CALC_RADIOS = ['pc_tipo','pc_gratis'];

function aplicarPresetCalc(p){
  // Não chama render() aqui de propósito: V.calc() gera o HTML com os
  // valores padrão fixos do template, então re-renderizar depois de
  // setar os campos apagaria a predefinição que acabou de ser carregada.
  // O DOM da view calc já existe (é daí que veio o clique), então só
  // precisa atualizar os campos e recalcular.
  CALC_IDS.forEach(id => {
    const el = document.getElementById(id); const v = p.campos[id];
    if (el && v !== undefined) el.type === 'checkbox' ? (el.checked = v) : (el.value = v);
  });
  CALC_RADIOS.forEach(name => {
    const v = p.campos[name];
    if (v === undefined) return;
    const r = document.querySelector(`input[name=${name}][value=${v}]`);
    if (r) r.checked = true;
  });
  calc();
}
function salvarPresetCalc(){
  const nome = prompt('Nome da predefinição:');
  if (!nome) return;
  const campos = {};
  CALC_IDS.forEach(id => { const el = document.getElementById(id); if (el) campos[id] = el.type==='checkbox' ? el.checked : el.value; });
  CALC_RADIOS.forEach(name => { campos[name] = document.querySelector(`input[name=${name}]:checked`)?.value; });
  const presets = presetsCalc();
  presets.push({ nome, campos });
  localStorage.setItem('gr_calc_presets', JSON.stringify(presets));
  render();
}
function excluirPresetCalc(i){
  const presets = presetsCalc();
  presets.splice(i, 1);
  localStorage.setItem('gr_calc_presets', JSON.stringify(presets));
  render();
}
/** Busca ao vivo no Mercado Livre — usado quando o produto ainda não
 *  está na nossa base. Cobre link de catálogo sempre; anúncio direto de
 *  outro vendedor pode vir bloqueado (ver ml-preco, o ML restringe
 *  esse tipo de consulta pra terceiro). */
async function buscarPrecoAoVivo(ref){
  const { data, error } = await sb.functions.invoke('ml-preco', { body: { ref } });
  if (error) return { ok:false, erro: error.message };
  return data;
}

async function aplicarLinkCalc(){
  const el = $('#pc_link'); const ref = el?.value.trim();
  if (!ref) return;
  const btn = $('#pc_aplicar'); if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const { data, error } = await sb.rpc('buscar_por_referencia', { p_ref: ref });
    if (error) { alert(error.message); return; }
    if (data.tipo === 'texto') { alert('Não reconheci isso como link ou código de produto do Mercado Livre.'); return; }

    if (data.tipo !== 'nao_encontrado') {
      const { data: ficha, error: e2 } = await sb.rpc('ficha_produto', { p_produto: data.produto });
      const preco = !e2 && ficha ? (ficha.concorrencia?.preco_mediano ?? ficha.preco?.preco_atual ?? null) : null;
      if (preco != null) {
        const v = $('#pc_venda'); if (v) v.value = preco;
        calc();
        return;
      }
      // achou o produto na nossa base, mas sem preço coletado ainda —
      // tenta ao vivo antes de desistir.
    }

    const vivo = await buscarPrecoAoVivo(ref);
    if (vivo.ok && vivo.preco != null) {
      const v = $('#pc_venda'); if (v) v.value = vivo.preco;
      calc();
      return;
    }
    if (vivo.ok && vivo.preco == null) {
      alert(`Achei "${vivo.nome ?? data.mlb ?? ref}" no Mercado Livre, mas não consegui um preço agora — preencha manualmente.`);
      return;
    }
    if (vivo.erro === 'bloqueado_ou_nao_encontrado') {
      alert(`${data.mlb ?? ref}: o Mercado Livre bloqueia consulta a anúncio de terceiro desse tipo — preencha o preço manualmente, ou peça a coleta pela extensão.`);
      return;
    }
    alert(`Não consegui achar "${ref}" — nem na nossa base, nem ao vivo no Mercado Livre.`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Aplicar'; }
  }
}

// ---------------------------------------------------------------------
// CLIPES E IMAGENS — a navegação e a quota são reais; a geração em si
// não é.
//
// Gerar vídeo/imagem de produto por IA precisa de um provedor pago
// (ex.: Kling/Runway pra vídeo, Ideogram/Recraft pra imagem) que este
// projeto ainda não tem configurado. Deixar o botão "funcionando" sem
// gerar nada de verdade seria prometer o que não existe — o app inteiro
// evita isso (ver as etiquetas honestas no Monitor e na Busca). Por
// isso "Gerar" fica desabilitado com aviso, até ter um provedor — mas
// clicar em "Gerar imagens"/"Gerar clipes" no hub JÁ leva pra tela de
// verdade, com a quota real do plano (feature ai_content, já existe em
// plans.limits) e um jeito de anexar produto de verdade.
// ---------------------------------------------------------------------
// Preencha aqui quando tiver links de exemplo com direito de uso (foto
// própria, estoque licenciado, ou reaproveitar foto real já coletada).
// Nunca aponte pra asset hospedado pela concorrente — ver conversa.
const EXEMPLO_MIDIA = {
  video: null,       // ex.: 'https://.../seu-video-exemplo.mp4'
  imagens: [],        // ex.: ['https://.../1.jpg', ...] até 9
};

function blocoExemploVideo(){
  return `<div class="exvideo">${EXEMPLO_MIDIA.video
    ? `<video src="${esc(EXEMPLO_MIDIA.video)}" controls preload="metadata"></video>`
    : `<div class="exph">sem exemplo ainda</div>`}</div>
  <div class="excap">Exemplo de geração. Clique para visualizar.</div>`;
}
function blocoExemploImagens(){
  const imgs = EXEMPLO_MIDIA.imagens.slice(0, 9);
  const vazios = Math.max(0, 9 - imgs.length);
  return `<div class="exgrid">
    ${imgs.map(u => `<img src="${esc(u)}" alt="">`).join('')}
    ${Array.from({length: vazios}, () => `<div class="exph">sem exemplo</div>`).join('')}
  </div>
  <div class="excap">Exemplo de geração. Clique para visualizar.</div>`;
}

V.clipes = () => `<h1 class="pg">Clipes e imagens
    <span class="chip y" style="margin-left:8px;vertical-align:middle">Em desenvolvimento</span></h1>
  <p class="sub">Geração de vídeos e imagens de produto com IA.</p>
  <div class="hero" style="margin-bottom:22px">
    <h3>Em desenvolvimento</h3>
    <p>Esta área ainda não está disponível. Em breve você poderá gerar clipes e imagens
      a partir dos seus produtos, direto pelo painel.</p>
  </div>
  <div class="cwarn">Estamos finalizando a integração com o provedor de IA.
    Enquanto isso, use Busca, Monitor e a Extensão Chrome normalmente.</div>`;

function vistaGerarConteudo(tipo){
  S.clipesVista = null;
  return V.clipes();
}

async function adicionarProdutoClipes(){
  return;
}

// ---------------------------------------------------------------------
// ASSINATURA — planos e preços são reais (tabela plans). "Assinar"
// fica desabilitado: cobrança recorrente precisa de um gateway de
// pagamento (Mercado Pago, Stripe...) que este projeto não tem
// conectado ainda. Fingir que processa pagamento sem gateway de
// verdade enganaria quem tentasse assinar — mesmo raciocínio de
// Clipes e imagens, com um agravante: aqui envolveria dinheiro.
// ---------------------------------------------------------------------
const LABEL_LIMITE = {
  product_search:'Buscas de produto/mês', rows_full:'Linhas completas por busca',
  category_view:'Consultas de categoria/mês', seller_search:'Buscas de vendedor/mês',
  tracked_items:'Produtos no Monitor', extension_view:'Consultas pela extensão/mês',
  supplier_unlock:'Fornecedores desbloqueados/mês', competitor_analysis:'Análises de concorrência/mês',
  ai_content:'Gerações de IA/mês', export_csv:'Exportações CSV/mês', calculator:'Usos da calculadora/mês',
};

async function carregarPlanos(){
  const { data, error } = await sb.rpc('listar_planos');
  if (error) return;
  S.planos = data ?? [];
}

V.extensao = () => {
  const store = 'https://chromewebstore.google.com/detail/gringa-radar/eilndeohnfhbfhbcikepjpbmgkdkjblp';
  return `
  <h1 class="pg">Extensão Chrome</h1>
  <p class="sub">Instale agora e passe a monitorar produtos do Mercado Livre direto na página do anúncio —
    com a mesma conta deste painel.</p>
  <div class="hero" style="margin-bottom:22px">
    <h3>Monitore produtos no Mercado Livre</h3>
    <p>Depois de colocar a extensão no Chrome, abra qualquer anúncio no Mercado Livre:
      o Gringa Radar mostra posição no ranking, concorrência, preços e vendidos, e você
      pode adicionar o produto ao <b>Monitor</b> sem sair da página.</p>
    <a class="b" href="${store}" target="_blank" rel="noopener"
      style="display:inline-block;text-decoration:none">＋ Instalar extensão no Chrome</a>
  </div>
  <div class="g2">
    <div class="card cbox">
      <div class="ct">Como instalar</div>
      <ol style="margin:0;padding-left:18px;color:var(--ink-2);font-size:13.5px;line-height:1.55">
        <li>Clique em <b>Instalar extensão no Chrome</b> acima</li>
        <li>Na Chrome Web Store, escolha <b>Usar no Chrome</b></li>
        <li>Confirme — a extensão aparece na barra do navegador</li>
      </ol>
      <p class="hint" style="margin:14px 0 0">Link direto:
        <a href="${store}" target="_blank" rel="noopener">Chrome Web Store — Gringa Radar</a></p>
    </div>
    <div class="card cbox">
      <div class="ct">Como monitorar</div>
      <ol style="margin:0;padding-left:18px;color:var(--ink-2);font-size:13.5px;line-height:1.55">
        <li>Entre na extensão com o <b>mesmo e-mail e senha</b> deste painel</li>
        <li>Abra um produto no Mercado Livre</li>
        <li>No card do Gringa Radar, use <b>Monitorar</b> para acompanhar posição, preço e vendidos</li>
      </ol>
      <p class="hint" style="margin:14px 0 0">Assinatura ativa (ou trial) é necessária para liberar os dados na página.</p>
      <button class="btn" data-go="assinatura" style="margin-top:12px">Ver planos</button>
    </div>
  </div>`;
};

V.assinatura = () => `<h1 class="pg">Assinatura
    <span class="chip y" style="margin-left:8px;vertical-align:middle">Em desenvolvimento</span></h1>
  <p class="sub">Planos e pagamento online.</p>
  <div class="hero" style="margin-bottom:22px">
    <h3>Em desenvolvimento</h3>
    <p>A cobrança automática e a troca de plano pelo painel ainda não estão
      disponíveis para o público. Em breve você assina e faz upgrade por aqui.</p>
  </div>
  <div class="cwarn">Enquanto isso, o acesso à extensão e aos recursos do plano continua
    sendo controlado pela assinatura ativa (ou trial) no sistema.
    Fale com o suporte se precisar alterar seu plano agora.</div>`;

async function iniciarCheckout(plan){
  S.pagoMsg = { ok:false, texto: 'Assinatura ainda em desenvolvimento.' };
  render();
}

// ---------------------------------------------------------------------
// ASSISTENTE — responde com os dados reais da conta (monitorados,
// alertas, quota, e o produto aberto quando houver). A Edge Function
// consome a quota ai_content ANTES de chamar a IA, pra nunca gastar
// chamada de API num pedido que o plano já não permite.
// ---------------------------------------------------------------------
function renderAssist(){
  const panel = $('#assistPanel'); if (!panel) return;
  panel.classList.toggle('hide', !S.assistOpen);
  const box = $('#assistMsgs'); if (!box) return;
  box.innerHTML = (S.assistMsgs.length ? S.assistMsgs.map(m =>
      `<div class="amsg ${m.role}">${esc(m.texto)}</div>`).join('')
    : `<div class="amsg ai">Oi! Pergunte sobre os produtos que você monitora, um alerta, ou o que uma
        métrica da tela significa.</div>`)
    + (S.assistBusy ? `<div class="amsg ai busy">pensando…</div>` : '');
  box.scrollTop = box.scrollHeight;
}

async function enviarPerguntaAssistente(){
  const el = $('#assistInput'); const pergunta = el?.value.trim();
  if (!pergunta || S.assistBusy) return;
  el.value = '';
  S.assistMsgs.push({ role:'user', texto: pergunta });
  S.assistBusy = true; renderAssist();

  const contexto = (S.view === 'detalhe' && S.detalhe?.produto?.product_id)
    ? { produtoId: S.detalhe.produto.product_id } : {};

  try {
    const { data, error } = await sb.functions.invoke('assistente', { body: { pergunta, contexto } });
    if (error || !data?.ok) {
      S.assistMsgs.push({ role:'erro', texto: data?.erro === 'quota'
        ? 'Sua quota de IA deste mês acabou. Veja os planos em Assinatura.'
        : 'Não consegui responder agora. Tenta de novo em um instante.' });
    } else {
      S.assistMsgs.push({ role:'ai', texto: data.resposta });
    }
  } catch {
    S.assistMsgs.push({ role:'erro', texto:'Não consegui responder agora. Tenta de novo em um instante.' });
  } finally {
    S.assistBusy = false; renderAssist();
  }
}

async function carregarMonitor(){
  const [m,a,f,v,hm] = await Promise.all([
    sb.rpc('listar_monitorados'),
    sb.rpc('listar_alertas',{p_limite:80}),
    sb.rpc('meus_pedidos'),
    sb.from('tracked_sellers').select('seller_id,created_at,sellers(nickname,city,state,permalink,is_official_store)').order('created_at',{ascending:false}),
    sb.rpc('historico_monitorados',{p_dias:21}),
  ]);
  S.monitorados = m.data ?? []; S.alertas = a.data ?? []; S.pedidos = f.data ?? [];
  S.vendedores = v.data ?? [];
  S.histMon = {};
  if (hm.error) console.warn('historico_monitorados', hm.error.message);
  (hm.data ?? []).forEach(r => {
    (S.histMon[r.product_id] ??= []).push({ dia: r.dia, posicao: r.posicao, preco: r.preco });
  });
}
async function buscarVendedores(){
  const t = S.vendBusca.trim();
  if (t.length < 2) { S.vendResultado = []; render(); return; }
  S.vendBuscando = true; render();
  const { data, error } = await sb.rpc('buscar_vendedores', { p_texto:t, p_limite:20 });
  S.vendBuscando = false;
  if (error) { if(!eQuota(error)) alert(error.message); return; }
  S.vendResultado = data ?? []; render();
}
async function acompanharVendedor(id){
  const { error } = await sb.from('tracked_sellers').insert({ seller_id:id });
  if (error) { alert(error.message); return; }
  S.vendAdd=false; S.vendBusca=''; S.vendResultado=[];
  await carregarMonitor(); render();
}
async function largarVendedor(id){
  await sb.from('tracked_sellers').delete().eq('seller_id', id);
  await carregarMonitor(); render();
}
async function seguir(id, snapshot){
  const { data, error } = await sb.rpc('monitorar_produto',{ p_produto:id, p_snapshot:snapshot ?? null });
  if (error) return alert(error.message);
  if (!data?.ok){
    alert(`Seu plano permite acompanhar ${data.limite} produtos e você já tem ${data.usados}. Remova um ou faça upgrade.`);
    return;
  }
  await carregarMonitor(); render();
}
async function largar(id){
  await sb.rpc('desmonitorar_produto',{ p_produto:id });
  await carregarMonitor(); render();
}
async function removerPedido(mlb){
  if (!confirm(`Remover ${mlb} da fila de coleta?`)) return;
  const { error } = await sb.rpc('excluir_pedido', { p_mlb: mlb });
  if (error) { alert(error.message); return; }
  await carregarMonitor(); render();
}

async function buscarLocais(acumular){
  const el = $('#lres'); if (el && !acumular) el.innerHTML = '<div class="load">buscando…</div>';
  const criadoDesde = S.locaisCriado ? new Date(Date.now() - S.locaisCriado*86400000).toISOString().slice(0,10) : null;
  const { data, error } = await sb.rpc('listar_produtos_locais', {
    p_texto: vT('l_txt'), p_custo_max: vF('l_custo_max'), p_custo_min: vF('l_custo_min'),
    p_margem_min: vF('l_marg'),
    p_categorias: S.locaisCatSel.size ? [...S.locaisCatSel] : null,
    p_criado_desde: criadoDesde,
    p_caixa_min: S.locaisCaixaMin, p_caixa_max: S.locaisCaixaMax,
    p_limite: 60, p_offset: S.locaisOffset });
  if (error){ if (el) el.innerHTML = `<div class="card"><div class="none"><b>Erro</b>${esc(error.message)}</div></div>`; return; }
  S.locais = acumular ? [...S.locais, ...(data ?? [])] : (data ?? []); render();
  if (S.locaisMeliOn) buscarMeliParaLocais();
}

async function desbloquear(fid){
  const { data, error } = await sb.rpc('desbloquear_fornecedor', { p_fornecedor: fid });
  if (error) return alert(error.message);
  if (!data?.ok){
    alert(data?.motivo === 'quota_exceeded' || data?.motivo === 'plan_upgrade_required'
      ? 'Seus desbloqueios do mês acabaram. O contador zera no dia 1º.'
      : 'Não foi possível liberar este fornecedor.');
    await quota(); render(); return;
  }
  S.contatos[fid] = data;
  await quota(); render();
}

/** Baixa o resultado em CSV. Só as linhas visíveis — exportar o que
 *  está borrado seria burlar o próprio limite. */
function exportarCsv(){
  const lim = S.quota?.features?.rows_full;
  const livres = (lim?.unlimited || lim?.limit === -1) ? S.produtos.length : (lim?.limit ?? 5);
  const linhas = S.produtos.slice(0, livres);
  if (!linhas.length) return;

  const cab = ['produto_id','nome','categoria','posicao','melhor_posicao',
               'movimento_7d','movimento_30d','dias_top10','dias_observados',
               'concorrentes','vendedores','preco_min','preco_mediano','preco_max','full_share'];
  const linha = (p) => [p.product_id,p.name,p.category_name,p.position_now,p.best_position,
    p.delta_7d,p.delta_30d,p.days_in_top10,p.days_observed,p.listings,p.sellers,
    p.min_price,p.median_price,p.max_price,p.full_share]
    .map(v => v==null ? '' : `"${String(v).replace(/"/g,'""')}"`).join(';');

  const csv = '\uFEFF' + [cab.join(';'), ...linhas.map(linha)].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8' }));
  a.download = `gringa-radar-${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

async function monitorarLote(){
  const ids = [...S.selecao];
  if (!ids.length) return;
  const { data, error } = await sb.rpc('monitorar_lote', { p_produtos: ids });
  if (error) return alert(error.message);
  S.selecao.clear();
  await carregarMonitor();
  alert(data.fora_do_limite > 0
    ? `${data.adicionados} adicionado(s). ${data.fora_do_limite} ficaram de fora: seu plano permite ${data.limite}.`
    : `${data.adicionados} produto(s) adicionados ao Monitor.`);
  render();
}

const eQuota = e => (e?.code==='P0001'||/quota/i.test(e?.message||'')) ? (quota().then(render), true) : false;

const vI = id => { const v = parseInt($('#'+id)?.value); return Number.isFinite(v)?v:null; };
const vF = id => { const v = parseFloat($('#'+id)?.value); return Number.isFinite(v)?v:null; };
const vT = id => $('#'+id)?.value.trim() || null;

/** Lê a tela e monta o objeto de filtros que vai para a RPC. */
function lerFiltros(){
  const F = {
    ...S.F,
    p_categoria:    S.catSel?.id ?? null,
    p_texto:        vT('f_txt'),
    p_pos_min:      vI('f_pmin'),
    p_pos_max:      vI('f_pmax'),
    p_melhor_pos:   vI('f_best'),
    p_preco_min:    vF('f_vmin'),
    p_preco_max:    vF('f_vmax'),
    p_momentum:     vT('f_mov'),
    p_delta_min:    vI('f_delta'),
    p_caiu_min:     vI('f_caiu'),
    p_consistencia: vT('f_cons'),
    p_top10_min:    vI('f_top10'),
    p_conc_min:     vI('f_cmin'),
    p_conc_max:     vI('f_cmax'),
    p_dispersao_min:vF('f_disp'),
    p_visto_min:    vI('f_vmin_visto'),
    p_visto_max:    vI('f_vmax_visto'),
    p_dias_min:     vI('f_omin'),
    p_dias_max:     vI('f_omax'),
    p_vend_min:     vI('f_smin'),
    p_vend_max:     vI('f_smax'),
    p_ordem:        vT('f_ord') || S.F.p_ordem || 'posicao',
  };

  const full = document.querySelector('input[name=full]:checked');
  if (full) {
    if (full.value === 'baixo') { F.p_full_max = 0.3; delete F.p_full_min; }
    else if (full.value === 'alto') { F.p_full_min = 0.7; delete F.p_full_max; }
    else { delete F.p_full_min; delete F.p_full_max; }
  }
  const ofi = document.querySelector('input[name=ofi]:checked');
  if (ofi) {
    F.p_oficial_max = ofi.value === '' ? null : parseFloat(ofi.value);
  }

  Object.keys(F).forEach(k => { if (F[k]===null||F[k]===''||F[k]===undefined) delete F[k]; });
  return F;
}

/** Contagem ao vivo — não consome quota. */
async function contar(){
  const F = { ...S.F };
  const { data } = await sb.rpc('contar_produtos', {
    p_categoria:F.p_categoria??null, p_texto:F.p_texto??null,
    p_pos_min:F.p_pos_min??null, p_pos_max:F.p_pos_max??null,
    p_preco_min:F.p_preco_min??null, p_preco_max:F.p_preco_max??null,
    p_momentum:F.p_momentum??null,
    p_conc_min:F.p_conc_min??null, p_conc_max:F.p_conc_max??null,
    p_maturidade:F.p_maturidade??null,
    p_nivel_conc:F.p_nivel_conc??null, p_estabilidade:F.p_estabilidade??null,
    p_visto_min:F.p_visto_min??null, p_visto_max:F.p_visto_max??null,
    p_dias_min:F.p_dias_min??null, p_dias_max:F.p_dias_max??null,
    p_com_foto:F.p_com_foto??null,
    p_vend_min:F.p_vend_min??null, p_vend_max:F.p_vend_max??null,
    p_top10_min:F.p_top10_min??null, p_top10_rate_min:F.p_top10_rate_min??null,
    p_caiu_min:F.p_caiu_min??null, p_delta_min:F.p_delta_min??null,
    p_melhor_pos:F.p_melhor_pos??null, p_dispersao_min:F.p_dispersao_min??null,
    p_full_min:F.p_full_min??null, p_full_max:F.p_full_max??null,
    p_oficial_max:F.p_oficial_max??null,
  });
  S.contagem = data ?? null;
  document.querySelectorAll('.cnt').forEach(el => {
    el.innerHTML = S.contagem==null ? '—'
      : `<b>${num(S.contagem)}</b> produto(s) batem com esses filtros`;
  });
}

async function acharCategorias(txt){
  if (!txt || txt.length < 2){ S.catLista=[]; return; }
  const { data } = await sb.rpc('buscar_categorias', { p_texto:txt, p_limite:20 });
  S.catLista = data ?? [];
}

async function carregarNivelCategoria(parentId){
  const chave = parentId ?? '_raiz';
  if (S.catArvore[chave]) return;
  const { data } = await sb.rpc('categoria_filhos', { p_parent_id: parentId ?? null });
  S.catArvore[chave] = data ?? [];
}

async function localizar(){
  const ref = $('#f_ref')?.value.trim();
  if (!ref) return;
  S.ref = ref; S.refAviso = null; S.refVivo = null; S.refPedidoOk = null; S.refBusy = true;
  render();
  try {
    const { data, error } = await sb.rpc('buscar_por_referencia', { p_ref: ref });
    if (error) { S.refAviso = error.message; return; }

    if (data.tipo === 'produto'){
      // Pode estar no catálogo sem ranking — tenta busca; se vier vazio, cai no ao vivo
      S.F = { p_produto: data.produto, p_com_foto: true }; S.pred = null; S.catSel = null;
      await buscar();
      if (S.produtos?.length) return;
      // Sem linha na busca: tenta ficha direta
      const { data: ficha } = await sb.rpc('ficha_produto', { p_produto: data.produto });
      if (ficha?.produto?.product_id || ficha?.produto?.name) {
        S.voltaPara = 'produtos';
        await abrir(data.produto);
        return;
      }
    }

    if (data.tipo === 'texto'){
      S.F = { ...S.F, p_texto: ref, p_com_foto: true }; delete S.F.p_produto;
      await buscar();
      return;
    }

    // nao_encontrado (ou produto sem ficha) — consulta ao vivo no ML
    const vivo = await buscarPrecoAoVivo(ref);
    if (vivo?.ok && vivo.id) {
      // Se a API devolveu um produto de catálogo, tenta de novo na nossa base
      // (às vezes o anúncio MLB não está, mas o /p/MLB do catálogo sim).
      if (vivo.tipo === 'produto' && vivo.id) {
        const { data: again } = await sb.rpc('buscar_por_referencia', { p_ref: vivo.id });
        if (again?.tipo === 'produto') {
          S.F = { p_produto: again.produto, p_com_foto: true }; S.pred = null; S.catSel = null;
          await buscar();
          if (S.produtos?.length) return;
          await abrir(again.produto);
          return;
        }
      }
      S.refVivo = vivo;
      S.refAviso = null;
      return;
    }

    if (vivo?.erro === 'bloqueado_ou_nao_encontrado') {
      S.refAviso = `${vivo.mlb || data.mlb || 'Esse anúncio'} não está na nossa base e o Mercado Livre bloqueou a consulta ao vivo pra terceiro. Peça a coleta pela extensão Chrome abrindo o anúncio no ML.`;
      return;
    }
    if (vivo?.erro === 'sem_credencial') {
      S.refAviso = 'Não consegui consultar o Mercado Livre agora (credencial). Tente de novo em instantes.';
      return;
    }
    S.refAviso = `${data.mlb || ref} não está na nossa base. Use a extensão Chrome no anúncio pra pedir a coleta.`;
  } finally {
    S.refBusy = false;
    render();
  }
}

async function pedirColetaRef(){
  const v = S.refVivo;
  if (!v?.id && !S.ref) return;
  const mlb = v?.mlb_anuncio || (v?.tipo === 'item' ? v.id : null) || v?.id;
  if (!mlb) { S.refAviso = 'Não achei um MLB pra pedir coleta.'; render(); return; }
  const { data, error } = await sb.rpc('solicitar_coleta', {
    p_mlb: mlb,
    p_categoria: v?.categoria || null,
    p_url: v?.permalink || S.ref || null,
  });
  if (error) { S.refAviso = error.message; render(); return; }
  S.refPedidoOk = data?.aviso
    ? `Pedido registrado (${data.pedidos} pedido(s)). ${data.aviso}`
    : `Pedido de coleta registrado (${data?.pedidos ?? 1}). Entra na fila da próxima rodada.`;
  S.refAviso = null;
  render();
}

async function buscar(){
  S.F = { ...S.F, ...lerFiltros() };
  $('#res').innerHTML = '<div class="load">buscando…</div>';
  const { data, error } = await sb.rpc('buscar_produtos', { ...S.F, p_limite:100 });
  if (error){ if(!eQuota(error)) $('#res').innerHTML=`<div class="none"><b>Erro</b>${esc(error.message)}</div>`; return; }
  S.produtos = data ?? []; S.buscou = true; S.filtrosAbertos = false; S.selecao.clear();
  await quota(); render();
}
async function cats(){
  $('#cres').innerHTML = '<div class="load">carregando…</div>';
  const texto = $('#c_txt')?.value.trim()||null;
  const { data, error } = await sb.rpc('listar_categorias', { p_texto:texto, p_limite:100 });
  if (error){ if(!eQuota(error)) $('#cres').innerHTML=`<div class="none"><b>Erro</b>${esc(error.message)}</div>`; return; }
  S.categorias = data ?? []; await quota();
  logarBuscaCategorias(texto, S.categorias); // nao bloqueia o render
  await carregarCategoriasRecentes();
  render();
}
function logarBuscaCategorias(texto, categorias){
  if (!categorias.length) return;
  const linhas = categorias.slice(0,50).map(c => ({ category_id:c.category_id, texto }));
  sb.from('category_search_log').insert(linhas).then(({error}) => {
    if (error) console.error('log de busca de categoria falhou', error.message);
  });
}
async function carregarCategoriasRecentes(){
  const { data, error } = await sb.rpc('categorias_recentes', { p_limite:8 });
  if (!error) S.categoriasRecentes = data ?? [];
}

async function abrirCategoria(id, nome){
  S.view = 'catdetalhe'; S.catDetalhe = null; S.catDetalheHist = [];
  S.catSel = { id, nome }; S.F = { p_categoria:id }; S.pred = null; S.buscou = false;
  render();
  const [d, h] = await Promise.all([
    sb.rpc('categoria_detalhe', { p_categoria:id }),
    sb.rpc('categoria_historico', { p_categoria:id, p_dias:30 }),
  ]);
  S.catDetalhe = d.data?.[0] ?? null;
  S.catDetalheHist = h.data ?? [];
  render();
  await buscar();
}
async function abrirComLocal(id, achado, local){
  await abrir(id);
  // Produto achado via busca ao vivo (Encontrado no MeLi) pode nunca ter
  // sido coletado pelo nosso ranking -- ficha_produto() volta vazio nesse
  // caso. Usa o que a propria busca ja trouxe em vez de mostrar em branco.
  if (achado?.encontrado && S.detalhe && !S.detalhe.produto?.name) {
    S.detalhe.produto = { ...S.detalhe.produto, product_id:id, name:achado.nome,
      picture:achado.imagem, permalink:achado.permalink || null, median_price:achado.preco_mediano };
  }
  S.detalheLocal = local; render();
}
/** Traduz ficha_produto (PT) pro formato que a tela de detalhe usa. */
function fromFicha(fp, id){
  const r = fp?.ranking ?? {};
  const k = fp?.concorrencia ?? {};
  const pr = fp?.preco ?? {};
  const prod = fp?.produto ?? {};
  return {
    product_id: id,
    name: prod.nome ?? null,
    picture: prod.imagem ?? null,
    permalink: prod.link || null,
    category_name: prod.categoria ?? null,
    brand: prod.marca ?? null,
    category_id: prod.categoria_id ?? null,
    // produto_ranking_analise usa nomes em PT — NÃO position_now
    position_now: r.posicao_atual ?? r.position_now ?? null,
    best_position: r.melhor_posicao ?? r.best_position ?? null,
    days_in_top10: r.dias_top10 ?? r.days_in_top10 ?? 0,
    days_observed: r.dias_no_ranking ?? r.days_observed ?? 0,
    median_price: k.preco_mediano ?? pr.preco_atual ?? null,
    min_price: k.preco_minimo ?? pr.preco_minimo ?? null,
    max_price: k.preco_maximo ?? pr.preco_maximo ?? null,
    listings: k.anuncios ?? null,
    sellers: k.vendedores ?? null,
  };
}

async function abrir(id){
  S.detalheLocal = null;
  const daBusca = S.produtos.find(x=>x.product_id===id);
  $('#sheet').innerHTML='<div class="load">carregando produto…</div>';
  // Sempre busca ficha: abrir pelo Monitor não passa pela Busca, e a ficha
  // é a fonte dos cards de posição/preço. Antes o mapeamento lia
  // position_now (nome da matview) em vez de posicao_atual (da ficha) —
  // por isso os cards ficavam "—" mesmo com dado no banco.
  const [h, c, f] = await Promise.all([
    sb.rpc('historico_produto',{p_produto:id}),
    sb.rpc('concorrentes_produto',{p_produto:id}),
    sb.rpc('ficha_produto', { p_produto: id }),
  ]);
  let p = f?.data ? fromFicha(f.data, id) : null;
  if (!p?.name && daBusca) p = { ...fromFicha({}, id), ...daBusca };
  if (!p) p = { product_id: id };

  const concorrentes = Array.isArray(c?.data) ? c.data : [];
  const historico = Array.isArray(h?.data) ? h.data : [];

  S.detalhe = { produto:p, historico, concorrentes, ficha: f?.data ?? null };
  S.detalheAba = 'catalogo'; S.similares = []; S.similaresCarregado = false;
  S.view='detalhe'; render();
}
async function carregarSimilares(){
  if (S.similaresCarregado) return;
  const catId = S.detalhe?.produto?.category_id;
  if (!catId) { S.similaresCarregado = true; return; }
  const { data } = await sb.rpc('produtos_similares', { p_categoria:catId, p_excluir:S.detalhe.produto.product_id, p_limite:20 });
  S.similares = data ?? []; S.similaresCarregado = true;
}

function render(){
  if (S.view === 'alerta') { S.view = 'monitor'; S.aba = 'alertas'; }
  // Shopee ainda não tem as mesmas telas — mantém o usuário na aba dedicada
  if (S.marketplace === 'shopee' && !['shopee','assinatura','extensao','calc','clipes'].includes(S.view)) {
    S.view = 'shopee';
  }
  pintaMarketplace();
  // Posição/preço só mudam com a coleta diária, mas alertas e ações em
  // outra aba/aparelho não. Reconsulta sozinho enquanto o Monitor estiver
  // aberto, pra não depender de F5 pra ver alerta novo chegar.
  if (S.view === 'monitor') {
    if (!monitorPollId) monitorPollId = setInterval(async () => {
      if (S.view !== 'monitor') { clearInterval(monitorPollId); monitorPollId = null; return; }
      await carregarMonitor(); render();
    }, 45000);
  } else if (monitorPollId) {
    clearInterval(monitorPollId); monitorPollId = null;
  }
  document.querySelectorAll('.item,.solo').forEach(b =>
    b.setAttribute('aria-current', String(b.dataset.v===S.view)));
  $('#sheet').innerHTML = (V[S.view] ?? V.home)();
  pintaQuota();
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { S.view=b.dataset.go; render(); });
  document.querySelectorAll('#sheet [data-mkt]').forEach(b => b.onclick = () => setMarketplace(b.dataset.mkt));
  document.querySelectorAll('[data-go-diario]').forEach(b => b.onclick = () => {
    S.diarioAba = b.dataset.goDiario || 'novos';
    S.diarioLoaded = false;
    S.diario = [];
    S.diarioOffset = 0;
    S.view = 'diario';
    render();
  });
  document.querySelectorAll('[data-cd-go]').forEach(b => b.onclick = () => abrirCategoria(b.dataset.cdGo, b.dataset.cdNome));
  if ($('#avisos_lidos')) $('#avisos_lidos').onclick = async () => {
    await sb.rpc('marcar_avisos_lidos');
    S.avisos = (S.avisos || []).map(a => ({ ...a, lido: true }));
    render();
  };
  if (S.view==='produtos' || S.view==='catdetalhe'){
    if ($('#b_go')) $('#b_go').onclick = buscar;
    if ($('#b_go2')) $('#b_go2').onclick = () => { S.F = lerFiltros(); buscar(); };
    if ($('#b_ref')) $('#b_ref').onclick = localizar;
    if ($('#f_ref')) $('#f_ref').onkeydown = (e) => { if (e.key==='Enter') localizar(); };
    if ($('#b_pedir_coleta')) $('#b_pedir_coleta').onclick = pedirColetaRef;
    if ($('#b_ref_limpar')) $('#b_ref_limpar').onclick = () => {
      S.refVivo = null; S.refPedidoOk = null; S.refAviso = null; render();
    };
    if ($('#f_txt')) $('#f_txt').onkeydown = (e) => { if (e.key==='Enter') { S.F = lerFiltros(); buscar(); } };
    if ($('#b_cl')) $('#b_cl').onclick = () => {
      S.F={ p_com_foto:true }; S.pred=null; S.catSel=null; S.catLista=[]; S.ref=''; S.refAviso=null;
      S.refVivo=null; S.refPedidoOk=null;
      S.buscou=false; S.produtos=[]; S.contagem=null; S.sel=null; render(); };

    document.querySelectorAll('.mb').forEach(b => b.onclick = () => { S.modo=b.dataset.md; S.sel=null; render(); });

    document.querySelectorAll('.pd').forEach(b => b.onclick = () => {
      const p = PREDEF.find(x=>x.k===b.dataset.pd);
      if (S.pred===p.k){ S.pred=null; S.F={ p_com_foto:true }; }
      else { S.pred=p.k; S.F={ p_com_foto:true, ...p.f }; }
      render(); contar(); });

    document.querySelectorAll('details.fsec').forEach(d => {
      d.addEventListener('toggle', () => {
        if (!S.buscaOpen) S.buscaOpen = new Set();
        if (d.open) S.buscaOpen.add(d.dataset.sec);
        else S.buscaOpen.delete(d.dataset.sec);
      });
    });

    // faixas rápidas de preço, posição e concorrentes
    const aplicarFaixa = (minKey, maxKey, raw) => {
      const [a,z] = raw.split('|');
      S.F = { ...S.F, ...lerFiltros() };
      const curA = S.F[minKey], curZ = S.F[maxKey];
      const mesmo = String(curA??'')===String(a) && String(curZ??'')===String(z);
      if (mesmo) { delete S.F[minKey]; delete S.F[maxKey]; }
      else {
        const parse = (v) => minKey.includes('preco') ? parseFloat(v) : parseInt(v, 10);
        if (a==='') delete S.F[minKey]; else S.F[minKey] = parse(a);
        if (z==='') delete S.F[maxKey]; else S.F[maxKey] = parse(z);
      }
      if (minKey === 'p_conc_min') delete S.F.p_nivel_conc;
      Object.keys(S.F).forEach(k=>{ if(S.F[k]===undefined) delete S.F[k]; });
      render(); contar();
    };
    document.querySelectorAll('[data-pf]').forEach(b => b.onclick = () => aplicarFaixa('p_preco_min','p_preco_max', b.dataset.pf));
    document.querySelectorAll('[data-rf]').forEach(b => b.onclick = () => aplicarFaixa('p_pos_min','p_pos_max', b.dataset.rf));
    document.querySelectorAll('[data-cf]').forEach(b => b.onclick = () => aplicarFaixa('p_conc_min','p_conc_max', b.dataset.cf));
    document.querySelectorAll('[data-vf]').forEach(b => b.onclick = () => aplicarFaixa('p_visto_min','p_visto_max', b.dataset.vf));
    document.querySelectorAll('[data-of]').forEach(b => b.onclick = () => aplicarFaixa('p_dias_min','p_dias_max', b.dataset.of));
    document.querySelectorAll('[data-sf]').forEach(b => b.onclick = () => aplicarFaixa('p_vend_min','p_vend_max', b.dataset.sf));
    document.querySelectorAll('[data-t10]').forEach(b => b.onclick = () => {
      S.F = { ...S.F, ...lerFiltros() };
      const v = Number(b.dataset.t10);
      if (S.F.p_top10_min === v) delete S.F.p_top10_min; else S.F.p_top10_min = v;
      render(); contar();
    });
    document.querySelectorAll('[data-t10r]').forEach(b => b.onclick = () => {
      S.F = { ...S.F, ...lerFiltros() };
      const v = Number(b.dataset.t10r);
      if (S.F.p_top10_rate_min === v) delete S.F.p_top10_rate_min; else S.F.p_top10_rate_min = v;
      render(); contar();
    });
    document.querySelectorAll('[data-foto]').forEach(b => b.onclick = () => {
      S.F = { ...S.F, ...lerFiltros() };
      const v = b.dataset.foto === '1';
      if (S.F.p_com_foto === v) delete S.F.p_com_foto; else S.F.p_com_foto = v;
      render(); contar();
    });

    // seletores semânticos da pesquisa simples
    document.querySelectorAll('[data-sem]').forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      S.sel = S.sel===b.dataset.sem ? null : b.dataset.sem; render(); });
    document.querySelectorAll('[data-sv]').forEach(b => b.onclick = () => {
      const [campo,valor] = b.dataset.sv.split('|');
      S.F = { ...S.F, ...lerFiltros() };
      S.F[campo] = S.F[campo]===valor ? undefined : valor;
      if (S.F[campo]===undefined) delete S.F[campo];
      // maturidade/nível semântico limpa faixas numéricas que sobrescreveriam
      if (campo === 'p_nivel_conc') { delete S.F.p_conc_min; delete S.F.p_conc_max; }
      S.sel = null; render(); contar(); });
    document.addEventListener('click', () => { if (S.sel){ S.sel=null; render(); } }, { once:true });

    const ci = $('#f_cat');
    if (ci){ let t;
      ci.onfocus = async () => {
        if (S.catAberto) return;
        S.catAberto = true;
        await carregarNivelCategoria(null);
        render();
        const n = $('#f_cat'); if (n) n.focus();
      };
      ci.oninput = () => { clearTimeout(t); t=setTimeout(async () => {
        await acharCategorias(ci.value.trim());
        const pos = ci.selectionStart; render();
        const n = $('#f_cat'); if (n){ n.focus(); n.value = ci.value; n.setSelectionRange(pos,pos); }
      }, 280); }; }
    const cw = document.querySelector('.catwrap');
    if (cw) cw.onclick = e => e.stopPropagation();
    if (S.catAberto) document.addEventListener('click', () => {
      S.catAberto = false; S.catLista = []; render();
    }, { once:true });
    document.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const id = b.dataset.toggle;
      if (S.catAbertos.has(id)) { S.catAbertos.delete(id); render(); return; }
      S.catAbertos.add(id);
      await carregarNivelCategoria(id);
      render();
    });
    document.querySelectorAll('[data-cid]').forEach(b => b.onclick = () => {
      S.catSel = { id:b.dataset.cid, nome:b.dataset.cn };
      S.catLista=[]; S.catAberto=false; S.F.p_categoria = b.dataset.cid; render(); contar(); });
    if ($('#catx')) $('#catx').onclick = () => {
      S.catSel=null; delete S.F.p_categoria; render(); contar(); };

    ['f_txt','f_pmin','f_pmax','f_best','f_vmin','f_vmax','f_mov','f_delta','f_top10',
     'f_cmin','f_cmax','f_disp','f_cons','f_caiu','f_vmin_visto','f_vmax_visto','f_omin','f_omax',
     'f_smin','f_smax'].forEach(id => {
      const e = document.getElementById(id); if (!e) return;
      e.addEventListener('change', () => { S.F = lerFiltros(); contar(); });
      e.addEventListener('input', () => { S.F = lerFiltros(); }); });
    document.querySelectorAll('input[name=ofi], input[name=full]').forEach(r =>
      r.addEventListener('change', () => { S.F = lerFiltros(); contar(); }));

    if ($('#f_ord')) $('#f_ord').onchange = () => {
      S.F.p_ordem = $('#f_ord').value; if (S.buscou) buscar(); };

    if ($('#b_tog')) $('#b_tog').onclick = () => { S.filtrosAbertos=!S.filtrosAbertos; render(); };
    if ($('#b_exp')) $('#b_exp').onclick = exportarCsv;
    if ($('#b_lote')) $('#b_lote').onclick = monitorarLote;
    if ($('#b_nada')) $('#b_nada').onclick = () => { S.selecao.clear(); render(); };

    document.querySelectorAll('[data-per]').forEach(b => b.onclick = () => {
      S.periodo = b.dataset.per; render(); });

    document.querySelectorAll('[data-rmf]').forEach(b => b.onclick = () => {
      const k = b.dataset.rmf;
      if (k==='pos'){ delete S.F.p_pos_min; delete S.F.p_pos_max; }
      else if (k==='preco'){ delete S.F.p_preco_min; delete S.F.p_preco_max; }
      else if (k==='conc'){ delete S.F.p_conc_min; delete S.F.p_conc_max; }
      else if (k==='visto'){ delete S.F.p_visto_min; delete S.F.p_visto_max; }
      else if (k==='obs'){ delete S.F.p_dias_min; delete S.F.p_dias_max; }
      else if (k==='vend'){ delete S.F.p_vend_min; delete S.F.p_vend_max; }
      else if (k==='p_categoria'){ S.catSel=null; delete S.F.p_categoria; }
      else if (k==='p_full_max'||k==='p_full_min'){ delete S.F.p_full_max; delete S.F.p_full_min; }
      else delete S.F[k];
      S.pred=null; render(); contar(); });

    document.querySelectorAll('[data-ck]').forEach(c => c.onclick = (ev) => {
      ev.stopPropagation();
      c.checked ? S.selecao.add(c.dataset.ck) : S.selecao.delete(c.dataset.ck);
      render(); });
    if ($('#ck_all')) $('#ck_all').onclick = (ev) => {
      ev.stopPropagation();
      const lim = S.quota?.features?.rows_full;
      const livres = (lim?.unlimited || lim?.limit === -1) ? S.produtos.length : (lim?.limit ?? 5);
      if (ev.target.checked) S.produtos.slice(0,livres).forEach(p => S.selecao.add(p.product_id));
      else S.selecao.clear();
      render(); };

    document.querySelectorAll('tr.k').forEach(tr => tr.onclick = (ev) => {
      if (ev.target.tagName === 'INPUT') return;
      abrir(tr.dataset.p); });
  }
  if (S.view==='categorias' && $('#c_go')) $('#c_go').onclick = cats;
  if (S.view==='categorias') document.querySelectorAll('[data-crec]').forEach(b => b.onclick = () => {
    const c = S.categoriasRecentes.find(x=>x.category_id===b.dataset.crec);
    if (c) { $('#c_txt').value = c.nome; cats(); }
  });
  if (S.view==='categorias') document.querySelectorAll('#cres tr.k[data-cid]').forEach(tr => tr.onclick = () => {
    abrirCategoria(tr.dataset.cid, tr.dataset.cn);
  });
  if (S.view==='catdetalhe' && $('#cd_voltar')) $('#cd_voltar').onclick = () => {
    S.view = 'categorias'; S.catDetalhe = null; S.catDetalheHist = [];
    S.catSel = null; S.F = {}; S.buscou = false; S.produtos = []; render();
  };
  if (S.view==='catdetalhe') wireChartTips();
  if (S.view==='locais'){
    if (!S.locaisCategorias.length) carregarCategoriasLocais().then(render);
    if ($('#l_go')) $('#l_go').onclick = () => { S.locaisOffset = 0; buscarLocais(); };
    if ($('#l_toggle_f')) $('#l_toggle_f').onclick = () => { S.locaisFiltrosAbertos = !S.locaisFiltrosAbertos; render(); };
    document.querySelectorAll('.tb').forEach(b => b.onclick = () => { S.locaisAba = b.dataset.lab; render(); });
    document.querySelectorAll('[data-lcat]').forEach(c => c.onchange = () => {
      c.checked ? S.locaisCatSel.add(c.dataset.lcat) : S.locaisCatSel.delete(c.dataset.lcat);
      S.locaisOffset = 0; buscarLocais();
    });
    document.querySelectorAll('input[name=l_criado]').forEach(r => r.onchange = () => {
      S.locaisCriado = r.value ? Number(r.value) : null; S.locaisOffset = 0; buscarLocais();
    });
    document.querySelectorAll('input[name=l_caixa]').forEach(r => r.onchange = () => {
      const [mn, mx] = r.value.split('|');
      S.locaisCaixaMin = mn ? Number(mn) : null; S.locaisCaixaMax = mx ? Number(mx) : null;
      S.locaisOffset = 0; buscarLocais();
    });
    if ($('#l_marg')) $('#l_marg').onchange = () => { S.locaisOffset = 0; buscarLocais(); };
    if ($('#l_mais')) $('#l_mais').onclick = () => { S.locaisOffset += 60; buscarLocais(true); };
    document.querySelectorAll('[data-lfav]').forEach(b => b.onclick = () => {
      const id = b.dataset.lfav;
      S.locaisFavoritos.has(id) ? S.locaisFavoritos.delete(id) : S.locaisFavoritos.add(id);
      localStorage.setItem('gr_locais_fav', JSON.stringify([...S.locaisFavoritos]));
      render();
    });
    document.querySelectorAll('[data-unl]').forEach(b =>
      b.onclick = () => desbloquear(b.dataset.unl));
    if ($('#l_meli_tog')) $('#l_meli_tog').onclick = () => {
      S.locaisMeliOn = !S.locaisMeliOn; render();
      if (S.locaisMeliOn) buscarMeliParaLocais();
    };
    document.querySelectorAll('[data-labrir]').forEach(img => img.onclick = () => {
      abrirComLocal(img.dataset.labrir, S.locaisMeliCache[img.dataset.lprodid] ?? null, {
        custo: img.dataset.lcusto ? Number(img.dataset.lcusto) : null,
        fornecedor: img.dataset.lforn || null,
        fornecedorId: img.dataset.lfornid || null,
      });
    });
  }
  if (S.view==='diario'){
    if (!S.diarioLoaded) carregarDiario().then(render).catch(() => { S.diarioLoaded = true; render(); });
    document.querySelectorAll('[data-daba]').forEach(b => b.onclick = () => {
      S.diarioAba = b.dataset.daba;
      S.diarioLoaded = false;
      S.diario = [];
      render();
      carregarDiario().then(render).catch(() => { S.diarioLoaded = true; render(); });
    });
    if ($('#d_mais')) $('#d_mais').onclick = () => {
      S.diarioOffset = S.diario.length;
      carregarDiario(true).then(render).catch(() => render());
    };
    document.querySelectorAll('#sheet tr.k[data-p], #sheet [data-p].btn').forEach(el => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        const id = el.dataset.p || el.closest('[data-p]')?.dataset.p;
        if (id) { S.voltaPara = 'diario'; abrir(id); }
      };
    });
  }
  if (S.view==='fornecedores'){
    if (!S.catalogosLoaded && !S.catalogosBusy) carregarCatalogos().then(render);
    wireCatalogos();
  }
  if (S.view==='monitor'){
    document.querySelectorAll('.tb').forEach(b => b.onclick = () => { S.aba=b.dataset.ab; render(); });
    document.querySelectorAll('[data-seg]').forEach(b => b.onclick = async (ev) => {
      ev.stopPropagation(); b.disabled=true; b.textContent='...';
      // A leitura da extensao (vendidos/preco/dias no ar) ja esta no pedido
      // em memoria -- sem isso ir junto, Receita/Vendas ficam sempre "-".
      const pedido = S.pedidos.find(x=>x.produto===b.dataset.seg);
      await seguir(b.dataset.seg, pedido?.snapshot);
      await carregarMonitor(); S.aba='lista'; render(); });
    document.querySelectorAll('[data-rm]').forEach(b => b.onclick = (ev) => { ev.stopPropagation(); largar(b.dataset.rm); });
    document.querySelectorAll('tr.k[data-p]').forEach(tr => tr.onclick = () => {
      if (tr.dataset.p) abrir(tr.dataset.p);
      else if (tr.dataset.url) window.open(tr.dataset.url, '_blank', 'noopener');
    });
    document.querySelectorAll('[data-rmped]').forEach(b => b.onclick = (ev) => { ev.stopPropagation(); removerPedido(b.dataset.rmped); });
    if ($('#lidos')) $('#lidos').onclick = async () => {
      await sb.rpc('marcar_alertas_lidos'); await carregarMonitor(); render(); };
    if ($('#v_busca')){
      $('#v_busca').oninput = (e) => { S.vendBusca = e.target.value; };
      $('#v_busca').addEventListener('keydown', (e) => { if (e.key==='Enter') buscarVendedores(); });
    }
    if ($('#v_ir')) $('#v_ir').onclick = buscarVendedores;
    document.querySelectorAll('[data-vadd]').forEach(b => b.onclick = () => acompanharVendedor(Number(b.dataset.vadd)));
    document.querySelectorAll('[data-vrm]').forEach(b => b.onclick = () => largarVendedor(Number(b.dataset.vrm)));
  }
  if (S.view==='detalhe'){
    if ($('#volta')) $('#volta').onclick = () => {
      if (S.voltaPara === 'alerta' && S.alertaFoco) { S.view = 'alerta'; S.voltaPara = null; render(); return; }
      if (S.voltaPara === 'monitor') { S.view = 'monitor'; S.voltaPara = null; render(); return; }
      if (S.voltaPara === 'diario') { S.view = 'diario'; S.voltaPara = null; render(); return; }
      S.view='produtos'; render();
    };
    if ($('#mon')) $('#mon').onclick = () => {
      const id = S.detalhe.produto.product_id;
      S.monitorados.some(m=>m.product_id===id) ? largar(id) : seguir(id); };
    wireChartTips();
    document.querySelectorAll('[data-dab]').forEach(b => b.onclick = async () => {
      S.detalheAba = b.dataset.dab;
      if (S.detalheAba === 'similares' && !S.similaresCarregado) { await carregarSimilares(); }
      render();
    });
    document.querySelectorAll('tr[data-open]').forEach(tr => tr.onclick = () => window.open(tr.dataset.open, '_blank'));
    document.querySelectorAll('#sheet tr.k[data-p]').forEach(tr => tr.onclick = () => abrir(tr.dataset.p));
    document.querySelectorAll('[data-unl]').forEach(b => b.onclick = () => desbloquear(b.dataset.unl));
  }
  if (S.view==='calc'){
    ['pc_venda','pc_compra','pc_vendas','pc_comissao','pc_taxafixa','pc_taxafixa_v',
     'pc_peso','pc_altura','pc_largura','pc_comprimento','pc_reput','pc_frete',
     'pc_regime','pc_receita','pc_imposto','pc_extra']
      .forEach(id => document.getElementById(id)?.addEventListener('input', calc));
    document.querySelectorAll('input[name=pc_gratis]').forEach(r => r.addEventListener('change', calc));
    document.querySelectorAll('input[name=pc_tipo]').forEach(r => r.addEventListener('change', () => {
      const co = $('#pc_comissao'); if (co) co.value = COMISSAO_PADRAO[r.value] ?? co.value;
      calc();
    }));
    if ($('#pc_faixa')) $('#pc_faixa').onchange = () => {
      const rc = $('#pc_receita'); if (rc) rc.value = $('#pc_faixa').value;
      calc();
    };
    if ($('#pc_calc')) $('#pc_calc').onclick = calc;
    if ($('#pc_limpar')) $('#pc_limpar').onclick = () => { S.calcCats = []; render(); };
    if ($('#pc_salvar')) $('#pc_salvar').onclick = salvarPresetCalc;
    if ($('#pc_aplicar')) $('#pc_aplicar').onclick = aplicarLinkCalc;
    if ($('#pc_cat_addbtn')) $('#pc_cat_addbtn').onclick = () => {
      const el = $('#pc_cat_add'); const v = el?.value.trim();
      if (v) { S.calcCats.push(v); render(); }
    };
    document.querySelectorAll('[data-catdel]').forEach(b => b.onclick = () => {
      S.calcCats.splice(Number(b.dataset.catdel), 1); render(); });
    const presets = presetsCalc();
    document.querySelectorAll('[data-loadp]').forEach(b => b.onclick = () => aplicarPresetCalc(presets[Number(b.dataset.loadp)]));
    document.querySelectorAll('[data-delp]').forEach(b => b.onclick = () => excluirPresetCalc(Number(b.dataset.delp)));
    calc();
  }
  if (S.view==='clipes'){
    document.querySelectorAll('[data-clv]').forEach(b => b.onclick = () => {
      S.clipesVista = b.dataset.clv || null; S.clipesAdd = false; render();
    });
    document.querySelectorAll('[data-cladd]').forEach(b => b.onclick = () => {
      S.clipesAdd = true; render();
      const el = $('#cl_add_ref'); if (el) el.focus();
    });
    document.querySelectorAll('[data-clrm]').forEach(b => b.onclick = () => {
      S.clipesProdutos[S.clipesVista].splice(Number(b.dataset.clrm), 1); render();
    });
    if ($('#cl_add_ok')) $('#cl_add_ok').onclick = adicionarProdutoClipes;
    const clRef = $('#cl_add_ref');
    if (clRef) clRef.addEventListener('keydown', (e) => { if (e.key==='Enter') adicionarProdutoClipes(); });
  }
  if (S.view==='assinatura'){
    if (!S.planos.length) carregarPlanos().then(render);
    if ($('#pl_toggle')) $('#pl_toggle').onclick = () => {
      S.periodoPlano = S.periodoPlano === 'ano' ? 'mes' : 'ano'; render();
    };
    document.querySelectorAll('[data-assinar]').forEach(b => {
      b.onclick = () => iniciarCheckout(b.dataset.assinar);
    });
  }
  window.scrollTo(0,0);
}

document.querySelectorAll('.item,.solo').forEach(b =>
  b.onclick = () => { S.view = b.dataset.v; render();
    if (b.dataset.v === 'categorias') carregarCategoriasRecentes().then(render); });
document.querySelectorAll('.gh').forEach(h => h.onclick = () => {
  document.getElementById(h.dataset.g).classList.toggle('hide');
});

// Seletor Mercado Livre / Shopee (mesmo formato do JoomPulse, estilo Gringa Radar)
$('#mkt_btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  S.mktAberto = !S.mktAberto;
  pintaMarketplace();
});
document.querySelectorAll('#mkt_drop [data-mkt]').forEach(b => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    setMarketplace(b.dataset.mkt);
  });
});
document.addEventListener('click', () => {
  if (!S.mktAberto) return;
  S.mktAberto = false;
  pintaMarketplace();
});
$('#mkt_drop')?.addEventListener('click', (e) => e.stopPropagation());
pintaMarketplace();

// Cliques dos alertas: delegação no #sheet (não depende de rebind a cada render)
$('#sheet')?.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-aexp],[data-aficha]');
  if (!t || !$('#sheet').contains(t)) return;
  ev.preventDefault();
  if (t.hasAttribute('data-aexp')) {
    abrirAlertaPorChave(t.getAttribute('data-aexp'));
    return;
  }
  if (t.hasAttribute('data-aficha')) {
    const pid = t.getAttribute('data-aficha');
    S.voltaPara = 'monitor';
    S.aba = 'alertas';
    abrir(pid);
  }
});

sb.auth.getSession().then(({data}) => {
  if (data.session){ $('#gate').classList.add('hide'); $('#app').classList.remove('hide'); boot(); }
});
