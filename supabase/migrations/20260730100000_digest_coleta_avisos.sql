-- =====================================================================
-- Digest diário da coleta ML + avisos no sistema
--
-- Depois da coleta, registramos:
--   • quantos produtos ENTRARAM NO RANKING pela 1ª vez hoje
--   • quantos produtos novos no catálogo (first_seen hoje)
--   • posições / alertas do dia
-- E criamos um aviso visível no app (Home).
-- =====================================================================

create table if not exists collection_digests (
  dia              date primary key,
  posicoes         int not null default 0,
  produtos_total   int not null default 0,
  novos_ranking    int not null default 0,
  novos_catalogo   int not null default 0,
  alertas          int not null default 0,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);

create table if not exists system_notifications (
  id         bigserial primary key,
  dia        date not null,
  tipo       text not null,
  titulo     text not null,
  detalhe    text,
  payload    jsonb not null default '{}'::jsonb,
  criado_em  timestamptz not null default now(),
  unique (dia, tipo)
);

create table if not exists system_notification_reads (
  user_id         uuid not null references profiles(id) on delete cascade,
  notification_id bigint not null references system_notifications(id) on delete cascade,
  lido_em         timestamptz not null default now(),
  primary key (user_id, notification_id)
);

alter table collection_digests enable row level security;
alter table system_notifications enable row level security;
alter table system_notification_reads enable row level security;

drop policy if exists digests_select on collection_digests;
create policy digests_select on collection_digests
  for select to authenticated using (true);

drop policy if exists avisos_select on system_notifications;
create policy avisos_select on system_notifications
  for select to authenticated using (true);

drop policy if exists avisos_reads_own on system_notification_reads;
create policy avisos_reads_own on system_notification_reads
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select on collection_digests to authenticated;
grant select on system_notifications to authenticated;
grant select, insert, delete on system_notification_reads to authenticated;

-- Conta e grava o digest do dia + aviso no sistema.
create or replace function registrar_digest_coleta(p_dia date default current_date)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_posicoes int;
  v_produtos int;
  v_novos_rank int;
  v_novos_cat int;
  v_alertas int;
  v_titulo text;
  v_detalhe text;
  v_id bigint;
begin
  select count(*)::int into v_posicoes
    from product_rank_snapshots
   where captured_date = p_dia;

  select count(*)::int into v_produtos from catalog_products;

  -- Produto no ranking hoje que NUNCA tinha aparecido antes
  select count(*)::int into v_novos_rank
    from (
      select distinct product_id
        from product_rank_snapshots
       where captured_date = p_dia
    ) hoje
   where not exists (
     select 1 from product_rank_snapshots a
      where a.product_id = hoje.product_id
        and a.captured_date < p_dia
   );

  select count(*)::int into v_novos_cat
    from catalog_products
   where (first_seen_at at time zone 'America/Sao_Paulo')::date = p_dia;

  select count(*)::int into v_alertas
    from product_alerts where dia = p_dia;

  insert into collection_digests as d (
    dia, posicoes, produtos_total, novos_ranking, novos_catalogo, alertas, atualizado_em
  ) values (
    p_dia, v_posicoes, v_produtos, v_novos_rank, v_novos_cat, v_alertas, now()
  )
  on conflict (dia) do update set
    posicoes = excluded.posicoes,
    produtos_total = excluded.produtos_total,
    novos_ranking = excluded.novos_ranking,
    novos_catalogo = excluded.novos_catalogo,
    alertas = excluded.alertas,
    atualizado_em = now();

  v_titulo := case
    when v_novos_rank = 0 and v_novos_cat = 0 then
      'Coleta do dia concluída — nenhum produto novo'
    when v_novos_rank = 1 then
      '1 produto novo entrou no ranking hoje'
    else
      v_novos_rank || ' produtos novos entraram no ranking hoje'
  end;

  v_detalhe := format(
    'Catálogo: %s novo(s). Posições lidas: %s. Alertas do Monitor: %s.',
    v_novos_cat, v_posicoes, v_alertas
  );

  insert into system_notifications (dia, tipo, titulo, detalhe, payload)
  values (
    p_dia, 'coleta_diaria', v_titulo, v_detalhe,
    jsonb_build_object(
      'novos_ranking', v_novos_rank,
      'novos_catalogo', v_novos_cat,
      'posicoes', v_posicoes,
      'produtos_total', v_produtos,
      'alertas', v_alertas
    )
  )
  on conflict (dia, tipo) do update set
    titulo = excluded.titulo,
    detalhe = excluded.detalhe,
    payload = excluded.payload,
    criado_em = now()
  returning id into v_id;

  -- Reabrir como "não lido" se o digest foi regenerado
  delete from system_notification_reads where notification_id = v_id;

  return jsonb_build_object(
    'ok', true,
    'dia', p_dia,
    'posicoes', v_posicoes,
    'produtos_total', v_produtos,
    'novos_ranking', v_novos_rank,
    'novos_catalogo', v_novos_cat,
    'alertas', v_alertas,
    'notification_id', v_id,
    'titulo', v_titulo,
    'detalhe', v_detalhe
  );
end;
$$;

-- Só o coletor (service role / postgres) chama. Autenticado só lê.
revoke all on function registrar_digest_coleta(date) from public, anon, authenticated;

create or replace function digest_hoje()
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  select coalesce(
    (select jsonb_build_object(
       'dia', dia,
       'posicoes', posicoes,
       'produtos_total', produtos_total,
       'novos_ranking', novos_ranking,
       'novos_catalogo', novos_catalogo,
       'alertas', alertas,
       'atualizado_em', atualizado_em
     ) from collection_digests
      where dia = (now() at time zone 'America/Sao_Paulo')::date),
    (select jsonb_build_object(
       'dia', dia,
       'posicoes', posicoes,
       'produtos_total', produtos_total,
       'novos_ranking', novos_ranking,
       'novos_catalogo', novos_catalogo,
       'alertas', alertas,
       'atualizado_em', atualizado_em
     ) from collection_digests
      order by dia desc limit 1),
    '{}'::jsonb
  );
$$;

grant execute on function digest_hoje() to authenticated;

create or replace function listar_avisos_sistema(p_limite int default 20)
returns table (
  id bigint, dia date, tipo text, titulo text, detalhe text,
  payload jsonb, criado_em timestamptz, lido boolean
)
language sql
security definer set search_path = public
as $$
  select n.id, n.dia, n.tipo, n.titulo, n.detalhe, n.payload, n.criado_em,
         exists(
           select 1 from system_notification_reads r
            where r.notification_id = n.id and r.user_id = auth.uid()
         ) as lido
    from system_notifications n
   order by n.criado_em desc
   limit least(coalesce(p_limite, 20), 50);
$$;

grant execute on function listar_avisos_sistema(int) to authenticated;

create or replace function marcar_avisos_lidos()
returns void
language sql
security definer set search_path = public
as $$
  insert into system_notification_reads (user_id, notification_id)
  select auth.uid(), n.id
    from system_notifications n
   where not exists (
     select 1 from system_notification_reads r
      where r.user_id = auth.uid() and r.notification_id = n.id
   )
  on conflict do nothing;
$$;

grant execute on function marcar_avisos_lidos() to authenticated;

notify pgrst, 'reload schema';
