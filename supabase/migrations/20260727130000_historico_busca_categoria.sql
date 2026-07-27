-- Guarda toda busca de categoria feita na aba Categorias -- historico
-- real por usuario. Mesmo padrao de tracked_sellers: grant direto
-- (select/insert), RLS own_rows.
create table if not exists category_search_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  category_id text references categories(id),
  texto       text,
  criado_em   timestamptz not null default now()
);
create index if not exists csl_user_idx on category_search_log(user_id, criado_em desc);

alter table category_search_log enable row level security;
drop policy if exists own_rows on category_search_log;
create policy own_rows on category_search_log for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert on category_search_log to authenticated;

-- Ultimas categorias pesquisadas, com o dado real de hoje (nao o de
-- quando foi pesquisado -- category_rank_metrics muda todo dia).
create or replace function categorias_recentes(p_limite int default 8)
returns table (category_id text, nome text, ultima_busca timestamptz,
               oportunidade text, rotatividade_7d numeric, preco_mediano numeric)
language sql
security definer set search_path = public
as $$
  select l.category_id, coalesce(cm.categoria, c.name), max(l.criado_em),
         cm.oportunidade, cm.rotatividade_7d, cm.preco_mediano
    from category_search_log l
    join categories c on c.id = l.category_id
    left join category_opportunity_rank cm on cm.category_id = l.category_id
   where l.user_id = auth.uid() and l.category_id is not null
   group by l.category_id, c.name, cm.categoria, cm.oportunidade, cm.rotatividade_7d, cm.preco_mediano
   order by max(l.criado_em) desc
   limit least(p_limite, 20)
$$;

grant execute on function categorias_recentes(int) to authenticated;
