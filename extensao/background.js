/**
 * Service worker da extensão.
 *
 * Existe por um motivo de segurança: o token do usuário NUNCA entra na
 * página do Mercado Livre. O content script só pede dados por mensagem;
 * quem guarda o token e fala com o Supabase é este arquivo, que roda
 * num contexto isolado da página.
 *
 * Se o token vivesse no content script, qualquer script do próprio
 * Mercado Livre poderia lê-lo do contexto compartilhado.
 */
const URL_BASE = 'https://blnupzfgfhvykrgmvwhw.supabase.co';
const CHAVE = 'sb_publishable_gabCC-2dHNLezVN4VmyCJA_sONtVPg8';

async function sessao() {
  const { sessao } = await chrome.storage.local.get('sessao');
  return sessao ?? null;
}

/** Renova o access_token quando expira, usando o refresh_token guardado. */
async function renovar(s) {
  const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: CHAVE, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  if (!r.ok) { await chrome.storage.local.remove('sessao'); return null; }
  const nova = await r.json();
  const guardar = {
    access_token: nova.access_token,
    refresh_token: nova.refresh_token,
    expira_em: Date.now() + (nova.expires_in ?? 3600) * 1000,
    email: s.email,
  };
  await chrome.storage.local.set({ sessao: guardar });
  return guardar;
}

async function tokenValido() {
  let s = await sessao();
  if (!s) return null;
  if (Date.now() > (s.expira_em ?? 0) - 60_000) s = await renovar(s);
  return s?.access_token ?? null;
}

async function rpc(nome, corpo) {
  const token = await tokenValido();
  if (!token) return { erro: 'sem_sessao' };

  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: {
      apikey: CHAVE,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(corpo ?? {}),
  });

  const txt = await r.text();
  if (!r.ok) return { erro: 'falhou', status: r.status, detalhe: txt.slice(0, 300) };
  try { return { dados: JSON.parse(txt) }; } catch { return { dados: txt }; }
}


async function rest({ metodo, tabela, query, corpo, prefer }) {
  const token = await tokenValido();
  const url = `${URL_BASE}/rest/v1/${tabela}${query ? '?' + query : ''}`;
  const headers = { apikey: CHAVE, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (prefer) headers.prefer = prefer;
  const r = await fetch(url, { method: metodo ?? 'GET', headers, body: corpo ? JSON.stringify(corpo) : undefined });
  const txt = await r.text();
  try { return { dados: JSON.parse(txt) }; } catch { return { dados: txt }; }
}

chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
  if (msg.tipo === 'rpc') {
    rpc(msg.nome, msg.corpo).then(responder);
    return true;   // resposta assíncrona
  }
  if (msg.tipo === 'rest') {
    rest(msg).then(responder);
    return true;
  }
  if (msg.tipo === 'sessao') {
    sessao().then((s) => responder({ logado: !!s, email: s?.email ?? null }));
    return true;
  }
});
