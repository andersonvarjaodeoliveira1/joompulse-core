# Coleta automática

O dado é o ativo do produto, e ele só existe se a coleta rodar todo dia.
**Buraco na série não se recupera depois** — o ranking de ontem não fica
guardado em lugar nenhum do Mercado Livre.

Três caminhos, do mais confiável ao mais simples.

## 1. GitHub Actions — recomendado

Roda na nuvem, de graça, sem servidor e sem depender do seu computador.

**Passos:**

1. Suba o repositório para o GitHub (pode ser privado)
2. No GitHub: **Settings → Secrets and variables → Actions → New repository secret**

   | Nome | Valor |
   |---|---|
   | `DATABASE_URL` | connection string do Supabase, porta 5432 |
   | `ML_CLIENT_ID` | id da aplicação do Mercado Livre |
   | `ML_CLIENT_SECRET` | a chave secreta |
   | `ML_REDIRECT_URI` | a mesma cadastrada no painel do ML |

3. Aba **Actions** → **Coleta diária** → **Run workflow** para testar

Depois disso roda sozinho às 03:10 de Brasília.

**Sobre o limite:** repositório público tem tempo ilimitado. Privado tem
2.000 minutos por mês. A rodada leva cerca de 60 minutos depois que as
categorias adormecidas saem do caminho — cabe, mas com pouca folga. Se
apertar, use a opção 2.

**Antes de subir para o GitHub**, confirme que o `.env` não vai junto:

```bash
git status --short | grep .env    # não pode retornar nada
```

## 2. Railway, Fly ou VPS

Use se o repositório for privado e o tempo do GitHub ficar apertado, ou
se quiser log e retentativa num lugar só.

O `collector/Dockerfile` está pronto. No Railway:

1. New Project → Deploy from GitHub repo
2. Root Directory: `collector`
3. Variables: as mesmas quatro de cima
4. Settings → Cron Schedule: `10 6 * * *`

Custa alguns dólares por mês e tira o teto de minutos.

## 3. Agendador do Windows

Funciona hoje, sem conta em lugar nenhum. **Mas só roda com o
computador ligado.**

No PowerShell como administrador, dentro de `joompulse-core`:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\agendar-windows.ps1
```

Agenda para 03:10 e liga o `StartWhenAvailable`, que executa assim que o
PC ligar caso estivesse desligado no horário. Reduz a chance de perder
um dia, mas não elimina.

Log em `collector\coleta.log`.

## A verificação que impede perder dias

O último passo do workflow roda `npm run collect verificar`, que **falha
de propósito** se:

- gravou menos de 3.000 posições no dia, ou
- o volume caiu mais de 50% em relação a ontem

Quando falha, o GitHub manda e-mail para o dono do repositório.

Isso existe por causa de 24/07/2026. Naquele dia o Mercado Livre mudou o
formato da resposta dos destaques, o coletor descartou tudo o que não
reconhecia, e ainda assim imprimiu "concluído". Sem uma checagem que
falha, um problema desses passa uma semana despercebido — e cada dia
perdido é buraco permanente, porque o ranking de ontem não existe mais
em lugar nenhum.

**Coleta que roda e grava zero deve ser tratada como erro, não como
sucesso.**

## Conferir se está saudável

Depois de qualquer rodada:

```bash
cd collector
npm run collect resumo      # panorama
npm run collect verificar   # falha se a coleta de hoje não veio
npm run collect diag        # testa o endpoint quando algo dá errado
```

Mostra dias de histórico, última leitura, posições coletadas hoje e
alertas gerados. **O número que importa é "dias de histórico"** — ele
precisa crescer de um em um. Se travar, alguma rodada falhou.

No SQL Editor, a mesma checagem:

```sql
select captured_date, count(*) as posicoes
from product_rank_snapshots
group by captured_date order by captured_date desc limit 10;
```

Uma linha por dia, sem pular datas.

## O que a rodada faz, em ordem

1. **rank** — top 20 de cada categoria ainda não lida hoje
2. **produtos** — concorrentes e preços dos produtos rankeados
3. **pedidos** — lacunas apontadas pelos usuários na extensão
4. **rank-metrics** — recalcula as views e gera os alertas do Monitor

Às segundas ela também sincroniza vendedores e a árvore de categorias.

## Categorias adormecidas

Das 6.733 folhas, cerca de 3.891 têm destaques. As outras devolvem lista
vazia e custam uma chamada cada.

Depois de 3 leituras vazias seguidas, a categoria passa para releitura
semanal em vez de diária. Não é desistência: se o Mercado Livre voltar a
publicar destaques ali, o contador zera e ela volta ao ritmo diário na
mesma hora.

Isso corta cerca de 40% do tempo da rodada.
