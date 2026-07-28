-- Teaser gratuito pra Home: 1 categoria (a de maior score hoje), sem
-- expor a lista inteira -- mesmo espirito de contar_produtos, que ja
-- e de graca. Nao consome quota.
create or replace function categoria_destaque()
returns table (category_id text, categoria text, oportunidade text, rotatividade_7d numeric)
language sql
security definer set search_path = public
as $$
  select category_id, categoria, oportunidade, rotatividade_7d
    from category_opportunity_rank
   where score is not null
   order by score desc
   limit 1
$$;

grant execute on function categoria_destaque() to authenticated;
