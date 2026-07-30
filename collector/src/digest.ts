/**
 * Fecha a coleta do dia: conta produtos novos, grava aviso no sistema
 * e (se RESEND_API_KEY existir) manda e-mail pro dono.
 */
import { sql } from './db.js';

export type DigestResult = {
  ok: boolean;
  dia: string;
  posicoes: number;
  produtos_total: number;
  novos_ranking: number;
  novos_catalogo: number;
  alertas: number;
  titulo: string;
  detalhe: string;
  email_enviado?: boolean;
  email_erro?: string;
};

export async function registrarDigest(): Promise<DigestResult> {
  const [row] = await sql<{ dig: DigestResult }[]>`
    select registrar_digest_coleta(current_date) as dig
  `;
  if (!row?.dig) throw new Error('registrar_digest_coleta não retornou dados');
  return row.dig;
}

export async function enviarEmailDigest(d: DigestResult): Promise<DigestResult> {
  const key = process.env.RESEND_API_KEY;
  const para = process.env.DIGEST_EMAIL_TO
    ?? process.env.CATALOGO_EMAIL_TO
    ?? 'andersonvarjaodeoliveira1@gmail.com';

  if (!key) {
    return { ...d, email_enviado: false, email_erro: 'RESEND_API_KEY ausente' };
  }

  const html = `
    <h2>Gringa Radar — coleta diária</h2>
    <p><b>${d.titulo}</b></p>
    <p>${d.detalhe}</p>
    <ul>
      <li><b>Novos no ranking:</b> ${d.novos_ranking}</li>
      <li><b>Novos no catálogo:</b> ${d.novos_catalogo}</li>
      <li><b>Posições lidas:</b> ${Number(d.posicoes).toLocaleString('pt-BR')}</li>
      <li><b>Produtos no catálogo:</b> ${Number(d.produtos_total).toLocaleString('pt-BR')}</li>
      <li><b>Alertas do Monitor:</b> ${d.alertas}</li>
      <li><b>Dia:</b> ${d.dia}</li>
    </ul>
    <p><a href="https://andersonvarjaodeoliveira1.github.io/joompulse-core/app/">Abrir o painel</a></p>
  `;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.DIGEST_EMAIL_FROM
        ?? process.env.CATALOGO_EMAIL_FROM
        ?? 'Gringa Radar <onboarding@resend.dev>',
      to: [para],
      subject: `[Gringa Radar] ${d.titulo}`,
      html,
    }),
  });

  if (!r.ok) {
    const detalhe = (await r.text()).slice(0, 400);
    return { ...d, email_enviado: false, email_erro: detalhe };
  }
  return { ...d, email_enviado: true };
}

export async function fecharDigestDoDia(): Promise<DigestResult> {
  const d = await registrarDigest();
  return enviarEmailDigest(d);
}
