-- =====================================================================
-- Rate limit por usuário (Edge Functions + abuso de API)
-- Janela deslizante simples em buckets de N segundos.
-- =====================================================================

create table if not exists api_rate_buckets (
  user_id      uuid not null references profiles(id) on delete cascade,
  bucket       text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (user_id, bucket, window_start)
);

create index if not exists api_rate_buckets_cleanup_idx
  on api_rate_buckets (window_start);

alter table api_rate_buckets enable row level security;
-- Sem policies para authenticated: só service role / security definer.

create or replace function check_rate_limit(
  p_bucket text,
  p_limit int default 30,
  p_window_seconds int default 60
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_win  timestamptz;
  v_hits int;
begin
  if v_user is null then
    return jsonb_build_object('allowed', false, 'erro', 'nao_autenticado');
  end if;
  if p_bucket is null or length(trim(p_bucket)) = 0 then
    return jsonb_build_object('allowed', false, 'erro', 'bucket');
  end if;
  if p_limit < 1 then p_limit := 1; end if;
  if p_window_seconds < 1 then p_window_seconds := 60; end if;

  v_win := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into api_rate_buckets (user_id, bucket, window_start, hits)
  values (v_user, p_bucket, v_win, 1)
  on conflict (user_id, bucket, window_start)
  do update set hits = api_rate_buckets.hits + 1
  returning hits into v_hits;

  -- limpeza leve (janelas velhas)
  delete from api_rate_buckets
   where window_start < now() - make_interval(secs => p_window_seconds * 20);

  if v_hits > p_limit then
    return jsonb_build_object(
      'allowed', false,
      'erro', 'rate_limit',
      'limit', p_limit,
      'hits', v_hits,
      'retry_after_seconds', p_window_seconds
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'limit', p_limit,
    'hits', v_hits,
    'remaining', greatest(p_limit - v_hits, 0)
  );
end;
$$;

revoke all on function check_rate_limit(text, int, int) from public, anon;
grant execute on function check_rate_limit(text, int, int) to authenticated;

notify pgrst, 'reload schema';
