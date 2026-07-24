-- =====================================================================
-- 016_saude_categoria.sql — parar de bater em porta fechada
--
-- Das 6.733 categorias folha, cerca de 3.891 têm destaques. As outras
-- 2.842 devolvem lista vazia todo dia — e cada uma custa uma chamada à
-- API e cerca de meio segundo.
--
-- Em uma rodada diária isso é 40% do tempo gasto em nada. Marcando as
-- que falham repetidamente, a coleta cai de ~2h para ~1h, o que muda
-- quais opções de hospedagem cabem no plano gratuito.
--
-- Importante: não desistimos de vez. Categoria sem destaque hoje pode
-- ganhar amanhã, quando o Mercado Livre mudar o critério ou o nicho
-- ganhar volume. Por isso a releitura é semanal em vez de nunca.
-- =====================================================================

alter table categories
  add column if not exists rank_falhas       int  not null default 0,
  add column if not exists rank_ultima_falha date,
  add column if not exists rank_ultimo_ok    date;

comment on column categories.rank_falhas is
  'Leituras seguidas de destaque vazio. A partir de 3, a categoria passa para releitura semanal.';

create index if not exists categories_saude_idx
  on categories(is_leaf, rank_falhas) where is_leaf;

/**
 * Registra o resultado de uma tentativa de leitura de ranking.
 *
 * Sucesso zera o contador — uma categoria que voltou a ter destaque
 * volta imediatamente ao ritmo diário.
 */
create or replace function registrar_ranking(p_categoria text, p_teve boolean)
returns void
language sql
as $$
  update categories set
    rank_falhas       = case when p_teve then 0 else rank_falhas + 1 end,
    rank_ultimo_ok    = case when p_teve then current_date else rank_ultimo_ok end,
    rank_ultima_falha = case when p_teve then rank_ultima_falha else current_date end
  where id = p_categoria
$$;

/** Panorama da cobertura, para saber onde a coleta está gastando à toa. */
create or replace view saude_cobertura as
select
  count(*) filter (where is_leaf)                                   as folhas,
  count(*) filter (where is_leaf and rank_ultimo_ok is not null)    as com_ranking,
  count(*) filter (where is_leaf and rank_falhas between 1 and 2)   as instaveis,
  count(*) filter (where is_leaf and rank_falhas >= 3)              as adormecidas,
  count(*) filter (where is_leaf and rank_falhas = 0
                     and rank_ultimo_ok is null)                    as nunca_tentadas
from categories;

grant select on saude_cobertura to authenticated;
revoke all on function registrar_ranking(text, boolean) from public, anon, authenticated;
