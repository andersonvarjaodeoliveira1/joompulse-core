/**
 * Assistente de IA — responde perguntas sobre os produtos que o usuário
 * monitora, explica métricas da tela, sugere o que fazer com os dados.
 *
 * Diferente de ml-preco: aqui a autenticação usa o JWT do PRÓPRIO
 * usuário (não a credencial compartilhada do ML). Cada chamada às RPCs
 * de dados (listar_monitorados, listar_alertas, quota_status,
 * ficha_produto) roda com auth.uid() do usuário real — RLS e quota
 * aplicam normalmente, o assistente nunca vê dado de outra conta.
 *
 * A quota (feature ai_content, já existe em plans.limits) é consumida
 * ANTES de chamar a Anthropic — nunca gasta uma chamada de API paga
 * num pedido que o plano do usuário já não permite.
 *
 * Deploy:
 *   supabase functions deploy assistente
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *   supabase secrets set ANTHROPIC_MODEL=claude-haiku-4-5-20251001   (opcional)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { requireRateLimit } from '../_shared/auth.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

const SISTEMA = `Você é o assistente do Gringa Radar, ferramenta de inteligência de mercado pra
vendedores do Mercado Livre Brasil. O sistema lê o ranking de destaques das categorias do ML e
guarda histórico de posição e preço — NÃO tem acesso a quantidade vendida real de anúncio de
terceiro (a API do ML bloqueia isso), então "vendas" no seu contexto é sempre estimativa ou
leitura aproximada da página, nunca dado exato.

Você recebe, junto com a pergunta, um JSON com os dados REAIS da conta de quem pergunta:
produtos monitorados, alertas recentes, o plano/quota atual, e o produto específico que a
pessoa está olhando (se houver). Responda SOMENTE com base nesses dados.

Regras:
- Se a pergunta pedir algo que não está no JSON (ex.: um produto que não está na lista de
  monitorados), diga isso claramente — não invente número, posição ou tendência.
- Ao explicar uma métrica, seja concreto: diga o que ela significa E o que fazer a respeito.
- Quando fizer sentido, sugira uma ação real do próprio app: "Monitorar" um produto na Busca,
  "Pedir coleta" pela extensão do Chrome quando o produto não está na base, olhar a Calculadora
  de margem, ou checar a aba Categorias pra achar nicho com pouca concorrência.
- Respostas curtas e diretas, em português do Brasil. Sem markdown pesado, só texto corrido ou
  poucos itens com "-".`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, erro: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('authorization');
  if (!authHeader) return json({ ok: false, erro: 'sem_auth' }, 401);

  let pergunta: string | undefined;
  let contexto: { produtoId?: string } = {};
  try {
    const body = await req.json();
    pergunta = body.pergunta;
    contexto = body.contexto ?? {};
  } catch {
    return json({ ok: false, erro: 'corpo_invalido' }, 400);
  }
  if (!pergunta?.trim()) return json({ ok: false, erro: 'pergunta_vazia' }, 400);

  // Cliente escopado ao usuário que chamou — não é service role. RLS e
  // auth.uid() nas RPCs abaixo continuam valendo normalmente.
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const rl = await requireRateLimit(sb, 'assistente', 10, 60);
  if (!rl.ok) return json(rl.body, rl.status);

  const { data: quotaAntes, error: eQuota } = await sb.rpc('consume_quota', { p_feature: 'ai_content' });
  if (eQuota) return json({ ok: false, erro: 'falha_quota', detalhe: eQuota.message }, 200);
  if (!quotaAntes?.allowed) return json({ ok: false, erro: 'quota' }, 200);

  const [monitorados, alertas, quota, ficha] = await Promise.all([
    sb.rpc('listar_monitorados'),
    sb.rpc('listar_alertas', { p_limite: 10 }),
    sb.rpc('quota_status'),
    contexto.produtoId ? sb.rpc('ficha_produto', { p_produto: contexto.produtoId }) : Promise.resolve({ data: null }),
  ]);

  const dados = {
    produtos_monitorados: monitorados.data ?? [],
    alertas_recentes: alertas.data ?? [],
    plano_e_quota: quota.data ?? null,
    produto_aberto_agora: ficha.data ?? null,
  };

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ ok: false, erro: 'ia_nao_configurada' }, 200);
  const model = Deno.env.get('ANTHROPIC_MODEL') || 'claude-haiku-4-5-20251001';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system: SISTEMA,
        messages: [{
          role: 'user',
          content: `Dados da conta (JSON):\n${JSON.stringify(dados)}\n\nPergunta: ${pergunta}`,
        }],
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      return json({ ok: false, erro: 'falha_ia', detalhe: t.slice(0, 300) }, 200);
    }

    const out = await res.json();
    const resposta = out.content?.map((b: { text?: string }) => b.text ?? '').join('') ?? '';
    return json({ ok: true, resposta: resposta || 'Não consegui gerar uma resposta agora.' });
  } catch (e) {
    return json({ ok: false, erro: 'falha_ia', detalhe: String(e) }, 200);
  }
});
