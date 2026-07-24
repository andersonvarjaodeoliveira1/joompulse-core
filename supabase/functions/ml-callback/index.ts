/**
 * Ponto de retorno do OAuth do Mercado Livre.
 *
 * Resolve o problema de não ter domínio: o Supabase já te dá uma URL
 * https, e esta função vira a redirect URI da aplicação.
 *
 * Também resolve um problema pior. O authorization_code do ML expira em
 * poucos minutos, então copiar da barra de endereços e colar no terminal
 * é uma corrida contra o relógio. Aqui a troca acontece no servidor, no
 * mesmo segundo em que o ML redireciona.
 *
 * Deploy (o --no-verify-jwt é obrigatório: o ML redireciona sem token):
 *
 *   supabase functions deploy ml-callback --no-verify-jwt
 *
 *   supabase secrets set ML_CLIENT_ID=5716684925480652
 *   supabase secrets set ML_CLIENT_SECRET=sua-chave-nova
 *   supabase secrets set ML_REDIRECT_URI=https://<ref>.supabase.co/functions/v1/ml-callback
 *   supabase secrets set ML_AUTH_STATE=uma-frase-aleatoria-longa
 *
 * SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já vêm injetadas.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const API = 'https://api.mercadolibre.com';

function page(title: string, body: string, ok: boolean) {
  return new Response(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${title}</title>
     <div style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:14vh auto;padding:0 1.5rem;color:#14171C">
       <div style="width:10px;height:10px;border-radius:50%;background:${ok ? '#186B44' : '#A8331D'};margin-bottom:1.2rem"></div>
       <h1 style="font-size:1.35rem;font-weight:600;margin:0 0 .6rem;letter-spacing:-.02em">${title}</h1>
       <div style="color:#3A414C">${body}</div>
     </div>`,
    { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return page(
      'Autorização recusada',
      `O Mercado Livre devolveu <code>${oauthError}</code>. Você pode fechar esta aba e tentar de novo.`,
      false,
    );
  }

  // O state é um segredo compartilhado entre o CLI e esta função. Sem
  // ele qualquer pessoa que descobrisse a URL poderia disparar uma troca
  // de código aqui. É a proteção padrão de CSRF do OAuth.
  const expectedState = Deno.env.get('ML_AUTH_STATE');
  if (expectedState && state !== expectedState) {
    return page('Requisição não reconhecida', 'O parâmetro <code>state</code> não confere.', false);
  }

  if (!code) {
    return page('Faltou o código', 'A URL não trouxe o parâmetro <code>code</code>.', false);
  }

  const clientId = Deno.env.get('ML_CLIENT_ID');
  const clientSecret = Deno.env.get('ML_CLIENT_SECRET');
  const redirectUri = Deno.env.get('ML_REDIRECT_URI');

  if (!clientId || !clientSecret || !redirectUri) {
    return page(
      'Função mal configurada',
      'Faltam segredos. Rode <code>supabase secrets set</code> para ML_CLIENT_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI.',
      false,
    );
  }

  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    // invalid_grant aqui quase sempre é redirect URI diferente da
    // cadastrada no painel, ou código já usado/expirado.
    return page(
      'A troca falhou',
      `O Mercado Livre respondeu ${res.status}:<pre style="white-space:pre-wrap;font-size:.85rem;background:#F5F6F8;padding:.7rem;border-radius:4px">${
        text.slice(0, 400).replace(/</g, '&lt;')
      }</pre>
      <p>Se for <code>invalid_grant</code>, confira se a redirect URI cadastrada no painel do ML é idêntica a <code>${redirectUri}</code>.</p>`,
      false,
    );
  }

  const t = JSON.parse(text);

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error } = await db.from('ml_credentials').upsert({
    id: 1,
    client_id: clientId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    scope: t.scope ?? null,
    ml_user_id: t.user_id ?? null,
    last_refresh: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return page(
      'Token obtido, mas não gravado',
      `O banco recusou: <code>${error.message}</code>. Confira se você rodou <code>004_ml_credentials.sql</code>.`,
      false,
    );
  }

  return page(
    'Aplicação autorizada',
    `Conta <b>${t.user_id}</b> conectada, escopos <code>${t.scope}</code>.
     O token foi gravado e passa a se renovar sozinho.
     <p style="margin-top:1.4rem">Pode fechar esta aba e voltar ao terminal:</p>
     <pre style="background:#F5F6F8;padding:.7rem;border-radius:4px;font-size:.85rem">npm run collect auth-status
npm run collect seed</pre>`,
    true,
  );
});
