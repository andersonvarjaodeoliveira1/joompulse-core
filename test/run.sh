#!/usr/bin/env bash
#
# Sobe um banco descartável, aplica as migrations e roda toda a bateria.
# Precisa de um Postgres local rodando e de um superusuário.
#
#   ./test/run.sh                      # usa postgres@localhost
#   PGURL=... ./test/run.sh            # ou aponte para outro
#
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${TEST_DB:-gringa_test}"
PSQL="${PSQL:-psql}"

echo
echo "  Bateria de testes — banco $DB"
echo "  ─────────────────────────────────────────────"

$PSQL -q -d postgres -c "drop database if exists $DB" >/dev/null
$PSQL -q -d postgres -c "create database $DB" >/dev/null

$PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f test/00_supabase_shim.sql

echo
echo "  Migrations"
for f in supabase/migrations/*.sql; do
  if $PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null 2>&1; then
    echo "  OK    $(basename "$f")"
  else
    echo "  FALHA $(basename "$f")"
    $PSQL -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1 | grep -i error | head -3
    exit 1
  fi
done

echo
echo "  Métricas"
$PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f test/01_fixture.sql >/dev/null
$PSQL -q -d "$DB" -f test/02_assert_metrics.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  Segurança"
$PSQL -q -d "$DB" -f test/03_assert_security.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  Ranking"
$PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f test/04_fixture_rank.sql >/dev/null
$PSQL -q -d "$DB" -f test/05_assert_rank.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  RPC e quota no servidor"
$PSQL -q -d "$DB" -f test/06_assert_rpc.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  Monitor e alertas"
$PSQL -q -d "$DB" -f test/07_assert_monitor.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  Filtros e busca avançada"
$PSQL -q -d "$DB" -f test/08_assert_filtros.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  Fornecedores e produtos locais"
$PSQL -q -d "$DB" -f test/09_assert_fornecedores.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  Extensão do Chrome"
$PSQL -q -d "$DB" -f test/10_assert_extensao.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  Busca guiada"
$PSQL -q -d "$DB" -f test/11_assert_guiada.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  Ficha completa do produto"
$PSQL -q -d "$DB" -f test/11_assert_ficha.sql 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/psql:[^ ]* //;s/NOTICE:  /  /;s/ERROR:/  ERRO:/'

echo
echo "  Concorrência da quota (20 simultâneas contra limite de 5)"
$PSQL -q -d "$DB" -c "delete from usage_counters" >/dev/null
for i in $(seq 1 20); do
  $PSQL -tAq -d "$DB" -c "set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
    select consume_quota('product_search')->>'allowed';" >/dev/null &
done
wait
USED=$($PSQL -tAq -d "$DB" -c "select used from usage_counters where feature='product_search'")
if [ "$USED" = "5" ]; then
  echo "  OK    contador parou em 5 (nenhuma corrida furou o limite)"
else
  echo "  FALHA contador chegou a $USED, deveria ser 5"
  exit 1
fi

echo
echo "  ─────────────────────────────────────────────"
echo "  Para testar o coletor contra este banco:"
echo "      cd collector && DATABASE_URL=postgresql://.../$DB npx tsx test/db.integration.ts"
echo
