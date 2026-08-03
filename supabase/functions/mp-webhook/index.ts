/**
 * Webhook Mercado Pago — ativa plano quando o pagamento é aprovado.
 *
 * Configure no painel do MP (ou via notification_url da preference):
 *   https://<project>.supabase.co/functions/v1/mp-webhook
 *
 * Secrets:
 *   MP_ACCESS_TOKEN
 *   SUPABASE_DB_URL (injetado)
 *
 * Deploy:
 *   supabase functions deploy mp-webhook --no-verify-jwt
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

async function processPayment(paymentId: string) {
  const token = Deno.env.get('MP_ACCESS_TOKEN');
  if (!token) return { ok: false, erro: 'sem_token' };

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
  try { body = await req.json(); } catch { /* querystring fallback */ }

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
