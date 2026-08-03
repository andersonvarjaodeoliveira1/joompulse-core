/**
 * Cria preferência de Checkout Pro no Mercado Pago e devolve o init_point.
 *
 * Secrets:
 *   MP_ACCESS_TOKEN   — token de produção ou teste do Mercado Pago
 *   APP_PUBLIC_URL    — ex: https://andersonvarjaodeoliveira1.github.io/joompulse-core/app
 *   MP_WEBHOOK_URL    — URL pública desta function mp-webhook (opcional; usa callback_url)
 *
 * Deploy:
 *   supabase functions deploy criar-checkout
 *   supabase secrets set MP_ACCESS_TOKEN=APP_USR-...
 */
import postgres from 'https://esm.sh/postgres@3.4.4';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, erro: 'method_not_allowed' }, 405);

  const tokenMp = Deno.env.get('MP_ACCESS_TOKEN');
  if (!tokenMp) {
    return json({
      ok: false,
      erro: 'gateway_nao_configurado',
      detalhe: 'Defina o secret MP_ACCESS_TOKEN no Supabase (token do Mercado Pago).',
    }, 200);
  }

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return json({ ok: false, erro: 'nao_autenticado' }, 401);
  }

  let plan = 'pro';
  let periodo: 'mes' | 'ano' = 'mes';
  try {
    const body = await req.json();
    if (body?.plan) plan = String(body.plan);
    if (body?.periodo === 'ano' || body?.periodo === 'mes') periodo = body.periodo;
  } catch {
    return json({ ok: false, erro: 'corpo_invalido' }, 400);
  }
  if (!['starter', 'pro', 'business'].includes(plan)) {
    return json({ ok: false, erro: 'plano_invalido' }, 400);
  }

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { authorization: auth } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, erro: 'nao_autenticado' }, 401);
  const userId = userData.user.id;
  const email = userData.user.email ?? undefined;

  const [plano] = await sql<{
    code: string; name: string; price_monthly: number; price_annual_month: number;
  }[]>`
    select code, name, price_monthly, price_annual_month
      from plans where code = ${plan} and is_public = true
  `;
  if (!plano) return json({ ok: false, erro: 'plano_nao_encontrado' }, 404);

  const amount = Number(periodo === 'ano'
    ? Number(plano.price_annual_month) * 12
    : plano.price_monthly);
  if (!(amount > 0)) return json({ ok: false, erro: 'preco_invalido' }, 400);

  const appUrl = (Deno.env.get('APP_PUBLIC_URL')
    ?? 'https://andersonvarjaodeoliveira1.github.io/joompulse-core/app').replace(/\/$/, '');
  const webhook = Deno.env.get('MP_WEBHOOK_URL')
    ?? `${Deno.env.get('SUPABASE_URL')}/functions/v1/mp-webhook`;

  const [checkout] = await sql<{ id: string }[]>`
    insert into payment_checkouts (user_id, plan_code, periodo, amount_brl, status)
    values (${userId}, ${plan}, ${periodo}, ${amount}, 'pending')
    returning id
  `;

  const externalRef = checkout.id;
  const title = `Gringa Radar — ${plano.name} (${periodo === 'ano' ? 'anual' : 'mensal'})`;

  const prefBody = {
    items: [{
      id: `${plan}-${periodo}`,
      title,
      description: `Assinatura ${plano.name} · Gringa Radar`,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: Math.round(amount * 100) / 100,
    }],
    payer: email ? { email } : undefined,
    external_reference: externalRef,
    metadata: { user_id: userId, plan, periodo, checkout_id: externalRef },
    back_urls: {
      success: `${appUrl}/?pago=ok&plano=${plan}`,
      failure: `${appUrl}/?pago=falha`,
      pending: `${appUrl}/?pago=pendente`,
    },
    auto_return: 'approved',
    notification_url: webhook,
    statement_descriptor: 'GRINGA RADAR',
  };

  const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenMp}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(prefBody),
  });
  const txt = await r.text();
  let pref: { id?: string; init_point?: string; sandbox_init_point?: string } = {};
  try { pref = JSON.parse(txt); } catch { /* keep empty */ }

  if (!r.ok || !pref.id || !(pref.init_point || pref.sandbox_init_point)) {
    await sql`
      update payment_checkouts set
        status = 'cancelled',
        payload = ${sql.json({ erro_mp: txt.slice(0, 800) })},
        atualizado_em = now()
      where id = ${checkout.id}::uuid
    `;
    return json({
      ok: false,
      erro: 'mp_falhou',
      detalhe: txt.slice(0, 400),
    }, 200);
  }

  const init = pref.init_point ?? pref.sandbox_init_point!;
  await sql`
    update payment_checkouts set
      mp_preference_id = ${pref.id},
      init_point = ${init},
      payload = ${sql.json({ preference: { id: pref.id } })},
      atualizado_em = now()
    where id = ${checkout.id}::uuid
  `;

  return json({
    ok: true,
    checkout_id: checkout.id,
    preference_id: pref.id,
    init_point: init,
    amount,
    plan,
    periodo,
  });
});
