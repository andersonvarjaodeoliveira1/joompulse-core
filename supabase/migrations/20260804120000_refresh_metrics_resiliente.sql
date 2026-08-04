-- =====================================================================
-- Refresh de métricas resiliente + timeout maior
--
-- Em 03–04/08/2026 a coleta diária gravou o ranking, mas
-- refresh_rank_metrics() morreu em statement_timeout (~2 min) no
-- category_rank_metrics. Com isso o passo "Métricas e alertas" falhava,
-- digest/verificar eram pulados e gerar_alertas() NUNCA rodava no
-- workflow (só existia dentro de `rodada`, que o Actions não chama).
--
-- Aqui: timeout local de 10 min; category em bloco separado com
-- WARNING se falhar — product_rank_metrics e product_competition
-- continuam atualizando (é o que o Monitor usa).
-- =====================================================================

create or replace function refresh_rank_metrics(concurrent boolean default true)
returns void
language plpgsql
as $$
begin
  -- Só nesta chamada (true = local). Sem isso o pooler corta em ~120s.
  perform set_config('statement_timeout', '600000', true);

  if concurrent then
    refresh materialized view concurrently product_rank_metrics;
    refresh materialized view concurrently product_competition;
    begin
      refresh materialized view concurrently category_rank_metrics;
    exception when others then
      raise warning 'category_rank_metrics (concurrent) falhou: %', sqlerrm;
    end;
  else
    refresh materialized view product_rank_metrics;
    refresh materialized view product_competition;
    begin
      refresh materialized view category_rank_metrics;
    exception when others then
      raise warning 'category_rank_metrics falhou: %', sqlerrm;
    end;
  end if;
end;
$$;

revoke all on function refresh_rank_metrics(boolean) from public, anon, authenticated;

notify pgrst, 'reload schema';
