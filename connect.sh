#!/usr/bin/env bash
#
# Vincula este repositório ao projeto Supabase e aplica tudo.
#
#   chmod +x connect.sh && ./connect.sh
#
# ATENÇÃO ao comando `supabase init` que o painel do Supabase sugere:
# ele CRIA um supabase/config.toml novo e sobrescreve o que já existe
# aqui — junto com a linha `verify_jwt = false` da função ml-callback,
# sem a qual a autorização do Mercado Livre nunca completa.
# Este script pula o init de propósito.
#
set -euo pipefail
cd "$(dirname "$0")"

REF="blnupzfgfhvykrgmvwhw"

echo
echo "  Conectando ao projeto $REF"
echo "  ─────────────────────────────────────────────"
echo

if ! command -v supabase >/dev/null 2>&1; then
  echo "  Supabase CLI não encontrado. Instale com:"
  echo "      npm i -g supabase"
  echo "  ou:  brew install supabase/tap/supabase"
  exit 1
fi
echo "  CLI: $(supabase --version 2>/dev/null | head -1)"

if [ ! -f supabase/config.toml ]; then
  echo "  ✗ supabase/config.toml não encontrado."
  echo "    Rode este script a partir da raiz do repositório."
  exit 1
fi

if ! grep -q 'verify_jwt = false' supabase/config.toml; then
  echo
  echo "  ⚠ O config.toml não tem 'verify_jwt = false' para ml-callback."
  echo "    Provavelmente alguém rodou 'supabase init' por cima."
  echo "    Restaure o arquivo antes de continuar."
  exit 1
fi
echo "  config.toml íntegro (verify_jwt = false presente)"

echo
echo "  1/4  Login"
supabase projects list >/dev/null 2>&1 || supabase login

echo
echo "  2/4  Vinculando ao projeto"
supabase link --project-ref "$REF"

echo
echo "  3/4  Aplicando migrations"
echo "       (vai pedir a senha do banco — a mesma do .env)"
supabase db push

echo
echo "  4/4  Publicando a Edge Function de retorno do OAuth"
supabase functions deploy ml-callback

cat <<EOF

  ─────────────────────────────────────────────
  Pronto. Confira duas coisas antes de seguir.

  1. No SQL Editor, esta consulta tem que voltar VAZIA:

       select table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = 'anon' and table_schema = 'public';

     Se voltar linhas, desligue "Automatically expose new tables"
     em Settings > API e rode ./connect.sh de novo.

  2. Cadastre esta redirect URI no painel do Mercado Livre,
     exatamente assim:

       https://$REF.supabase.co/functions/v1/ml-callback

  Depois, os segredos da função e a autorização:

       supabase secrets set ML_CLIENT_ID=5716684925480652
       supabase secrets set ML_CLIENT_SECRET=<sua chave nova>
       supabase secrets set ML_REDIRECT_URI=https://$REF.supabase.co/functions/v1/ml-callback
       supabase secrets set ML_AUTH_STATE=<o valor gerado pelo setup.sh>

       cd collector && ./setup.sh && npm install
       npm run collect auth-url

EOF
