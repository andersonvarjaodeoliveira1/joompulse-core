/**
 * Popup da extensão — login + checagem de assinatura ativa no banco.
 *
 * Fluxo: Auth (e-mail/senha) → RPC status_assinatura() →
 *   ativa  → guarda sessão e libera
 *   inativa → apaga sessão e mostra tela pedindo upgrade
 *
 * Painel web (criar conta / planos):
 *   https://andersonvarjaodeoliveira1.github.io/joompulse-core/
 */
const URL_BASE = 'https://blnupzfgfhvykrgmvwhw.supabase.co';
const CHAVE = 'sb_publishable_gabCC-2dHNLezVN4VmyCJA_sONtVPg8';
const PAINEL = 'https://andersonvarjaodeoliveira1.github.io/joompulse-core/app/';
const area = document.getElementById('area');

const MOTIVO = {
  sem_assinatura: 'Nenhuma assinatura ativa nesta conta.',
  trial_expirado: 'Seu período de teste acabou.',
  pagamento_pendente: 'Pagamento pendente — regularize a assinatura.',
  cancelada: 'Assinatura cancelada.',
  sem_perfil: 'Conta sem perfil. Entre no painel e tente de novo.',
  nao_autenticado: 'Faça login de novo.',
};

function esc(s) {
  return String(s ?? '').replace(/[<>&"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
  }[c]));
}

async function rpcComToken(token, nome, corpo = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: {
      apikey: CHAVE,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(corpo),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(txt.slice(0, 200) || 'falha na consulta');
  return JSON.parse(txt);
}

function telaLogin(erro, tipo = 'err') {
  area.innerHTML = `
    <span class="tag">EXTENSÃO</span>
    <h1>Entrar na sua conta</h1>
    <p class="lead">Use o mesmo e-mail e senha do painel. Só contas com
      assinatura ativa (ou trial) liberam os dados na página do Mercado Livre.</p>
    <label for="e">E-mail</label>
    <input id="e" type="email" autocomplete="username" placeholder="voce@email.com">
    <label for="s">Senha</label>
    <input id="s" type="password" autocomplete="current-password" placeholder="••••••••">
    <button id="b">Entrar</button>
    ${erro ? `<div class="msg ${tipo}">${esc(erro)}</div>` : ''}
    <div class="linha"></div>
    <p class="dica">Ainda não tem conta?
      <a href="${PAINEL}" target="_blank" rel="noopener">Criar no painel</a><br>
      Sem assinatura?
      <a href="${PAINEL}" target="_blank" rel="noopener">Ver planos</a></p>`;
  document.getElementById('b').onclick = entrar;
  document.getElementById('s').onkeydown = (ev) => { if (ev.key === 'Enter') entrar(); };
}

async function entrar() {
  const email = document.getElementById('e').value.trim();
  const senha = document.getElementById('s').value;
  const b = document.getElementById('b');
  if (!email || !senha) {
    telaLogin('Informe e-mail e senha.');
    return;
  }
  b.disabled = true; b.textContent = 'verificando…';

  try {
    const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: CHAVE, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: senha }),
    });
    const j = await r.json();
    if (!r.ok) {
      telaLogin(j.error_description || j.msg || 'E-mail ou senha incorretos.');
      return;
    }

    const status = await rpcComToken(j.access_token, 'status_assinatura');
    if (!status?.ativa) {
      await chrome.storage.local.remove('sessao');
      const msg = MOTIVO[status?.motivo] || 'Assinatura inativa nesta conta.';
      telaLogin(`${msg} Entre no painel, escolha um plano e volte aqui.`, 'warn');
      return;
    }

    await chrome.storage.local.set({
      sessao: {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expira_em: Date.now() + (j.expires_in ?? 3600) * 1000,
        email,
        plan: status.plan,
        assinatura: status,
      },
    });
    telaLogado(email, status);
  } catch (e) {
    telaLogin(e.message || 'Não foi possível entrar. Tente de novo.');
  }
}

function telaLogado(email, status) {
  const plan = status?.plan || '—';
  const motivo = status?.motivo || 'active';
  area.innerHTML = `
    <span class="tag">CONECTADO</span>
    <div class="quem">Logado como<br><b>${esc(email)}</b></div>
    <span class="chip">Assinatura ativa · ${esc(plan)}</span>
    <div class="msg ok">Abra um produto no Mercado Livre — o painel aparece na página.</div>
    <p class="dica" style="margin-top:8px">Status: ${esc(motivo)}.
      <a href="${PAINEL}" target="_blank" rel="noopener">Abrir painel</a></p>
    <button class="g" id="sair">Sair</button>`;
  document.getElementById('sair').onclick = async () => {
    await chrome.storage.local.remove('sessao');
    telaLogin();
  };
}

function telaSemAssinatura(email, status) {
  area.innerHTML = `
    <span class="tag">BLOQUEADO</span>
    <h1>Assinatura necessária</h1>
    <p class="lead">A conta <b>${esc(email || '')}</b> entrou, mas não tem assinatura ativa no banco.</p>
    <span class="chip off">${esc(MOTIVO[status?.motivo] || 'sem_assinatura')}</span>
    <a href="${PAINEL}" target="_blank" rel="noopener">
      <button type="button" style="margin-top:14px">Ver planos no painel</button>
    </a>
    <button class="g" id="outra">Entrar com outra conta</button>`;
  document.getElementById('outra').onclick = async () => {
    await chrome.storage.local.remove('sessao');
    telaLogin();
  };
}

async function boot() {
  const { sessao } = await chrome.storage.local.get('sessao');
  if (!sessao?.access_token) {
    telaLogin();
    return;
  }
  try {
    // Revalida assinatura a cada abertura do popup
    let token = sessao.access_token;
    if (Date.now() > (sessao.expira_em ?? 0) - 60_000) {
      const rr = await fetch(`${URL_BASE}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: CHAVE, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: sessao.refresh_token }),
      });
      if (!rr.ok) {
        await chrome.storage.local.remove('sessao');
        telaLogin('Sessão expirada. Entre de novo.');
        return;
      }
      const nova = await rr.json();
      token = nova.access_token;
      sessao.access_token = nova.access_token;
      sessao.refresh_token = nova.refresh_token;
      sessao.expira_em = Date.now() + (nova.expires_in ?? 3600) * 1000;
    }
    const status = await rpcComToken(token, 'status_assinatura');
    sessao.assinatura = status;
    sessao.plan = status.plan;
    if (!status?.ativa) {
      await chrome.storage.local.remove('sessao');
      telaSemAssinatura(sessao.email, status);
      return;
    }
    await chrome.storage.local.set({ sessao });
    telaLogado(sessao.email, status);
  } catch {
    telaLogado(sessao.email, sessao.assinatura || { plan: sessao.plan, motivo: '—' });
  }
}

boot();
