/**
 * Recebe metadados de um catálogo PDF já no Storage, marca no banco e
 * envia o arquivo por e-mail (Resend) para andersonvarjaodeoliveira1@gmail.com.
 *
 * Fluxo do front:
 *   1) sobe o PDF em storage bucket "catalogos"/{userId}/{uuid}.pdf
 *   2) insert em supplier_catalogs
 *   3) invoca esta function com { catalog_id }
 *
 * Secrets:
 *   RESEND_API_KEY   — obrigatório pra mandar e-mail
 *   CATALOGO_EMAIL_TO — opcional (default o e-mail do dono do projeto)
 *   SUPABASE_DB_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — injetados
 *
 * Deploy:
 *   supabase functions deploy enviar-catalogo
 *   supabase secrets set RESEND_API_KEY=re_...
 */
import postgres from 'https://esm.sh/postgres@3.4.4';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const EMAIL_TO = Deno.env.get('CATALOGO_EMAIL_TO') ?? 'andersonvarjaodeoliveira1@gmail.com';
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2 });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, erro: 'method_not_allowed' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return json({ ok: false, erro: 'nao_autenticado' }, 401);
  }

  let catalogId: string | undefined;
  try {
    ({ catalog_id: catalogId } = await req.json());
  } catch {
    return json({ ok: false, erro: 'corpo_invalido' }, 400);
  }
  if (!catalogId) return json({ ok: false, erro: 'catalog_id_obrigatorio' }, 400);

  // Quem chama tem que ser o dono do registro
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { authorization: auth } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, erro: 'nao_autenticado' }, 401);
  const userId = userData.user.id;
  const userEmail = userData.user.email ?? '(sem e-mail)';

  const [row] = await sql<{
    id: string; user_id: string; nome_arquivo: string; storage_path: string;
    tamanho_bytes: number | null; fornecedor_nome: string | null; notas: string | null;
  }[]>`
    select id, user_id, nome_arquivo, storage_path, tamanho_bytes, fornecedor_nome, notas
      from supplier_catalogs where id = ${catalogId}::uuid
  `;
  if (!row) return json({ ok: false, erro: 'catalogo_nao_encontrado' }, 404);
  if (row.user_id !== userId) return json({ ok: false, erro: 'proibido' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data: fileData, error: dlErr } = await admin.storage
    .from('catalogos')
    .download(row.storage_path);
  if (dlErr || !fileData) {
    await sql`
      update supplier_catalogs
         set status = 'erro_email', email_erro = ${'download: ' + (dlErr?.message ?? 'falhou')}
       where id = ${catalogId}::uuid`;
    return json({ ok: false, erro: 'download_falhou', detalhe: dlErr?.message }, 200);
  }

  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    await sql`
      update supplier_catalogs
         set status = 'erro_email',
             email_erro = 'RESEND_API_KEY nao configurada — arquivo guardado no Storage'
       where id = ${catalogId}::uuid`;
    return json({
      ok: true, email_enviado: false,
      aviso: 'Catálogo salvo. Configure RESEND_API_KEY pra disparar o e-mail automático.',
    });
  }

  const bytes = new Uint8Array(await fileData.arrayBuffer());
  const b64 = bytesToBase64(bytes);
  const assunto = `[Gringa Radar] Catálogo: ${row.fornecedor_nome || row.nome_arquivo}`;
  const html = `
    <p>Novo catálogo de fornecedor enviado pelo app.</p>
    <ul>
      <li><b>Arquivo:</b> ${row.nome_arquivo}</li>
      <li><b>Fornecedor:</b> ${row.fornecedor_nome ?? '—'}</li>
      <li><b>Tamanho:</b> ${row.tamanho_bytes ?? bytes.length} bytes</li>
      <li><b>Usuário:</b> ${userEmail} (${userId})</li>
      <li><b>Notas:</b> ${row.notas ?? '—'}</li>
      <li><b>Path Storage:</b> ${row.storage_path}</li>
    </ul>
    <p>O PDF vai em anexo.</p>`;

  const mailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: Deno.env.get('CATALOGO_EMAIL_FROM') ?? 'Gringa Radar <onboarding@resend.dev>',
      to: [EMAIL_TO],
      subject: assunto,
      html,
      attachments: [{
        filename: row.nome_arquivo.endsWith('.pdf') ? row.nome_arquivo : `${row.nome_arquivo}.pdf`,
        content: b64,
      }],
    }),
  });

  if (!mailRes.ok) {
    const detalhe = (await mailRes.text()).slice(0, 400);
    await sql`
      update supplier_catalogs
         set status = 'erro_email', email_erro = ${detalhe}
       where id = ${catalogId}::uuid`;
    return json({ ok: false, erro: 'email_falhou', detalhe }, 200);
  }

  await sql`
    update supplier_catalogs
       set status = 'email_enviado', email_enviado_em = now(), email_erro = null
     where id = ${catalogId}::uuid`;

  return json({ ok: true, email_enviado: true, para: EMAIL_TO });
});
