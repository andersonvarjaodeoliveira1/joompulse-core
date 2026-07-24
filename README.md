# GRINGA RADAR — núcleo de coleta

## Aviso importante: o pivô de 23/07/2026

O plano original media venda pela diferença de `sold_quantity` entre dois
dias. **Isso não é mais possível.** O diagnóstico daquele dia provou:

| Endpoint | Resposta |
|---|---|
| `/sites/MLB/search` (qualquer variação) | `403 forbidden` |
| `/items/{id}` de terceiro | `403 access_denied` |
| `/highlights/MLB/category/{cat}` | funciona — top 20 **com posição** |
| `/products/{id}/items` | funciona — todos os concorrentes, com preço |
| `/products/{id}` | funciona |
| `/users/{meu_id}/items/search` | funciona (só a própria conta) |

Não existe caminho oficial para descobrir anúncios que você não conhece,
nem para ler `sold_quantity` de terceiro.

**O que mudou:** o sinal de demanda passou de cardinal para ordinal. Em
vez de "vendeu 4.182 unidades", o produto diz "está em 3º e estava em
11º há 7 dias". Todo o schema, partições, quotas, RLS e testes seguem
valendo — mudou a semântica do que se grava, não a estrutura.

**O que se ganhou:** `/products/{id}/items` devolve todos os vendedores
disputando o mesmo produto, com preço de cada um. É a análise de
concorrência inteira, servida pela API oficial, que o endpoint bloqueado
nunca daria tão limpa.

## O formato dos destaques mudou em 24/07/2026

Até 23/07 o `/highlights` devolvia só `type: "PRODUCT"`. A partir de
24/07 passou a devolver três tipos:

| tipo | o que é | dá para enriquecer? |
|---|---|---|
| `PRODUCT` | produto de catálogo | sim, via `/products/{id}/items` |
| `ITEM` | anúncio individual | não, `/items/{id}` de terceiro dá 403 |
| `USER_PRODUCT` | variações de um vendedor | não |

O coletor filtrava só `PRODUCT` e descartava o resto **em silêncio**.
Numa varredura de 404 categorias com 20 destaques cada, isso significou
perder 8.080 posições achando que não havia dado.

Agora ele grava os três, mais qualquer tipo novo que apareça, com o
rótulo do que veio. O ranking vale igual nos três casos — estar em 3º
lugar significa a mesma coisa. O tipo muda o que dá para enriquecer
depois, não a validade da posição.

Para acompanhar a proporção:

```sql
select * from destaques_por_tipo;
```

## Ficha completa do produto

Uma chamada devolve tudo o que sabemos, sem consumir quota:

```sql
select ficha_produto('MLB54987753');
```

| Bloco | O que traz |
|---|---|
| ranking | posição atual, melhor, pior, oscilação, dias até entrar no top 10, se saiu |
| preço | atual, mínimo, máximo, típico, desconto máximo já praticado, variação 7d e 30d, volatilidade |
| líder | quem cobra menos, quanto abaixo da mediana, reputação, medalha, quantos produtos ele domina |
| concorrência | anúncios, vendedores, dispersão, share de Full, quem entrou nos últimos 30 dias, quem sumiu |
| categoria | rotatividade, preço mediano, concorrentes por produto |

Tudo isso sai de dado já coletado — nenhuma chamada nova à API. Importa
porque a API é o recurso escasso do projeto, e já perdemos dois
endpoints. Métrica derivada de dado guardado ninguém bloqueia.

**Dois números que o JoomPulse não mostra:**

`momento_de_preco` diz onde o preço de hoje está dentro da faixa
histórica: `barato` quer dizer que está perto do mínimo que já vimos,
`caro` que está no topo. É a diferença entre "custa R$ 110" e "custa
R$ 110 e já custou R$ 80".

`estabilidade` separa quem fica cravado numa posição de quem oscila.
Dois produtos com posição média 8 são coisas diferentes se um varia
entre 7 e 9 e o outro entre 3 e 18.

## Comandos do dia a dia

```bash
npm run collect categories   # árvore de categorias (semanal)
npm run collect rank         # top 20 de cada categoria  <- o diário
npm run collect produtos     # concorrentes e preços
npm run collect calibrar     # pares reais da própria conta
npm run collect rodada       # tudo acima + métricas + alertas + pedidos
npm run collect pedidos      # atende as lacunas apontadas pela extensão
npm run collect pedidos-status   # resumo da fila de pedidos
npm run collect fornecedor <csv> # importa catálogo de fornecedor
```

## O ciclo que fecha a cobertura

Só 37% das categorias do Mercado Livre têm ranking público. Quando um
usuário abre na extensão um produto fora dessa faixa, o pedido entra em
`collect_requests` junto com a categoria lida da página.

A rodada diária atende essa fila **ordenada por número de pedidos** — o
que mais gente procurou entra primeiro. Categoria sem ranking é marcada
como `sem_destaque` para não ser tentada de novo toda rodada.

É a lacuna de cobertura sendo priorizada por demanda real de quem usa,
em vez de palpite sobre o que coletar.

O `rank` é o que não pode falhar dia nenhum: buraco na série vira buraco
no gráfico de movimento que o cliente vê.

### A fila é por DIA, não por horas

A primeira versão usava "categoria não lida nas últimas 20 horas". Isso
quebrava a cadência: varredura terminando às 19h de ontem e rodada às 9h
de hoje davam 14 horas de diferença — e o job pulava tudo, deixando o dia
sem segunda leitura.

Agora a comparação é por data no fuso de São Paulo: entra na fila o que
ainda não foi lido **hoje**. O resultado não depende do horário em que
cada rodada roda.

Para forçar uma releitura no mesmo dia:

```bash
npm run collect rank 12000 forcar
```

## Medido vs estimado

Regra que atravessa todo o código: nunca misturar os dois na mesma
coluna.

**Medido** (não precisa de calibração): posição, movimento em 7 e 30
dias, persistência no top 10, número de concorrentes, preço mínimo,
máximo, mediano, dispersão, share de Full e de loja oficial.

**Estimado** (precisa de `calibration_points`): unidades por mês. A view
`product_units_estimate` devolve `null` onde não há calibração, em vez
de inventar número — e devolve faixa, nunca valor cravado.

A calibração vem de `npm run collect calibrar`, que lê os anúncios da
conta conectada, onde `sold_quantity` é acessível porque o token
pertence ao dono. Cada vendedor que conecta a conta melhora a estimativa
vendida a todos os outros.

---

# Histórico: Fase 1

O que o Lovable não constrói: modelo de dados, coletor e as métricas.
Quando isto estiver rodando, as telas são `SELECT` nas views.

```
supabase/config.toml                    config do CLI
supabase/migrations/…_schema.sql        categorias, anúncios, snapshots, fila
supabase/migrations/…_metrics.sql       vendas estimadas, tendência, oportunidade
supabase/migrations/…_users_quotas.sql  planos, quotas atômicas, monitor, RLS
supabase/migrations/…_ml_credentials.sql credencial OAuth (uma linha, sob trava)
supabase/migrations/…_grants.sql        quem enxerga o que pela API pública
supabase/functions/ml-callback/         retorno do OAuth (dispensa domínio)
collector/                              worker Node/TypeScript
connect.sh                              link + migrations + deploy
test/run.sh                             bateria completa contra Postgres local
```

Tudo neste repositório pode ir para o GitHub. O que **nunca** pode:
a senha do Postgres, o `ML_CLIENT_SECRET` e qualquer connection string
completa. O `.gitignore` da raiz já bloqueia `.env`; confira com
`git status` antes do primeiro commit.

## Atualizar tudo de uma vez

Depois de extrair uma versão nova do zip:

```bash
./aplicar.sh
```

Confere o ambiente, aplica as migrations pendentes, instala as
dependências e mostra o estado da coleta. No fim lista o que falta e só
você pode fazer: recarregar a extensão no Chrome e agendar a coleta.

## Ordem de execução

**1. Banco.** Vincule o repositório ao projeto e aplique as migrations:

```bash
npm i -g supabase          # ou: brew install supabase/tap/supabase
./connect.sh               # login + link + db push + deploy da função
```

O `connect.sh` já tem o ref do projeto embutido.

**Não rode `supabase init`.** O painel do Supabase sugere esse comando,
mas ele cria um `config.toml` novo por cima do que está aqui — levando
junto a linha `verify_jwt = false` da função `ml-callback`, sem a qual a
autorização do Mercado Livre nunca completa. O repositório já vem
inicializado.

O `<ref>` está na URL do painel (`supabase.com/dashboard/project/<ref>`).
O `db push` aplica os arquivos de `supabase/migrations/` na ordem do nome
e registra o que já rodou — então é seguro repetir o comando.

Na criação do projeto, deixe **"Automatically expose new tables"
desmarcado** e escolha a região **South America (São Paulo)** — a região
não muda depois. A migration `…_grants.sql` assume esse padrão e libera
explicitamente só o que o front precisa. Confira depois do push:

```sql
select table_name, privilege_type
  from information_schema.role_table_grants
 where grantee = 'anon' and table_schema = 'public';
```

Tem que voltar vazio.

Se preferir não instalar o CLI, dá para colar os arquivos no SQL
Editor, na ordem. Mas aí você perde o controle de versão do schema, que
é justamente o que evita produção e desenvolvimento divergirem.

**2. App no Mercado Livre.** Em `developers.mercadolivre.com.br`, na sua
aplicação, configure:

- **Redirect URI** — obrigatória. Precisa ser https e precisa bater
  exatamente com o `ML_REDIRECT_URI` do `.env`, incluindo barra final.
  Diferença de um caractere devolve `invalid_grant`.
- **Escopos** — marque apenas `read` e `offline_access`. Não peça `write`:
  o coletor só lê dados públicos de mercado, e pedir permissão de escrita
  na conta de alguém derruba a confiança de quem for autorizar seu app.

**3. Redirect URI sem domínio próprio.** Você não precisa de domínio: o
Supabase já te dá uma URL https. Publique a Edge Function de retorno e
use o endereço dela.

```bash
supabase functions deploy ml-callback
```

O `config.toml` já declara `verify_jwt = false` para essa função — o
Mercado Livre redireciona o navegador sem cabeçalho de autenticação, e
sem isso a função responderia 401. Está no arquivo de propósito, para a
configuração não se perder num deploy futuro.

A redirect URI fica sendo:

```
https://<ref-do-projeto>.supabase.co/functions/v1/ml-callback
```

Cadastre exatamente esse endereço no painel da aplicação no ML.

**4. Configuração.** O `setup.sh` monta o `.env` no seu terminal, com a
digitação do secret oculta, e deduz a redirect URI a partir da própria
connection string do Supabase:

```bash
cd collector
chmod +x setup.sh && ./setup.sh
npm install
```

Ele também gera um `ML_AUTH_STATE` aleatório. Registre os mesmos valores
como segredos da função:

```bash
supabase secrets set ML_CLIENT_ID=...
supabase secrets set ML_CLIENT_SECRET=...
supabase secrets set ML_REDIRECT_URI=...
supabase secrets set ML_AUTH_STATE=...
```

**5. Autorização.** O ML não tem grant de máquina — a aplicação sempre
age em nome de uma conta que autorizou pelo navegador. Uma vez só:

```bash
npm run collect auth-url      # abra o link, autorize
npm run collect auth-status   # confere que gravou
```

A Edge Function recebe o código e faz a troca no mesmo instante. Sem
copiar e colar, sem corrida contra o relógio — o `authorization_code`
expira em poucos minutos e é aí que a maioria das tentativas manuais
falha.

**6. Primeira carga.**

```bash
npm run collect seed      # sincroniza a árvore de categorias e enfileira
npm run collect worker    # varre as categorias (algumas horas na 1ª vez)
npm run collect metrics full
```

**7. Cron.** A partir daqui o que importa é a regularidade:

| Quando | Comando |
|---|---|
| Todo dia, 03:00 | `npm run collect daily` |
| Toda segunda | `npm run collect categories` e `npm run collect sellers` |
| Semanal | `npm run collect seed` (pega categorias novas) |

Hospede num worker com cron de verdade — Railway, Fly, Render, ou uma VPS
com `crontab`. Não use Edge Function do Supabase para a rodada diária: ela
tem teto de tempo de execução e o `refresh` de 20 mil anúncios estoura.

## Testes

As migrations e as métricas têm bateria automatizada. Com um Postgres
local rodando:

```bash
./test/run.sh
```

Ele cria um banco descartável, aplica as cinco migrations, popula com
dados sintéticos de resposta conhecida e confere:

- vendas estimadas em quatro casos (normal, republicação, buraco de
  coleta, promoção)
- concentração de mercado (fatia do líder e HHI)
- quota: limite respeitado, recurso bloqueado por plano, isolamento
  entre usuários
- RLS: um usuário não enxerga nem apaga dados de outro
- exposição: o papel `anon` sem nenhum privilégio, e snapshots, fila e
  credenciais fora do alcance do front
- concorrência: 20 chamadas simultâneas a `consume_quota` contra um
  limite de 5, conferindo que o contador para em 5

Para o coletor, com o banco de testes de pé:

```bash
cd collector
DATABASE_URL=postgresql://.../gringa_test npm run test:db
```

Roda as 13 queries de `db.ts` de verdade — upsert de anúncio com
categoria desconhecida, extração de marca, fila de jobs com retry,
partições, refresh das métricas.

## O refresh token é a peça frágil do sistema

O `access_token` do ML dura 6 horas. Para renovar sem intervenção humana
existe o `refresh_token` — e ele é **de uso único**. Cada renovação
devolve um novo e invalida o anterior; só o último gerado é aceito.

Duas consequências práticas:

- **O token mora no Postgres, não no `.env`.** A renovação acontece dentro
  de uma transação com `SELECT ... FOR UPDATE` e uma segunda checagem
  depois da trava. Sem isso, dois workers renovando ao mesmo tempo
  queimam a credencial e você precisa reautorizar no navegador.
- **Não renove por precaução.** O código só troca o token quando faltam
  menos de 5 minutos para expirar, como a própria documentação do ML
  recomenda. Cada renovação desnecessária é uma chance de corrida.

Se mesmo assim a credencial morrer (troca de senha na conta, revogação,
fraude detectada pelo ML), o sintoma é `invalid_grant` no log. A cura é
refazer `auth-url` + `auth-code`. Vale um alerta no seu monitoramento
para isso, porque o coletor para em silêncio.

## O que esperar, e quando

| Dia | O que você tem |
|---|---|
| 1 | Catálogo. Preço atual, vendedor, categoria. Nenhuma métrica de venda. |
| 2 | Primeira estimativa de venda (1 dia de delta). Ruidosa, não mostre ainda. |
| 30 | `units_30d`, `revenue_30d`, histórico de preço. **Aqui o produto existe.** |
| 60 | Tendência (30d vs 30d anteriores). O gráfico que o cliente quer ver. |
| 365 | Sazonalidade. O diferencial que ninguém copia em três meses. |

Esse calendário é o motivo de o coletor vir antes da tela. Cada dia que
você adia a coleta é um dia a mais até ter o que vender.

## Pontos que você precisa verificar antes de confiar no código

Escrevi isto com o que sei da API do ML até janeiro de 2026, e esses
endpoints mudam. Confira antes de rodar em escala:

- **`sold_quantity` na resposta.** É a base de tudo. O ML já restringiu e
  já arredondou esse campo em versões anteriores da API. Rode
  `npm run collect discover MLB1051` (celulares) e olhe uma linha de
  `item_snapshots`: se `sold_quantity` vier nulo ou arredondado em faixas,
  todo o `002_metrics.sql` precisa de outra fonte de sinal — as
  alternativas são `available_quantity` decrescente e o campo de
  quantidade vendida da página do anúncio.
- **Teto de `offset`.** Assumi 1000. Se mudou, ajuste `discoverItems`.
- **Rate limit real.** `ML_RATE_PER_SEC=8` é chute conservador. Monitore
  `select * from collect_log order by created_at desc` e suba devagar.
- **Termos de uso.** Coleta em volume esbarra nos termos do Mercado Livre.
  Vale ler antes de escalar — concorrentes desse nicho já tiveram
  problema. O código usa a API oficial autenticada de propósito, que é o
  caminho defensável.

## Detalhes de implementação que importam

**Vendas estimadas.** `units_sold = sold_quantity(hoje) − sold_quantity(ontem)`,
com dois tratamentos: queda vira 0 (anúncio republicado zera o contador,
não é venda negativa) e `gap_days` registra buracos na série para você
poder descartar o ponto no gráfico.

**Receita.** Usa o preço daquele dia, não a média do mês. Promoção aparece.

**Monopolização.** `top_seller_share` é a fatia do maior vendedor — número
legível para a tela. `hhi` é o Herfindahl-Hirschman, que é o número honesto.
Mostre o primeiro, ordene pelo segundo.

**Score de oportunidade.** Ver `category_opportunity` em `002_metrics.sql`.
Normaliza por percentil dentro do mesmo nível da árvore, porque comparar
"Celulares" com "Kefir" em valor absoluto não diz nada. Os pesos
(35/25/25/15) estão à vista de propósito — é o parâmetro mais importante do
seu produto e é exatamente onde dá para ficar melhor que o JoomPulse.

**Quotas.** `consume_quota('product_search')` checa e incrementa numa única
instrução `UPDATE`. Se você fizer `SELECT` e depois `UPDATE`, dois cliques
simultâneos furam o limite. Chame sempre *antes* da busca. Para desenhar o
badge "Pesquisas restantes: N" use `quota_status()`, que não gasta nada.

## Para o Lovable, depois

Estas são as superfícies que o front consome:

| Tela | Fonte |
|---|---|
| Busca de produtos | `item_search_view` |
| Categorias | `category_opportunity` + `category_seasonality` |
| Ficha do produto | `item_daily_sales` filtrado por `item_id` |
| Monitor | `tracked_items` + `tracked_folders` |
| Badge de quota | `quota_status()` |
| Qualquer ação limitada | `consume_quota(feature)` antes de executar |

Nenhuma tela do Lovable deve tocar `item_snapshots` direto.
