#!/usr/bin/env bash
#
# Aplica tudo que está pendente de uma vez.
#
#   ./aplicar.sh
#
# Faz: confere o ambiente, aplica as migrations novas, instala as
# dependências do coletor e mostra o estado da coleta.
#
# NÃO faz (porque depende de você): agendar no GitHub Actions e
# recarregar a extensão no Chrome. O script diz o que falta no fim.
#
set -uo pipefail
cd "$(dirname "$0")"

verde()  { printf '\033[32m%s\033[0m\n' "$1"; }
amare()  { printf '\033[33m%s\033[0m\n' "$1"; }
verm()   { printf '\033[31m%s\033[0m\n' "$1"; }
titulo() { echo; echo "  $1"; echo "  ─────────────────────────────────────────────"; }

falhou=0

# ---------------------------------------------------------------------
titulo "1. Conferindo o ambiente"

if ! command -v supabase >/dev/null 2>&1; then
  verm "  supabase CLI não encontrado. Instale com: npm i -g supabase"
  falhou=1
else
  echo "  supabase CLI  $(supabase --version 2>/dev/null | head -1)"
fi

if ! command -v npm >/dev/null 2>&1; then
  verm "  npm não encontrado. Instale o Node.js e reinicie o computador."
  falhou=1
else
  echo "  node          $(node --version)"
fi

if [ ! -f collector/.env ]; then
  verm "  Falta collector/.env — rode ./collector/setup.sh primeiro."
  falhou=1
else
  echo "  .env          presente ($(grep -c . collector/.env) linhas)"
fi

if ! grep -q 'verify_jwt = false' supabase/config.toml 2>/dev/null; then
  verm "  config.toml sem verify_jwt=false. Alguém rodou 'supabase init' por cima?"
  falhou=1
fi

migs=$(ls supabase/migrations/*.sql 2>/dev/null | wc -l)
echo "  migrations    $migs arquivo(s)"

[ "$falhou" = "1" ] && { echo; verm "  Corrija os itens acima antes de continuar."; exit 1; }

# ---------------------------------------------------------------------
titulo "2. Aplicando migrations no Supabase"
echo "  (responda Y quando ele perguntar)"
echo
if supabase db push; then
  verde "  migrations aplicadas"
else
  verm "  o db push falhou — confira a mensagem acima"
  exit 1
fi

# ---------------------------------------------------------------------
titulo "3. Dependências do coletor"
( cd collector && npm install --no-audit --no-fund --silent ) \
  && verde "  dependências instaladas" \
  || { verm "  npm install falhou"; exit 1; }

# ---------------------------------------------------------------------
titulo "4. Credencial do Mercado Livre"
( cd collector && npm run --silent collect auth-status ) 2>&1 | sed 's/^/  /'

# ---------------------------------------------------------------------
titulo "5. Estado da coleta"
( cd collector && npm run --silent collect resumo ) 2>&1 | sed 's/^/  /'

# ---------------------------------------------------------------------
titulo "O que falta, e só você pode fazer"

cat <<'FIM'

  RECARREGAR A EXTENSÃO
    chrome://extensions  ->  ícone de seta circular no card Gringa Radar
    Sem isso o Chrome continua servindo a versão antiga.

  AGENDAR A COLETA NA NUVEM
    1. Suba este repositório para o GitHub
    2. Settings > Secrets and variables > Actions > New repository secret:
         DATABASE_URL, ML_CLIENT_ID, ML_CLIENT_SECRET, ML_REDIRECT_URI
    3. Aba Actions > Coleta diária > Run workflow (para testar)

    Detalhes em AUTOMATIZAR.md

  OU, SE PREFERIR NO WINDOWS MESMO
    PowerShell como administrador, nesta pasta:
      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\agendar-windows.ps1

    Atenção: só roda com o computador ligado, e dia perdido não volta.

FIM

verde "  Pronto."
echo
