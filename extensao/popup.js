const URL_BASE = 'https://blnupzfgfhvykrgmvwhw.supabase.co';
const CHAVE = 'sb_publishable_gabCC-2dHNLezVN4VmyCJA_sONtVPg8';
const area = document.getElementById('area');

function telaLogin(erro) {
  area.innerHTML = `
    <label for="e">E-mail</label><input id="e" type="email" autocomplete="username">
    <label for="s">Senha</label><input id="s" type="password" autocomplete="current-password">
    <button id="b">Entrar</button>
    ${erro ? `<div class="msg err">${erro}</div>` : ''}
    <p class="dica">Use a mesma conta do painel. Depois de entrar, abra
      qualquer produto no Mercado Livre e o painel aparece na lateral.</p>`;
  document.getElementById('b').onclick = entrar;
  document.getElementById('s').onkeydown = (ev) => { if (ev.key === 'Enter') entrar(); };
}

async function entrar() {
  const email = document.getElementById('e').value.trim();
  const senha = document.getElementById('s').value;
  const b = document.getElementById('b');
  b.disabled = true; b.textContent = 'entrando…';

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
  await chrome.storage.local.set({ sessao: {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expira_em: Date.now() + (j.expires_in ?? 3600) * 1000,
    email,
  }});
  telaLogado(email);
}

function telaLogado(email) {
  area.innerHTML = `
    <div class="quem">Conectado como<br><b>${email}</b></div>
    <div class="msg ok">Abra um produto no Mercado Livre — o painel aparece na lateral direita.</div>
    <button class="g" id="sair">Sair</button>`;
  document.getElementById('sair').onclick = async () => {
    await chrome.storage.local.remove('sessao');
    telaLogin();
  };
}

chrome.runtime.sendMessage({ tipo: 'sessao' }, (s) => {
  if (s?.logado) telaLogado(s.email); else telaLogin();
});
