/**
 * Cliente da API do Mercado Livre.
 *
 * Três coisas que fazem esse arquivo existir:
 *  1. Rate limit. Estourar o limite do ML derruba sua coleta por horas.
 *     O token bucket abaixo garante que você nunca passa do teto.
 *  2. Retry. 429 e 5xx acontecem sempre. Backoff exponencial resolve.
 *  3. Renovação de token no 401.
 *
 * A autenticação em si mora em auth.ts. O ML não suporta
 * client_credentials — só authorization_code e refresh_token — e o
 * refresh_token é de uso único, então a renovação precisa de trava no
 * banco. Este arquivo só recebe uma função getToken() e a usa.
 */

const API = 'https://api.mercadolibre.com';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Balde de tokens: capacidade N, reposição R por segundo. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
  }

  async take(n = 1): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((now - this.last) / 1000) * this.refillPerSec,
      );
      this.last = now;

      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      await sleep(Math.max(((n - this.tokens) / this.refillPerSec) * 1000, 25));
    }
  }
}

export interface MlClientOptions {
  /** Devolve um access_token válido. Ver auth.ts — a renovação é travada no banco. */
  getToken: (force?: boolean) => Promise<string>;
  siteId?: string;
  /** Requisições por segundo. Comece conservador: 8. */
  ratePerSec?: number;
  maxRetries?: number;
}

export class MlClient {
  private bucket: TokenBucket;
  public callCount = 0;
  public readonly siteId: string;

  constructor(private opts: MlClientOptions) {
    const rate = opts.ratePerSec ?? 8;
    this.bucket = new TokenBucket(rate * 2, rate);
    this.siteId = opts.siteId ?? 'MLB';
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const maxRetries = this.opts.maxRetries ?? 5;
    let forceToken = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.bucket.take();
      const token = await this.opts.getToken(forceToken);
      forceToken = false;
      this.callCount++;

      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });

      if (res.ok) return (await res.json()) as T;

      // Token expirou antes da hora (revogação, troca de senha na conta).
      // Força uma renovação e tenta de novo.
      if (res.status === 401) {
        forceToken = true;
        if (attempt < maxRetries) continue;
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 500 + Math.random() * 300, 30_000);
        if (attempt < maxRetries) {
          await sleep(wait);
          continue;
        }
      }

      if (res.status === 404) throw new NotFoundError(url.pathname);

      throw new Error(`GET ${url.pathname} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    throw new Error(`GET ${url.pathname}: esgotou as tentativas`);
  }

  // ---------- endpoints ----------

  categoriesRoot() {
    return this.get<Array<{ id: string; name: string }>>(`/sites/${this.siteId}/categories`);
  }

  category(id: string) {
    return this.get<MlCategory>(`/categories/${id}`);
  }

  /**
   * Busca por categoria. O ML limita offset a 1000 — não adianta paginar
   * além disso. Para varrer uma categoria grande, desça para as
   * subcategorias folha em vez de tentar puxar tudo pelo pai.
   */
  search(params: {
    category?: string;
    q?: string;
    seller_id?: number;
    offset?: number;
    limit?: number;
    sort?: string;
  }) {
    return this.get<MlSearchResponse>(`/sites/${this.siteId}/search`, {
      ...params,
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    });
  }

  /** Multiget: no máximo 20 ids por chamada. */
  async itemsMulti(ids: string[]): Promise<MlItem[]> {
    const out: MlItem[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const res = await this.get<Array<{ code: number; body: MlItem }>>('/items', {
        ids: chunk.join(','),
      });
      for (const r of res) if (r.code === 200 && r.body) out.push(r.body);
    }
    return out;
  }

  user(id: number) {
    return this.get<MlUser>(`/users/${id}`);
  }

  // ---------- caminho de ranking ----------
  // Substituem a busca bloqueada. Ver README, seção sobre o 403.

  /** Top 20 de uma categoria, com a posição de cada um. */
  highlights(categoryId: string) {
    return this.get<{ content: MlHighlight[] }>(`/highlights/${this.siteId}/category/${categoryId}`);
  }

  /** Ficha do produto de catálogo. */
  product(productId: string) {
    return this.get<MlProduct>(`/products/${productId}`);
  }

  /** Todos os anúncios que disputam um produto — a análise de concorrência. */
  productItems(productId: string, limit = 50) {
    return this.get<{ results: MlProductItem[]; paging?: { total: number } }>(
      `/products/${productId}/items`, { limit },
    );
  }

  /**
   * Busca de PRODUTO DE CATÁLOGO por texto.
   * Achado ao vivo 28/07/2026: /sites/{site}/search (anúncio) dá 403;
   * /products/search funciona pra terceiro. Usado pra atender pedidos
   * da extensão quando /items?ids= também dá 403.
   */
  searchProducts(q: string, limit = 5) {
    return this.get<{ results: Array<{ id: string; name?: string }> }>(
      '/products/search', { status: 'active', site_id: this.siteId, q, limit },
    );
  }

  /** Anúncios da própria conta. Único caminho para sold_quantity real. */
  myItems(userId: number, offset = 0, limit = 50) {
    return this.get<{ results: string[]; paging: { total: number } }>(
      `/users/${userId}/items/search`, { offset, limit },
    );
  }
}

export class NotFoundError extends Error {
  constructor(path: string) {
    super(`404 em ${path}`);
    this.name = 'NotFoundError';
  }
}

// ---------- tipos ----------

export interface MlCategory {
  id: string;
  name: string;
  total_items_in_this_category?: number;
  path_from_root?: Array<{ id: string; name: string }>;
  children_categories?: Array<{ id: string; name: string; total_items_in_this_category?: number }>;
}

export interface MlItem {
  id: string;
  title: string;
  category_id?: string;
  seller_id?: number;
  price?: number;
  original_price?: number | null;
  available_quantity?: number;
  sold_quantity?: number;
  condition?: string;
  listing_type_id?: string;
  permalink?: string;
  thumbnail?: string;
  secure_thumbnail?: string;
  status?: string;
  health?: number | null;
  date_created?: string;
  catalog_product_id?: string | null;
  catalog_listing?: boolean;
  official_store_id?: number | null;
  attributes?: Array<{ id: string; value_name?: string | null }>;
  shipping?: { free_shipping?: boolean; logistic_type?: string };
  seller?: { id?: number; nickname?: string };
}

export interface MlSearchResponse {
  paging: { total: number; offset: number; limit: number };
  results: MlItem[];
}

export interface MlUser {
  id: number;
  nickname?: string;
  registration_date?: string;
  permalink?: string;
  address?: { state?: string; city?: string };
  country_id?: string;
  seller_reputation?: {
    level_id?: string | null;
    power_seller_status?: string | null;
    transactions?: { total?: number; canceled?: number };
    metrics?: {
      claims?: { rate?: number };
      delayed_handling_time?: { rate?: number };
    };
  };
}


// ---------- tipos do caminho de ranking ----------

export interface MlHighlight {
  id: string;
  position?: number;
  /** PRODUCT domina no MLB; ITEM aparece em algumas categorias. */
  type: 'PRODUCT' | 'ITEM' | string;
}

export interface MlProduct {
  id: string;
  name?: string;
  status?: string;
  permalink?: string;
  pictures?: Array<{ id?: string; url?: string }>;
  attributes?: Array<{ id: string; value_name?: string | null }>;
  buy_box_winner?: {
    item_id?: string;
    seller_id?: number;
    price?: number;
    sold_quantity?: number;
  } | null;
}

/**
 * Um anúncio devolvido por /products/{id}/items.
 *
 * Repare no que NÃO tem: sold_quantity. A API não entrega para anúncio
 * de terceiro (403 access_denied em /items/{id}), e é por isso que o
 * sinal de demanda vem do ranking.
 */
export interface MlProductItem {
  item_id: string;
  seller_id?: number;
  price?: number;
  original_price?: number | null;
  category_id?: string;
  condition?: string;
  listing_type_id?: string;
  official_store_id?: number | null;
  tags?: string[];
  shipping?: { free_shipping?: boolean; logistic_type?: string };
  seller_address?: { city?: { name?: string }; state?: { name?: string } };
}
