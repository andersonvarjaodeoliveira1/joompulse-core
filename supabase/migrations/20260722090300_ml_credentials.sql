-- =====================================================================
-- 004_ml_credentials.sql — credencial OAuth do Mercado Livre
--
-- Por que isso é uma TABELA e não uma variável de ambiente:
--
-- O refresh_token do ML é de USO ÚNICO. Cada renovação devolve um novo e
-- invalida o anterior, e só o último gerado é aceito. Se dois processos
-- do coletor renovarem ao mesmo tempo, um vence e o outro queima a
-- credencial da aplicação inteira — aí só reautorizando no navegador.
--
-- Guardando no Postgres, a renovação acontece dentro de uma transação
-- com SELECT ... FOR UPDATE. O segundo processo espera, reconsulta e
-- descobre que o token já foi renovado. Ninguém queima nada.
-- =====================================================================

create table if not exists ml_credentials (
  id            smallint primary key default 1,
  client_id     text not null,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  scope         text,
  ml_user_id    bigint,
  last_refresh  timestamptz,
  refresh_count int not null default 0,
  updated_at    timestamptz not null default now(),
  constraint linha_unica check (id = 1)
);

alter table ml_credentials enable row level security;
-- Nenhuma policy de leitura: só a service_role (o coletor) enxerga.
-- O front nunca deve ver esta tabela.

comment on table ml_credentials is
  'Credencial OAuth do ML. Uma linha só. Renovação sempre sob FOR UPDATE.';
