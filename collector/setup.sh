#!/usr/bin/env bash
#
# Monta o .env do coletor sem a chave secreta passar por lugar nenhum
# além do seu terminal. A digitação dela fica oculta.
#
#   chmod +x setup.sh && ./setup.sh
#
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "  Configuração do coletor"
echo "  ─────────────────────────────────────────────"
echo

if [ -f .env ]; then
  read -rp "  Já existe um .env. Sobrescrever? [s/N] " ow
  [[ "$ow" =~ ^[sS]$ ]] || { echo "  Cancelado."; exit 0; }
fi

read -rp "  Connection string do Postgres (Supabase): " DB_URL
[ -n "$DB_URL" ] || { echo "  Obrigatório."; exit 1; }

if [[ "$DB_URL" == *":6543"* ]]; then
  echo
  echo "  ⚠ Porta 6543 é o transaction pooler — não suporta prepared"
  echo "    statements e o coletor vai falhar. Use a porta 5432"
  echo "    (Session pooler ou Direct connection)."
  echo
  read -rp "  Continuar assim mesmo? [s/N] " go
  [[ "$go" =~ ^[sS]$ ]] || exit 1
fi

read -rp "  Client ID do app ML [5716684925480652]: " CID
CID="${CID:-5716684925480652}"

# -s oculta a digitação: a chave não fica visível na tela nem no
# histórico do shell.
read -rsp "  Client Secret (não aparece na tela): " CSEC
echo
[ -n "$CSEC" ] || { echo "  Obrigatório."; exit 1; }

# A connection string do Supabase carrega o ref do projeto em
# db.<ref>.supabase.co — dá para montar a redirect URI a partir dela,
# sem você precisar de domínio próprio.
REF="$(printf '%s' "$DB_URL" | sed -n 's#.*db\.\([a-z0-9]\{16,\}\)\.supabase\.co.*#\1#p')"
if [ -n "$REF" ]; then
  SUGG="https://$REF.supabase.co/functions/v1/ml-callback"
  echo
  echo "  Projeto Supabase detectado: $REF"
  echo "  Redirect URI sugerida (Edge Function ml-callback):"
  echo "      $SUGG"
  echo
  read -rp "  Redirect URI [enter aceita a sugestão]: " RURI
  RURI="${RURI:-$SUGG}"
else
  read -rp "  Redirect URI (idêntica à cadastrada no painel): " RURI
fi
[ -n "$RURI" ] || { echo "  Obrigatório."; exit 1; }

if [[ "$RURI" != https://* ]]; then
  echo "  ⚠ O Mercado Livre exige https na redirect URI."
  read -rp "  Continuar assim mesmo? [s/N] " go
  [[ "$go" =~ ^[sS]$ ]] || exit 1
fi

read -rp "  Site [MLB]: " SITE
SITE="${SITE:-MLB}"

# Segredo compartilhado com a Edge Function (proteção CSRF do OAuth).
STATE="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

umask 077   # o .env nasce legível só pelo seu usuário
cat > .env <<EOF
DATABASE_URL=$DB_URL
DB_POOL=5

ML_CLIENT_ID=$CID
ML_CLIENT_SECRET=$CSEC
ML_REDIRECT_URI=$RURI
ML_AUTH_STATE=$STATE
ML_SITE_ID=$SITE
ML_RATE_PER_SEC=8

DAILY_BATCH=20000
EOF
chmod 600 .env
unset CSEC

grep -qx '.env' .gitignore 2>/dev/null || echo '.env' >> .gitignore

echo
echo "  .env criado (permissão 600) e protegido no .gitignore."
echo
echo "  1. Cadastre esta redirect URI no painel do Mercado Livre,"
echo "     exatamente assim, sem barra a mais nem a menos:"
echo
echo "      $RURI"
echo
echo "  2. Publique a Edge Function de retorno:"
echo
echo "      supabase functions deploy ml-callback --no-verify-jwt"
echo "      supabase secrets set ML_CLIENT_ID=$CID"
echo "      supabase secrets set ML_CLIENT_SECRET=<a mesma chave>"
echo "      supabase secrets set ML_REDIRECT_URI=$RURI"
echo "      supabase secrets set ML_AUTH_STATE=$STATE"
echo
echo "  3. Autorize:"
echo
echo "      npm install"
echo "      npm run collect auth-url      # abra o link, autorize, acabou"
echo "      npm run collect auth-status"
echo
