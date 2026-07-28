# Gringa Radar — handoff completo (28/07/2026)

Documento de transferência: Claude Code bateu no limite de contexto. Tudo
que segue é pra quem assumir o trabalho (Cursor ou outro) continuar sem
perder o que já foi decidido, testado e descartado.

**Regra de ouro do projeto, releia antes de mexer em qualquer coisa:**
Nunca fabricar dado. Se a API do Mercado Livre não entrega um número
(receita, vendas de terceiro, contato de vendedor), o app diz isso
explicitamente em vez de inventar ou estimar. Toda vez que uma feature
esbarrou nesse limite nesta sessão, a decisão foi construir a versão
honesta e mais pobre, não fingir.

---

## 1. Arquitetura

```
joompulse-core/
├── app/index.html          SPA única (vanilla JS), front-end inteiro
├── collector/               CLI Node/tsx — roda a coleta diária
│   └── src/
│       ├── index.ts         CLI: auth-url, auth-code, categories, rank,
│       │                    produtos, itens, sellers, calibrar, rodada
│       ├── auth.ts           accessToken() com trava FOR UPDATE (ver §4)
│       ├── ml-client.ts      wrapper da API do ML (rate limiter TokenBucket)
│       ├── jobs.ts / jobs-rank.ts   rotinas de coleta
│       ├── db.ts / db-rank.ts       upserts no Postgres
│       ├── pedidos.ts        atende fila de "pedir coleta"
│       └── fornecedores.ts   importa CSV de fornecedor local
├── extensao/                 Chrome extension (lê a página do ML no navegador)
│   └── content.js
├── supabase/
│   ├── migrations/            41 arquivos, aplicados em ordem cronológica
│   └── functions/              4 Edge Functions (Deno)
│       ├── ml-preco/            preço ao vivo por link/MLB (Calculadora)
│       ├── ml-busca-catalogo/   busca texto -> produto de catálogo real
│       ├── assistente/          IA respondendo com dado do próprio usuário
│       └── ml-callback/         OAuth callback do Mercado Livre
└── .github/workflows/coleta-diaria.yml   cron diário (GitHub Actions)
```

**Supabase project ref:** `blnupzfgfhvykrgmvwhw`
**Repo GitHub:** `andersonvarjaodeoliveira1/joompulse-core`
**Front-end publicado:** GitHub Pages estático servindo `app/index.html`

---

## 2. Como aplicar migration / testar RPC (fluxo usado a sessão toda)

```bash
cd joompulse-core
supabase db push          # aplica migrations novas (pede confirmação Y/n)
```

Pra testar uma função direto no banco (sem depender de sessão de usuário
logado, já que RPCs usam `auth.uid()`):

```bash
cd collector
node -e "
require('dotenv').config();
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);
(async()=>{
  const r = await sql\`select * from nome_da_funcao(...)\`;
  console.log(r);
  await sql.end();
})();
"
```

`collector/.env` tem `DATABASE_URL` (conexão direta, porta 5432) e as
credenciais `ML_CLIENT_ID`/`ML_CLIENT_SECRET`/`ML_REDIRECT_URI`.

**Editar `app/index.html` (arquivo de ~2500 linhas, um só `<script type="module">`)
— sempre validar sintaxe antes de commitar:**

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('app/index.html','utf8');
const m = [...html.matchAll(/<script type=\"module\">([\s\S]*?)<\/script>/g)];
fs.writeFileSync('/tmp/_check.mjs', m[0][1]);
"
node --check /tmp/_check.mjs && echo OK
```

---

## 3. Armadilhas de Postgres já pisadas nesta sessão — NÃO REPETIR

1. **`CREATE OR REPLACE VIEW`** só deixa ACRESCENTAR coluna no FIM da
   lista do SELECT. Inserir no meio dá `cannot change name of view column`.
2. **`CREATE OR REPLACE FUNCTION`** com `RETURNS TABLE(...)` de formato
   diferente, OU com um parâmetro novo acrescentado (mesmo com
   `DEFAULT`), cria uma SEGUNDA função (overload) em vez de substituir —
   e todo SELECT nela vira `could not choose a best candidate function`.
   **Sempre `DROP FUNCTION IF EXISTS nome(assinatura_antiga)` antes.**
   Isso já foi esquecido e corrigido ao vivo 2x nesta sessão
   (`monitorar_produto`, e um caso anterior com `listar_produtos_locais`).
3. Nunca reconstruir uma função existente "de memória" — sempre reler o
   arquivo original inteiro e copiar exato + a mudança. Já deu erro forte
   (`ficha_produto`) quando não seguido.

---

## 4. Mercado Livre API — o que É REAL, testado ao vivo, e o que é bloqueado

Tudo abaixo foi confirmado com chamadas reais nesta sessão (não achismo):

| Endpoint | Funciona pra terceiro? | Uso no projeto |
|---|---|---|
| `/products/{id}` | ✅ Sim | ficha de produto de catálogo |
| `/products/{id}/items` | ✅ Sim | concorrentes do produto de catálogo |
| `/products/search?q=...&site_id=MLB` | ✅ Sim (achado em 28/07) | `ml-busca-catalogo`, busca por texto |
| `/highlights/{site}/category/{id}` | ✅ Sim | ranking (substitui busca bloqueada) |
| `/items/{id}` | ❌ 403 sempre | — |
| `/items?ids=` (multiget) | ❌ 403 sempre (testado 25/07, 40 ids reais) | mantido no código como no-op, comentado |
| `/sites/{site}/search` (busca de ANÚNCIO, com `q=`) | ❌ 403 sempre | é por isso que existe `/highlights` |
| `buy_box_winner.sold_quantity` em `/products/{id}` | Sempre `null` (testado 12/12 produtos reais) | não usar, não existe |
| `/products/{id}/items` → campo `sold_quantity` | Nunca vem | não existe pra terceiro |
| Scraping da página pública via HTTP simples (sem browser) | ❌ Bloqueado na hora — ML devolve página de "suspicious traffic" (testado 28/07) | **não construir isso** — só funciona de dentro de um navegador real (a extensão) |

**Conclusão prática:** não existe NENHUM jeito de puxar receita/vendas de
anúncio de terceiro automaticamente, nem por API nem por scraping
simples. O único dado de vendas real vem da extensão lendo a página no
navegador do próprio usuário (texto "N vendidos" renderizado), uma vez,
no momento em que ele abre o produto. Não fabricar isso nem fingir que
atualiza sozinho.

### Token OAuth — trava obrigatória
`refresh_token` do ML é de uso único. `collector/src/auth.ts::accessToken()`
usa `SELECT ... FOR UPDATE` em `ml_credentials` pra dois processos
concorrentes (coletor + edge functions) não renovarem ao mesmo tempo e
queimarem a credencial da aplicação inteira. Essa trava foi copiada
fielmente pra `ml-preco` e `ml-busca-catalogo` — qualquer nova Edge
Function que precise de token do ML tem que copiar o mesmo padrão, não
reinventar.

---

## 5. Schema — tabelas/views principais e o que cada uma faz

- `categories` — árvore de categorias do ML (id, name, level, parent_id, root_id, path_names)
- `catalog_products` — produtos de catálogo coletados (id, name, picture, category_id)
- `product_rank_daily` — 1 linha por produto/categoria/dia com a posição no top 20 (histórico real)
- `product_price_daily` — preço mediano por produto/dia
- `product_rank_metrics` (matview) — snapshot atual de ranking
- `product_competition` — concorrência por produto de catálogo (median_price, listings, price_spread, full_share)
- `category_rank_metrics` (matview) — métricas cruas por categoria (rotatividade, preços) — **sem `oportunidade`, sem `score`**
- `category_opportunity_rank` (view, em cima da matview acima) — essa sim tem `oportunidade`, `score`, `categoria` (nome), `rotatividade_7d` etc. **Usar sempre esta pra ler oportunidade, nunca a matview crua.**
- `category_opportunity` / `category_calibration` / `category_seasonality` — **schema morto, 0 linhas.** Foram a PRIMEIRA tentativa (baseada em `sold_quantity`/receita), abandonada em 23/07 quando descobrimos que não dá pra ter receita real. Não usar, não repopular — considerar remover num cleanup futuro.
- `tracked_products` — produtos monitorados (user_id, product_id, pos_inicial, preco_inicial, **snapshot jsonb** ← real, capturado pela extensão)
- `tracked_sellers` — vendedores acompanhados (user_id, seller_id) — `user_id` tem `DEFAULT auth.uid()` (corrigido 27/07, ver §7)
- `sellers` — dado real de vendedor: nickname, city, state, permalink, is_official_store. **Não tem reputação/seguidores/vendas** — isso viria de `/users/{id}` do ML, nunca implementado.
- `collect_requests` — fila de "pedir coleta" (mlb, url, status, **snapshot jsonb** real da extensão)
- `category_search_log` + `categorias_recentes()` — histórico real de busca de categoria (novo, 27/07)
- `supplier_products` / `suppliers` — **Produtos locais, 0 linhas hoje.** Fornecedor real cadastrado via `npm run collect fornecedor arquivo.csv`. Cliente ainda não importou CSV.

---

## 6. Edge Functions

### `ml-preco`
Preço ao vivo por link/MLB solto, usado pelo botão "Aplicar" da
Calculadora quando o produto ainda não foi coletado. Tenta
`/products/{id}` → fallback `/products/{id}/items` (mediana) → fallback
`/items?ids=` (quase sempre 403, mantido só por garantia).

### `ml-busca-catalogo` (novo, 28/07)
Recebe `{texto}`, busca no catálogo real via `/products/search?q=`,
devolve `{catalog_product_id, nome, imagem, permalink, preco_mediano}`.
Usado pelo toggle "Encontrado no MeLi" em Produtos locais. **Sem
cache** — cada chamada é busca nova; se o volume crescer, cachear por
texto normalizado é o próximo passo óbvio.

### `assistente`
IA (Anthropic, modelo `claude-haiku-4-5-20251001` configurável via
`ANTHROPIC_MODEL`) respondendo perguntas sobre os dados reais do
próprio usuário (monitorados, alertas, quota). **Precisa de
`ANTHROPIC_API_KEY` — não configurada ainda.** Cliente precisa fornecer.

### `ml-callback`
OAuth callback do Mercado Livre (não mexido nesta sessão).

---

## 7. Bugs reais encontrados e corrigidos nesta sessão (28/07)

1. **`tracked_sellers.user_id` sem `DEFAULT`** — front mandava só
   `{seller_id}` no insert, sem user_id → "seguir vendedor" quebrava com
   violação de not-null. Fix: `ALTER TABLE ... ALTER COLUMN user_id SET
   DEFAULT auth.uid()` (aplicado em `tracked_sellers` e
   `category_search_log`).
2. **`listar_monitorados()` perdeu a coluna `snapshot`** numa migration
   anterior (`foto_monitorados` dropou+recriou pra somar `picture` e
   esqueceu de trazer `t.snapshot` de volta) → Receita
   acumulada/Vendas-mês/Total vendas ficavam sempre `—` **pra todo
   mundo**, não só pra quem nunca teve snapshot. Corrigido.
3. **`monitorar_produto()` nunca recebia o snapshot** que a extensão já
   captura da página (vendidos/preço/dias no ar) — nem no botão
   "Monitorar este produto" direto no ML (`extensao/content.js`), nem no
   botão "Monitorar" da fila de coleta no app. Corrigido nos 3 pontos
   (extensão manda `p_snapshot: fotoDaPagina()`, RPC aceita e grava,
   front-end da fila busca o snapshot do pedido em memória e repassa).

---

## 8. Features construídas nesta sessão (28/07), em ordem

- **Histórico de busca de categoria** (`category_search_log` +
  `categorias_recentes()`) — toda busca na aba Categorias fica salva;
  seção "Categorias recentes" clicável no topo da aba.
- **Produto clicável na fila** (Monitor > Aguardando coleta) — abre
  ficha real se já vinculado ao catálogo, ou a página real do ML se
  ainda fora do alcance da coleta.
- **Categoria clicável** na aba Categorias — leva pra página de detalhe
  própria (ver abaixo).
- **Página de detalhe de categoria** (`categoria_detalhe()` +
  `categoria_historico()`) — cards de rotatividade/preço/concorrência
  (dado real, sem Receita/Vendas) + gráfico de tendência real de 30 dias
  + tabela de produtos da categoria.
- **Gráfico de tendência melhor no Monitor** — coluna "Tendência (21d)"
  ganhou preço junto da posição (`sparkMini`, dual-linha).
- **Home com resumo real** — produtos monitorados, alertas novos,
  categoria em destaque hoje (`categoria_destaque()`, teaser grátis, não
  consome quota).
- **"Encontrado no MeLi"** — toggle em Produtos locais, busca ao vivo no
  catálogo pra produto sem vínculo (`ml-busca-catalogo`), badge, preço
  médio/margem calculados com dado real do match, clique abre detalhe.
- **Card de contato do fornecedor** no detalhe do produto local — nome,
  telefone/e-mail/site (reusa `desbloquear_fornecedor()` já existente).
- **Monitor atualiza sozinho** — poll de 45s enquanto a aba fica aberta
  (`setInterval` em `render()`, só ativo com `S.view==='monitor'`).
- **Correção de linha estourada** no Monitor (nome sem clamp quebrava em
  6+ linhas) — trunca em 2 linhas com reticência.
- **Fix dos 2 bugs de snapshot** (§7, itens 2 e 3).

---

## 9. Pendências explícitas (aguardando decisão/insumo do cliente)

- `ANTHROPIC_API_KEY` — pra ativar o assistente de IA (`supabase secrets
  set ANTHROPIC_API_KEY=...`).
- Provedor de geração de imagem/vídeo real — "Clipes e imagens" é só UI
  hoje, sem geração conectada.
- Links de mídia de exemplo com direito de uso (pro hub de Clipes) —
  **nunca usar os assets hospedados do concorrente** (já recusado 1x).
- Preço final dos planos (Assinatura) — hoje é placeholder
  R$97/197/397, botão "Assinar" desabilitado de propósito (sem gateway
  de pagamento ainda).
- Gateway de pagamento — decisão pendente.
- **CSV de fornecedor local** — `supplier_products`/`suppliers` estão
  com **0 linhas**. Toda a UI de Produtos locais (incluindo "Encontrado
  no MeLi") está pronta mas não testável ponta a ponta até isso ser
  importado (`npm run collect fornecedor arquivo.csv`).
- **Vendedor real no produto** — usuário confirmou via pergunta que quer
  mostrar nome/reputação/seguidores de quem vende cada produto (dado
  real, sem contato — API não dá e-mail/telefone de vendedor, nunca
  vai dar). **Ainda não construído.** Precisa: (a) capturar
  `/users/{id}` do ML pra reputação/seguidores (schema `sellers` hoje só
  tem nickname/cidade/estado/permalink), (b) linkar isso na tela de
  detalhe do produto e/ou na busca.

---

## 10. Cron diário (GitHub Actions)

`.github/workflows/coleta-diaria.yml` — roda `03:10 Brasília` todo dia.
**Confirmado funcionando ponta a ponta em 27/07** (run manual completou
em 4h58m com sucesso). Dois problemas históricos já resolvidos:
1. Secrets do repo estavam vazios → `gh secret set` a partir de
   `collector/.env`.
2. Runner do GitHub não alcança o Postgres direto (porta 5432) por
   IPv6 — `DATABASE_URL` do secret usa o **pooler** do Supabase
   (`aws-0-<region>.pooler.supabase.com`, IPv4), não a conexão direta.

Ver `gh run list` / `gh run view <id> --log-failed` pra diagnosticar se
quebrar de novo.

---

## 11. Convites de estilo/produto (pra manter consistência)

- Todo texto do app é em português informal, direto, sem enfeite.
- Cada limitação de dado (sem receita, sem contato, sem venda ao vivo)
  vira uma frase explicando o PORQUÊ técnico real, não só "indisponível".
- Botões/features não-funcionais ficam desabilitados com aviso, nunca
  escondidos silenciosamente nem fingindo funcionar.
- CSS usa variáveis (`--brand`, `--ink`, `--card`, `--bg`, `--tint`,
  `--line`) pra dark/light funcionar — nunca hardcodar `#fff`/cor fixa
  num elemento que precisa mudar com o tema (já causou bug visual 1x).
- Padrão de tabela: `<tr class="k" data-p="...">` pra linha clicável,
  com `ev.stopPropagation()` em qualquer botão/link dentro da linha.
