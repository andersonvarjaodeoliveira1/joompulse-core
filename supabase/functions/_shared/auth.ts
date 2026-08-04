/**
 * Helpers compartilhados — auth do usuário + quota + rate limit.
 * Copyright (c) 2026 Gringa Radar. Todos os direitos reservados.
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export function userClientFromAuth(authHeader: string): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
}

export async function requireUser(req: Request): Promise<
  | { ok: true; authHeader: string; userId: string; sb: SupabaseClient }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, status: 401, body: { ok: false, erro: 'nao_autenticado' } };
  }
  const sb = userClientFromAuth(authHeader);
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) {
    return { ok: false, status: 401, body: { ok: false, erro: 'nao_autenticado' } };
  }
  return { ok: true, authHeader, userId: data.user.id, sb };
}

/** Consome quota do plano. Devolve erro amigável se estourar. */
export async function requireQuota(
  sb: SupabaseClient,
  feature: string,
): Promise<{ ok: true } | { ok: false; body: Record<string, unknown> }> {
  const { data, error } = await sb.rpc('consume_quota', { p_feature: feature });
  if (error) return { ok: false, body: { ok: false, erro: 'falha_quota', detalhe: error.message } };
  if (!data?.allowed) {
    return {
      ok: false,
      body: {
        ok: false,
        erro: 'quota',
        feature,
        remaining: data?.remaining ?? 0,
        limit: data?.limit ?? 0,
      },
    };
  }
  return { ok: true };
}

/** Rate limit por usuário (RPC check_rate_limit). */
export async function requireRateLimit(
  sb: SupabaseClient,
  bucket: string,
  limit = 30,
  windowSeconds = 60,
): Promise<{ ok: true } | { ok: false; body: Record<string, unknown>; status: number }> {
  const { data, error } = await sb.rpc('check_rate_limit', {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    // Se a migration ainda não estiver aplicada, não derruba a função.
    if (/check_rate_limit|function .* does not exist/i.test(error.message)) {
      return { ok: true };
    }
    return { ok: false, status: 200, body: { ok: false, erro: 'falha_rate_limit', detalhe: error.message } };
  }
  if (!data?.allowed) {
    return {
      ok: false,
      status: 429,
      body: {
        ok: false,
        erro: 'rate_limit',
        retry_after_seconds: data?.retry_after_seconds ?? windowSeconds,
      },
    };
  }
  return { ok: true };
}
