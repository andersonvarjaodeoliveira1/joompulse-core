# Segurança — Gringa Radar

Documento interno do modelo de segurança do produto (painel, extensão,
Edge Functions, coleta e banco). **Segredos nunca entram neste arquivo.**

## Princípios

1. O navegador só recebe a **chave publishable/anon** do Supabase.
2. Senhas de banco, `service_role`, tokens Mercado Livre/Pago e Resend
   ficam só em **Supabase Secrets** ou **GitHub Actions Secrets**.
3. Toda ação de usuário autenticado passa por **RLS** ou RPC
   `security definer` com checagem de `auth.uid()`.
4. Funções perigosas (`gerar_alertas`, `refresh_rank_metrics`,
   `ativar_assinatura_pagamento`, etc.) são **revogadas** de
   `anon` / `authenticated` e só rodam com role de serviço/coleta.

## Superfícies

| Superfície | O que pode | O que não pode |
|---|---|---|
| `app/` (GitHub Pages) | Login, RPCs do plano, UI | Ler `service_role`, gravar métricas globais, ativar plano sem pagamento |
| Extensão Chrome | Mesmas RPCs via token do usuário no **service worker** | Expor o token na página do Mercado Livre |
| Edge Functions | Checkout, webhook MP, ML, assistente | Ser chamadas sem auth quando exigem JWT (exceto webhook/callback) |
| Collector (Actions) | Coleta + `gerar_alertas` via `DATABASE_URL` | Expor connection string no front |

## Extensão

- Token e refresh ficam em `chrome.storage.local`, acessados só pelo
  `background.js` (service worker).
- O `content.js` pede dados por `chrome.runtime.sendMessage` — não fala
  com o Supabase direto.
- Assinatura: `status_assinatura` / gates no login; sem plano ativo os
  dados na página do ML não liberam.

## Pagamentos

- Preferência criada em `criar-checkout` (usuário autenticado).
- Plano só muda via `mp-webhook` → `ativar_assinatura_pagamento`
  (service role). O cliente **não** pode auto-promover o plano.

## Segredos (onde configurar)

| Segredo | Onde |
|---|---|
| `DATABASE_URL` | GitHub Actions |
| `ML_CLIENT_*` / `ML_REDIRECT_URI` | Actions + Supabase Functions |
| `MP_ACCESS_TOKEN` | Supabase Secrets |
| `RESEND_API_KEY` / `DIGEST_EMAIL_TO` | GitHub Actions |
| `.env` local do collector | **nunca** commitado (ver `.gitignore`) |

## Cabeçalhos no painel

O `app/index.html` declara CSP (`frame-ancestors 'none'`, sem `object`,
connect só Supabase/CDN) e `referrer` restrito.

## O que NÃO fazer

- Commitar `.env`, connection string ou `service_role`.
- Colocar token de usuário no content script da extensão.
- Expor nomes de secrets ou detalhes de infra na UI pública.
- Liberar `gerar_alertas` / `ativar_assinatura_pagamento` para `authenticated`.
