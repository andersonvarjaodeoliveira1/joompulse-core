/**
 * Webhook Mercado Pago — ativa plano quando o pagamento é aprovado.
 *
 * Secrets:
 *   MP_ACCESS_TOKEN     — obrigatório
 *   MP_WEBHOOK_SECRET   — secret da assinatura (painel MP); se definido,
 *                         exige x-signature válida (manifesta)
 *
 * Deploy:
 *   supabase functions deploy mp-webhook --no-verify-jwt
 *
 * Copyright (c) 2026 Gringa Radar. Todos os direitos reservados.
 */
import postgres from 'https://esm.sh/postgres@3.4.4';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info, x-signature, x-request-id',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2 });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

/** Valida x-signature do MP quando MP_WEBHOOK_SECRET está configurado. */
async function assinaturaOk(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get('MP_WEBHOOK_SECRET');
  if (!secret) return true; // modo permissivo até o secret ser setado

  const sigHeader = req.headers.get('x-signature') ?? '';
  const requestId = req.headers.get('x-request-id') ?? '';
  // Formato: ts=...,v1=...
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => {
      const [k, ...rest] = p.trim().split('=');
      return [k, rest.join('=')];
    }),
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const url = new URL(req.url);
  const dataId = url.searchParams.get('data.id')
    ?? (() => {
      try {
        const j = JSON.parse(rawBody);
        return String((j?.data as { id?: string } | undefined)?.id ?? j?.id ?? '');
      } catch { return ''; }
    })();

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === v1.toLowerCase();
}

async function processPayment(paymentId: string) {
  const token = Deno.env.get('MP_ACCESS_TOKEN');
  if (!token) return { ok: false, erro: 'sem_token' };

  // Sempre revalida no MP — nunca confia só no payload do webhook.
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const pay = await r.json();
  if (!r.ok) return { ok: false, erro: 'mp_payment', detalhe: pay };

  const status = String(pay.status ?? '');
  const externalRef = String(pay.external_reference ?? '');
  const meta = pay.metadata ?? {};
  const plan = String(meta.plan ?? '');
  const periodo = String(meta.periodo ?? 'mes');
  let userId = String(meta.user_id ?? '');

  if (externalRef) {
    const [row] = await sql<{
      id: string; user_id: string; plan_code: string; periodo: string; status: string;
    }[]>`
      select id, user_id, plan_code, periodo, status
        from payment_checkouts where id = ${externalRef}::uuid
    `;
    if (row) {
      userId = row.user_id;
      await sql`
        update payment_checkouts set
          mp_payment_id = ${paymentId},
          status = ${status === 'approved' ? 'approved'
            : status === 'rejected' ? 'rejected'
            : status === 'cancelled' ? 'cancelled'
            : status === 'refunded' ? 'refunded'
            : 'pending'},
          payload = coalesce(payload, '{}'::jsonb) || ${sql.json({ payment: { id: paymentId, status } })},
          atualizado_em = now()
        where id = ${row.id}::uuid
      `;

      if (status === 'approved') {
        const [out] = await sql`select ativar_assinatura_pagamento(
          ${row.user_id}::uuid,
          ${row.plan_code},
          ${row.periodo},
          ${paymentId},
          ${pay.preference_id ?? null}
        ) as j`;
        return { ok: true, ativado: out?.j, payment_id: paymentId };
      }
    }
  }

  if (status === 'approved' && userId && plan) {
    const [out] = await sql`select ativar_assinatura_pagamento(
      ${userId}::uuid, ${plan}, ${periodo}, ${paymentId}, ${pay.preference_id ?? null}
    ) as j`;
    return { ok: true, ativado: out?.j, payment_id: paymentId };
  }

  return { ok: true, ignorado: true, status, payment_id: paymentId };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const rawBody = req.method === 'POST' ? await req.text() : '';
  if (!(await assinaturaOk(req, rawBody))) {
    return json({ ok: false, erro: 'assinatura_invalida' }, 401);
  }

  // Health / challenge
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const id = url.searchParams.get('data.id') ?? url.searchParams.get('id');
    const topic = url.searchParams.get('type') ?? url.searchParams.get('topic');
    if (id && (topic === 'payment' || topic === 'payment.created')) {
      const r = await processPayment(id);
      return json(r);
    }
    return json({ ok: true, service: 'mp-webhook' });
  }

  if (req.method !== 'POST') return json({ ok: false, erro: 'method_not_allowed' }, 405);

  let body: Record<string, unknown> = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { /* querystring fallback */ }

  const url = new URL(req.url);
  const paymentId = String(
    (body.data as { id?: string } | undefined)?.id
      ?? body.id
      ?? url.searchParams.get('data.id')
      ?? url.searchParams.get('id')
      ?? '',
  );
  const tipo = String(body.type ?? body.topic ?? url.searchParams.get('type') ?? '');

  if (!paymentId) return json({ ok: true, ignorado: true, motivo: 'sem_id' });
  if (tipo && !String(tipo).includes('payment')) {
    return json({ ok: true, ignorado: true, tipo });
  }

  const r = await processPayment(paymentId);
  return json(r);
});
