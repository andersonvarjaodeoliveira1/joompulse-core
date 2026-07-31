/**
 * Busca preço ao vivo no Mercado Livre pra um link/código que ainda não
 * está na nossa base — usado pelo botão "Aplicar" da Calculadora.
 *
 * Por que existe: ficha_produto()/buscar_por_referencia() só respondem
 * pro que já foi coletado. Um produto novo, nunca visto, dava "não está
 * na nossa base" mesmo sendo um link válido do ML. Esta função consulta
 * a API ao vivo, sem depender de já ter passado pela coleta.
 *
 * Só cobre o que a API do ML ainda permite pra terceiro:
 *   /products/{id}         -> funciona sempre (ficha de catálogo)
 *   /items?ids=  (fallback) -> testado ao vivo em 25/07/2026, dá 403
 *                              pra a maioria dos anúncios de terceiro.
 *                              Mantido porque já mudou de comportamento
 *                              sem aviso antes (ver README, seção 403).
 * Link de anúncio direto de outro vendedor (não-catálogo) tende a cair
 * no bloqueio — a extensão, lendo a página, é o caminho que sempre
 * funciona pra esses.
 *
 * Deploy:
 *   supabase functions deploy ml-preco
 *
 * Usa SUPABASE_DB_URL, que já vem injetada por padrão em toda Edge
 * Function do projeto — não precisa de segredo novo.
 *
 * JWT verification fica LIGADA (sem --no-verify-jwt): só usuário
 * logado no app pode gastar chamada da nossa credencial do ML.
 *
 * A renovação do token é uma cópia fiel de collector/src/auth.ts —
 * MESMA trava (transação com FOR UPDATE em ml_credentials). O
 * refresh_token do ML é de uso único; se este processo e o coletor
 * renovarem ao mesmo tempo sem a mesma trava, um queima a credencial
 * da aplicação inteira. Qualquer mudança aqui tem que manter isso.
 */
import postgres from 'https://esm.sh/postgres@3.4.4';

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
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  user_id: number;
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

    // Outro processo (o coletor, por exemplo) pode ter renovado
    // enquanto esperávamos a trava.
    if (row.access_token && row.expires_at && row.expires_at.getTime() > Date.now() + 5 * 60_000) {
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

/** Mesma extração de buscar_por_referencia() (SQL), pra aceitar link ou código solto. */
function extrairMlb(ref: string): string | null {
  let m = ref.match(/\/p\/(MLB\d+)/i);
  if (m) return m[1].toUpperCase();
  m = ref.match(/MLB-?(\d{8,})/i);
  if (m) return `MLB${m[1]}`;
  return null;
}

async function mlGet(path: string, token: string) {
  return fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, erro: 'method_not_allowed' }, 405);

  let ref: string | undefined;
  try {
    ({ ref } = await req.json());
  } catch {
    return json({ ok: false, erro: 'corpo_invalido' }, 400);
  }

  const mlb = extrairMlb(ref?.trim() ?? '');
  if (!mlb) return json({ ok: false, erro: 'nao_reconhecido' }, 200);

  let token: string;
  try {
    token = await accessToken();
  } catch (e) {
    return json({ ok: false, erro: 'sem_credencial', detalhe: String(e) }, 200);
  }

  try {
    // 1) Produto de catálogo direto (/p/MLB…)
    const rProd = await mlGet(`/products/${mlb}`, token);
    if (rProd.ok) {
      const p = await rProd.json();
      let preco = p.buy_box_winner?.price ?? null;
      let anuncios: number | null = null;

      if (preco == null) {
        const rItens = await mlGet(`/products/${mlb}/items?limit=20`, token);
        if (rItens.ok) {
          const d = await rItens.json();
          anuncios = typeof d.paging?.total === 'number' ? d.paging.total : (d.results?.length ?? null);
          const precos = (d.results ?? [])
            .map((x: { price?: number }) => x.price)
            .filter((v: unknown): v is number => typeof v === 'number')
            .sort((a: number, b: number) => a - b);
          if (precos.length) preco = precos[Math.floor(precos.length / 2)];
        }
      }

      return json({
        ok: true, tipo: 'produto', id: p.id, nome: p.name ?? null,
        preco,
        imagem: p.pictures?.[0]?.url ?? null,
        permalink: p.permalink ?? null,
        categoria: p.category_id ?? null,
        anuncios,
        na_base: false,
      });
    }

    // 2) Anúncio (item): tenta /items/{id} (mais confiável que ?ids=) e segue
    //    o catalog_product_id quando existir.
    const rItemOne = await mlGet(`/items/${mlb}`, token);
    if (rItemOne.ok) {
      const it = await rItemOne.json();
      const catId = typeof it.catalog_product_id === 'string' ? it.catalog_product_id : null;

      if (catId) {
        const rCat = await mlGet(`/products/${catId}`, token);
        if (rCat.ok) {
          const p = await rCat.json();
          return json({
            ok: true, tipo: 'produto', id: p.id, nome: p.name ?? it.title ?? null,
            preco: p.buy_box_winner?.price ?? it.price ?? null,
            imagem: p.pictures?.[0]?.url ?? it.thumbnail ?? null,
            permalink: p.permalink ?? it.permalink ?? null,
            categoria: p.category_id ?? it.category_id ?? null,
            mlb_anuncio: mlb,
            na_base: false,
          });
        }
      }

      return json({
        ok: true, tipo: 'item', id: it.id, nome: it.title ?? null,
        preco: it.price ?? null,
        imagem: it.thumbnail ?? it.secure_thumbnail ?? null,
        permalink: it.permalink ?? null,
        categoria: it.category_id ?? null,
        catalog_product_id: catId,
        na_base: false,
      });
    }

    // 3) Fallback legado ?ids= (às vezes ainda responde)
    const rItem = await mlGet(`/items?ids=${mlb}`, token);
    if (rItem.ok) {
      const arr = await rItem.json();
      const entry = Array.isArray(arr) ? arr[0] : null;
      if (entry?.code === 200 && entry.body) {
        const it = entry.body;
        return json({
          ok: true, tipo: 'item', id: it.id, nome: it.title ?? null,
          preco: it.price ?? null,
          imagem: it.thumbnail ?? it.secure_thumbnail ?? null,
          permalink: it.permalink ?? null,
          categoria: it.category_id ?? null,
          catalog_product_id: it.catalog_product_id ?? null,
          na_base: false,
        });
      }
    }

    return json({ ok: false, erro: 'bloqueado_ou_nao_encontrado', mlb }, 200);
  } catch (e) {
    return json({ ok: false, erro: 'falha_ml', detalhe: String(e) }, 200);
  }
});
