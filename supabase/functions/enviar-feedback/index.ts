/**
 * Recebe feedback de membros (e-mail, WhatsApp, mensagem) e envia
 * por e-mail ao dono do Gringa Radar via Resend.
 *
 * Secrets:
 *   RESEND_API_KEY        — obrigatório
 *   FEEDBACK_EMAIL_TO     — opcional (default andersonvarjaodeoliveira1@gmail.com)
 *   FEEDBACK_EMAIL_FROM   — opcional
 *
 * Deploy:
 *   supabase functions deploy enviar-feedback
 */
import { requireUser, requireRateLimit } from '../_shared/auth.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const EMAIL_TO = Deno.env.get('FEEDBACK_EMAIL_TO')
  ?? Deno.env.get('CATALOGO_EMAIL_TO')
  ?? Deno.env.get('DIGEST_EMAIL_TO')
  ?? 'andersonvarjaodeoliveira1@gmail.com';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

function limpar(s: unknown, max: number): string {
  return String(s ?? '').trim().slice(0, max);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, erro: 'method_not_allowed' }, 405);

  const auth = await requireUser(req);
  if (!auth.ok) return json(auth.body, auth.status);

  const rl = await requireRateLimit(auth.sb, 'enviar-feedback', 5, 600);
  if (!rl.ok) return json(rl.body, rl.status);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, erro: 'corpo_invalido' }, 400);
  }

  const email = limpar(body.email, 200);
  const whatsapp = limpar(body.whatsapp, 40);
  const mensagem = limpar(body.mensagem, 4000);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, erro: 'email_invalido' }, 400);
  }
  if (!whatsapp || whatsapp.replace(/\D/g, '').length < 10) {
    return json({ ok: false, erro: 'whatsapp_invalido' }, 400);
  }
  if (!mensagem || mensagem.length < 5) {
    return json({ ok: false, erro: 'mensagem_curta' }, 400);
  }

  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    return json({ ok: false, erro: 'email_nao_configurado' }, 503);
  }

  const conta = auth.sb; // só pra tipagem; e-mail da conta vem do JWT
  const { data: userData } = await conta.auth.getUser();
  const contaEmail = userData?.user?.email ?? '(desconhecido)';

  const digits = whatsapp.replace(/\D/g, '');
  const waLink = digits ? `https://wa.me/55${digits.replace(/^55/, '')}` : '';

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1e">
      <h2 style="margin:0 0 12px;font-size:18px">Novo feedback — Gringa Radar</h2>
      <p style="margin:0 0 8px"><b>E-mail para contato:</b> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
      <p style="margin:0 0 8px"><b>WhatsApp para contato:</b> ${escapeHtml(whatsapp)}
        ${waLink ? ` — <a href="${waLink}">abrir no WhatsApp</a>` : ''}</p>
      <p style="margin:0 0 8px"><b>Conta logada:</b> ${escapeHtml(contaEmail)}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
      <p style="margin:0 0 6px"><b>Mensagem:</b></p>
      <pre style="white-space:pre-wrap;font-family:inherit;background:#f7f8fa;padding:12px;border-radius:8px;margin:0">${escapeHtml(mensagem)}</pre>
    </div>
  `;

  const mailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: Deno.env.get('FEEDBACK_EMAIL_FROM')
        ?? Deno.env.get('CATALOGO_EMAIL_FROM')
        ?? Deno.env.get('DIGEST_EMAIL_FROM')
        ?? 'Gringa Radar <onboarding@resend.dev>',
      to: [EMAIL_TO],
      reply_to: email,
      subject: `Feedback Gringa Radar — ${email} — WhatsApp ${whatsapp}`,
      html,
      text: `Feedback Gringa Radar\n\nE-mail para contato: ${email}\nWhatsApp para contato: ${whatsapp}${waLink ? `\nLink WhatsApp: ${waLink}` : ''}\nConta logada: ${contaEmail}\n\nMensagem:\n${mensagem}`,
    }),
  });

  if (!mailRes.ok) {
    const detalhe = (await mailRes.text()).slice(0, 400);
    return json({ ok: false, erro: 'falha_envio', detalhe }, 502);
  }

  return json({ ok: true });
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}
