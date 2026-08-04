# Segurança — Gringa Radar

Documento interno do modelo de segurança do produto (painel, extensão,
Edge Functions, coleta e banco). **Segredos nunca entram neste arquivo.**

## A verdade (SaaS)

O frontend **nunca** fica realmente protegido — F12 lê o que o navegador
executa. Ofuscação só atrapalha. O cofre é o **backend** (Supabase SQL,
Edge Functions, collector). Diferencial competitivo (ranking, alertas,
quotas, pagamentos) fica no servidor; o cliente só recebe o resultado.

## Frente 1 — Backend

1. O navegador só recebe a chave **publishable/anon** do Supabase.
2. Senhas de banco, `service_role`, tokens ML/MP/Resend/Anthropic ficam
   só em **Supabase Secrets** ou **GitHub Actions Secrets**.
3. Ações autenticadas passam por **RLS** / RPC `security definer` com
   `auth.uid()`.
4. Funções perigosas (`gerar_alertas`, `refresh_rank_metrics`,
   `ativar_assinatura_pagamento`, …) são **revogadas** de
   `anon`/`authenticated`.
5. Edge Functions sensíveis exigem JWT + `consume_quota` +
   `check_rate_limit` (`api_rate_buckets`).
6. Webhook MP revalida o pagamento na API do MP; com
   `MP_WEBHOOK_SECRET` também exige `x-signature`.

## Frente 2 — Frontend

1. Fonte editável: `frontend/` (Vite).
2. Build de produção: **minify (terser)**, **sem source maps**,
   **javascript-obfuscator** no bundle (`npm run build` em `frontend/`).
3. Artefato servido no GitHub Pages: `app/` (HTML + `assets/*.js`).
4. CSP + `referrer` restrito no HTML.
5. LICENSE proprietário na raiz do repositório.

```bash
cd frontend && npm install && npm run build
```

## Superfícies

| Superfície | O que pode | O que não pode |
|---|---|---|
| `app/` (Pages) | Login, RPCs do plano, UI | `service_role`, ativar plano sozinho |
| Extensão | RPCs via token no **service worker** | Token na página do ML |
| Edge Functions | Checkout, webhook, ML, assistente | Uso anônimo nas rotas que exigem JWT |
| Collector | Coleta + alertas via `DATABASE_URL` | Expor connection string no front |

## Segredos (onde configurar)

| Segredo | Onde |
|---|---|
| `DATABASE_URL` | GitHub Actions |
| `ML_CLIENT_*` | Actions + Supabase Functions |
| `MP_ACCESS_TOKEN` / `MP_WEBHOOK_SECRET` | Supabase Secrets |
| `RESEND_API_KEY` / `DIGEST_EMAIL_TO` | GitHub Actions |
| `ANTHROPIC_API_KEY` | Supabase Secrets |
| `.env` do collector / `frontend/.env.local` | **nunca** commitado |

## O que NÃO fazer

- Commitar `.env`, connection string ou `service_role`.
- Publicar source maps de produção.
- Colocar token de usuário no content script da extensão.
- Expor nomes de secrets na UI.
- Liberar `gerar_alertas` / `ativar_assinatura_pagamento` para `authenticated`.
