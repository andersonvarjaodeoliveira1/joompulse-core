/**
 * "Encontrado no MeLi" em Produtos locais: dado o nome de um produto do
 * fornecedor local, procura o correspondente real no catálogo do
 * Mercado Livre e devolve preço mediano real dos concorrentes.
 *
 * Achado ao vivo em 28/07/2026: /sites/{site}/search (busca de anúncio)
 * dá 403 pra terceiro — é o mesmo bloqueio de sempre. Mas
 * /products/search (busca de PRODUTO DE CATÁLOGO por texto) funciona
 * normalmente pra terceiro, testado com resultado real. É essa rota que
 * esta função usa — nunca /sites/{site}/search.
 *
 * Sem cache: cada chamada é uma busca nova. Se o volume crescer, cachear
 * por texto normalizado por alguns dias é o próximo passo óbvio.
 *
 * Mesma trava de token de collector/src/auth.ts e ml-preco/index.ts —
 * ver comentário lá pra por que é obrigatória.
 *
 * Deploy: supabase functions deploy ml-busca-catalogo
 */
import postgres from 'https://esm.sh/postgres@3.4.4';
import { requireUser, requireQuota, requireRateLimit } from '../_shared/auth.ts';

const API = 'https://api.mercadolibre.com';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2 });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

interface TokenResponse {
  access_token: string; refresh_token: string; expires_in: number; scope: string; user_id: number;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/oauth/token ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as TokenResponse;
}

/** Cópia fiel de collector/src/auth.ts::accessToken — mesma trava, mesma tabela. */
async function accessToken(): Promise<string> {
  const clientId = Deno.env.get('ML_CLIENT_ID')!;
  const clientSecret = Deno.env.get('ML_CLIENT_SECRET')!;

  const [row0] = await sql<{ access_token: string | null; expires_at: Date | null }[]>`
    select access_token, expires_at from ml_credentials where id = 1
  `;
  if (!row0?.access_token) throw new Error('nenhuma credencial de ML gravada');
  if (row0.expires_at && row0.expires_at.getTime() > Date.now() + 5 * 60_000) {
    return row0.access_token;
  }

  return sql.begin(async (tx) => {
    const [row] = await tx<
      { access_token: string | null; refresh_token: string | null; expires_at: Date | null }[]
    >`select access_token, refresh_token, expires_at from ml_credentials where id = 1 for update`;

    if (!row?.refresh_token) throw new Error('sem refresh_token gravado');
    if (row.access_token && row.expires_at && row.expires_at.getTime() > Date.now() + 5 * 60_000) {
      return row.access_token;
    }

    const t = await postToken({
      grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret,
      refresh_token: row.refresh_token,
    });

    await tx`
      update ml_credentials set
        access_token = ${t.access_token}, refresh_token = ${t.refresh_token},
        expires_at = now() + make_interval(secs => ${t.expires_in}),
        scope = ${t.scope ?? null}, last_refresh = now(),
        refresh_count = refresh_count + 1, updated_at = now()
      where id = 1
    `;
    return t.access_token;
  });
}

async function mlGet(path: string, token: string) {
  return fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
}

async function precoMediano(id: string, token: string): Promise<number | null> {
  const rProd = await mlGet(`/products/${id}`, token);
  if (rProd.ok) {
    const p = await rProd.json();
    if (p.buy_box_winner?.price != null) return p.buy_box_winner.price;
  }
  const rItens = await mlGet(`/products/${id}/items?limit=20`, token);
  if (!rItens.ok) return null;
  const d = await rItens.json();
  const precos = (d.results ?? [])
    .map((x: { price?: number }) => x.price)
    .filter((v: unknown): v is number => typeof v === 'number')
    .sort((a: number, b: number) => a - b);
  return precos.length ? precos[Math.floor(precos.length / 2)] : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, erro: 'method_not_allowed' }, 405);

  const gate = await requireUser(req);
  if (!gate.ok) return json(gate.body, gate.status);
  const rl = await requireRateLimit(gate.sb, 'ml-busca-catalogo', 20, 60);
  if (!rl.ok) return json(rl.body, rl.status);
  const q = await requireQuota(gate.sb, 'product_search');
  if (!q.ok) return json(q.body);

  let texto: string | undefined;
  try { ({ texto } = await req.json()); } catch { return json({ ok: false, erro: 'corpo_invalido' }, 400); }
  texto = texto?.trim();
  if (!texto || texto.length < 3) return json({ ok: false, erro: 'texto_curto' }, 200);

  let token: string;
  try { token = await accessToken(); }
  catch (e) { return json({ ok: false, erro: 'sem_credencial', detalhe: String(e) }, 200); }

  try {
    const rBusca = await mlGet(`/products/search?q=${encodeURIComponent(texto)}&site_id=MLB&limit=1`, token);
    if (!rBusca.ok) return json({ ok: false, erro: 'busca_falhou', status: rBusca.status }, 200);
    const busca = await rBusca.json();
    const top = busca.results?.[0];
    if (!top?.id) return json({ ok: true, encontrado: false }, 200);

    const rProd = await mlGet(`/products/${top.id}`, token);
    const p = rProd.ok ? await rProd.json() : null;
    const preco = await precoMediano(top.id, token);

    return json({
      ok: true, encontrado: true,
      catalog_product_id: top.id,
      nome: p?.name ?? top.name ?? null,
      imagem: p?.pictures?.[0]?.url ?? null,
      permalink: p?.permalink ?? null,
      preco_mediano: preco,
    });
  } catch (e) {
    return json({ ok: false, erro: 'falha_ml', detalhe: String(e) }, 200);
  }
});
