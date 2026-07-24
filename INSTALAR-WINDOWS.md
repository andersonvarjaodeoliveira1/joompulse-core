# Instalação no Windows

## 1. Descompactar

Extraia o zip para `C:\gringa-radar`.

Confira que a estrutura ficou assim — os scripts procuram os arquivos
por caminho, então os nomes das pastas importam:

```
C:\gringa-radar\
├── connect.sh
├── README.md
├── collector\
│   ├── setup.sh
│   ├── src\
│   └── test\
├── supabase\
│   ├── config.toml
│   ├── migrations\
│   └── functions\
└── test\
```

Se ao extrair apareceu uma pasta a mais (tipo
`C:\gringa-radar\joompulse-core\collector`), mova o conteúdo um nível
para cima ou use `C:\gringa-radar\joompulse-core` como sua pasta base.

## 2. Abrir o Git Bash

`chmod` e `./script.sh` são comandos de Linux — não funcionam no Prompt
de Comando nem no PowerShell. Use o Git Bash, que vem junto com o Git
para Windows.

Abra o Explorer em `C:\gringa-radar`, clique com o botão direito num
espaço vazio e escolha **"Open Git Bash here"**. No Windows 11 essa
opção fica dentro de "Mostrar mais opções".

Confirme que está no lugar certo:

```bash
ls
```

Precisa listar `collector`, `supabase`, `test`, `connect.sh`.

## 3. Instalar o CLI do Supabase

```bash
npm i -g supabase
supabase --version
```

Se der `command not found`, reinicie o computador — o Windows só
reconhece o Node depois de reiniciar.

## 4. Aplicar tudo no Supabase

```bash
chmod +x connect.sh
./connect.sh
```

Faz login, vincula ao projeto, aplica as cinco migrations e publica a
Edge Function. Vai pedir a senha do Postgres no meio.

## 5. Configurar o coletor

```bash
cd collector
chmod +x setup.sh
./setup.sh
npm install
```

O script pergunta a connection string, o Client ID, a chave secreta
(digitação oculta) e a redirect URI. No fim ele imprime os quatro
comandos `supabase secrets set` já preenchidos — copie e execute.

## 6. Autorizar e coletar

```bash
npm run collect auth-url      # abra o link, autorize no navegador
npm run collect auth-status   # confirme que gravou
npm run collect seed
npm run collect worker
```

## Problemas comuns

**`Permission denied`** — falta o `chmod +x` no script.

**`bash: ./connect.sh: No such file or directory`** — você não está na
pasta certa. Rode `ls` e confira.

**`npm: command not found`** — Node instalado mas não reconhecido.
Reinicie o computador.

**`\r: command not found` ou `syntax error near unexpected token`** — o
arquivo ganhou quebras de linha do Windows. Corrija com:

```bash
sed -i 's/\r$//' connect.sh collector/setup.sh test/run.sh
```

**`invalid_grant` na autorização** — a redirect URI cadastrada no painel
do Mercado Livre está diferente da que está no `.env`. Precisa ser
idêntica, incluindo barra final.

## Onde cada credencial vai

| Valor | Destino |
|---|---|
| Senha do Postgres | `.env` (via `setup.sh`) |
| Client Secret do ML | `.env` **e** `supabase secrets set` |
| Redirect URI | painel do ML, `.env` **e** `supabase secrets set` |
| ML_AUTH_STATE | `.env` **e** `supabase secrets set` |

Os valores marcados com **e** precisam ser idênticos nos dois lugares.
Divergência devolve sempre o mesmo erro genérico de `invalid_grant`.

Nada disso entra no Git — o `.gitignore` já bloqueia o `.env`.
