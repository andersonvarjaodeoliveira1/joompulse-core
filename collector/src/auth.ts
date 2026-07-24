/**
 * OAuth do Mercado Livre.
 *
 * O ML aceita apenas dois grants: authorization_code e refresh_token.
 * Não existe client_credentials — a aplicação sempre age em nome de uma
 * conta que autorizou pelo navegador.
 *
 * Fluxo, uma vez só:
 *   1. npm run collect auth-url        -> abre no navegador, autoriza
 *   2. npm run collect auth-code TG-x  -> troca o code por tokens
 *
 * Depois disso a renovação é automática. O access_token dura 6 horas.
 *
 * REGRA QUE NÃO PODE SER QUEBRADA: o refresh_token é de uso único.
 * Cada renovação devolve um novo e invalida o anterior. Por isso toda
 * renovação acontece dentro de uma transação com FOR UPDATE.
 */
import { sql } from './db.js';

const API = 'https://api.mercadolibre.com';

const AUTH_HOST: Record<string, string> = {
  MLB: 'https://auth.mercadolivre.com.br',
  MLA: 'https://auth.mercadolibre.com.ar',
  MLM: 'https://auth.mercadolibre.com.mx',
  MLC: 'https://auth.mercadolibre.cl',
  MCO: 'https://auth.mercadolibre.com.co',
};

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  user_id: number;
  token_type: string;
}

function env() {
  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  const redirectUri = process.env.ML_REDIRECT_URI;
  const siteId = process.env.ML_SITE_ID ?? 'MLB';
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Faltam ML_CLIENT_ID, ML_CLIENT_SECRET ou ML_REDIRECT_URI no .env');
  }
  return { clientId, clientSecret, redirectUri, siteId };
}

/**
 * Escopos pedidos: apenas read e offline_access.
 *
 * NÃO peça 'write'. O coletor só lê dados públicos de mercado; pedir
 * permissão de escrita na conta de alguém é desnecessário e derruba a
 * confiança de quem for autorizar seu app depois.
 */
export function authorizationUrl(): string {
  const { clientId, redirectUri, siteId } = env();
  const host = AUTH_HOST[siteId] ?? AUTH_HOST.MLB;
  const u = new URL(`${host}/authorization`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'offline_access read');

  // Segredo compartilhado com a Edge Function de retorno. Impede que
  // alguém que descubra a URL de callback dispare uma troca de código
  // por lá. É a proteção padrão de CSRF do OAuth.
  const state = process.env.ML_AUTH_STATE;
  if (state) u.searchParams.set('state', state);

  return u.toString();
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`/oauth/token ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as TokenResponse;
}

async function store(t: TokenResponse, clientId: string, bump: boolean) {
  await sql`
    insert into ml_credentials
      (id, client_id, access_token, refresh_token, expires_at, scope,
       ml_user_id, last_refresh, refresh_count, updated_at)
    values (
      1, ${clientId}, ${t.access_token}, ${t.refresh_token},
      now() + make_interval(secs => ${t.expires_in}),
      ${t.scope ?? null}, ${t.user_id ?? null}, now(), ${bump ? 1 : 0}, now()
    )
    on conflict (id) do update set
      client_id = excluded.client_id,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      scope = excluded.scope,
      ml_user_id = excluded.ml_user_id,
      last_refresh = now(),
      refresh_count = ml_credentials.refresh_count + ${bump ? 1 : 0},
      updated_at = now()
  `;
}

/** Passo único de instalação: troca o code da URL de retorno por tokens. */
export async function exchangeCode(code: string) {
  const { clientId, clientSecret, redirectUri } = env();
  const t = await postToken({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  await store(t, clientId, false);
  return t;
}

/**
 * Devolve um access_token válido.
 *
 * Se ainda faltam mais de 5 minutos para expirar, usa o que está no
 * banco sem tocar na rede — a documentação do ML recomenda renovar só
 * quando o token realmente perde validade.
 *
 * Se precisa renovar, entra numa transação, trava a linha e RECONSULTA.
 * Essa segunda checagem é o que impede dois workers de queimarem o
 * refresh_token: quem chega depois encontra o token já renovado.
 */
export async function accessToken(force = false): Promise<string> {
  const { clientId, clientSecret } = env();

  if (!force) {
    const [row] = await sql<{ access_token: string | null; expires_at: Date | null }[]>`
      select access_token, expires_at from ml_credentials where id = 1
    `;
    if (!row?.access_token) {
      throw new Error(
        'Nenhuma credencial gravada. Rode: npm run collect auth-url',
      );
    }
    if (row.expires_at && row.expires_at.getTime() > Date.now() + 5 * 60_000) {
      return row.access_token;
    }
  }

  return sql.begin(async (tx) => {
    const [row] = await tx<
      { access_token: string | null; refresh_token: string | null; expires_at: Date | null }[]
    >`select access_token, refresh_token, expires_at
        from ml_credentials where id = 1 for update`;

    if (!row?.refresh_token) {
      throw new Error('Sem refresh_token. Refaça a autorização: npm run collect auth-url');
    }

    // Outro worker pode ter renovado enquanto esperávamos a trava.
    if (
      !force &&
      row.access_token &&
      row.expires_at &&
      row.expires_at.getTime() > Date.now() + 5 * 60_000
    ) {
      return row.access_token;
    }

    const t = await postToken({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: row.refresh_token,
    });

    await tx`
      update ml_credentials set
        access_token = ${t.access_token},
        refresh_token = ${t.refresh_token},
        expires_at = now() + make_interval(secs => ${t.expires_in}),
        scope = ${t.scope ?? null},
        last_refresh = now(),
        refresh_count = refresh_count + 1,
        updated_at = now()
      where id = 1
    `;
    return t.access_token;
  });
}

export async function credentialStatus() {
  const [row] = await sql<
    {
      ml_user_id: number | null;
      scope: string | null;
      expires_at: Date | null;
      last_refresh: Date | null;
      refresh_count: number;
    }[]
  >`select ml_user_id, scope, expires_at, last_refresh, refresh_count
      from ml_credentials where id = 1`;
  return row ?? null;
}
