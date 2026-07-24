-- =====================================================================
-- 009_monitor.sql
--
-- O Monitor é o que faz o usuário voltar. Sem ele o produto é uma
-- consulta pontual; com ele vira acompanhamento.
--
-- DECISÃO DE ARQUITETURA: os alertas são GERADOS após cada coleta e
-- gravados, não calculados no momento em que a tela abre.
--
-- Motivo: se o cálculo fosse na leitura, um usuário que passasse uma
-- semana fora só veria o estado de hoje contra ontem — perderia tudo
-- que aconteceu no meio. Gravando, o histórico de mudanças fica
-- registrado e é possível dizer "no dia 12 ele entrou no top 10".
-- =====================================================================

-- ---------------------------------------------------------------------
-- PRODUTOS ACOMPANHADOS
--
-- Aponta para catalog_products, não para items. No caminho de ranking
-- quem tem posição é o produto; os anúncios abaixo dele entram e saem.
-- ---------------------------------------------------------------------
create table if not exists tracked_products (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  product_id   text not null references catalog_products(id) on delete cascade,
  folder_id    uuid references tracked_folders(id) on delete set null,
  nota         text,
  -- estado no momento em que passou a ser acompanhado, para comparar depois
  pos_inicial  int,
  preco_inicial numeric(12,2),
  criado_em    timestamptz not null default now(),
  unique (user_id, product_id)
);
create index if not exists tracked_products_user_idx on tracked_products(user_id);
create index if not exists tracked_products_prod_idx on tracked_products(product_id);

-- Produto acompanhado por qualquer usuário vira prioridade de coleta.
-- Mesmo raciocínio do gatilho de anúncios: entrega precisão onde
-- alguém está olhando, sem coletar o catálogo inteiro todo dia.
create or replace function bump_product_priority()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update items set collect_priority = 2 where catalog_product_id = new.product_id;
  return new;
end $$;

drop trigger if exists on_track_product on tracked_products;
create trigger on_track_product
  after insert on tracked_products
  for each row execute function bump_product_priority();

-- ---------------------------------------------------------------------
-- ALERTAS
--
-- A chave única impede duplicata quando a rotina roda duas vezes no
-- mesmo dia — coisa que acontece toda vez que alguém repete o comando
-- por engano.
-- ---------------------------------------------------------------------
create table if not exists product_alerts (
  id         bigserial primary key,
  user_id    uuid not null references profiles(id) on delete cascade,
  product_id text not null,
  dia        date not null,
  tipo       text not null,
  titulo     text not null,
  detalhe    text,
  antes      numeric,
  depois     numeric,
  lido       boolean not null default false,
  criado_em  timestamptz not null default now(),
  unique (user_id, product_id, tipo, dia)
);
create index if not exists alerts_user_idx on product_alerts(user_id, lido, criado_em desc);

-- ---------------------------------------------------------------------
-- HISTÓRICO DE PREÇO POR PRODUTO
--
-- product_competition guarda só o estado atual. Para detectar "o preço
-- caiu" é preciso a série. Esta view agrega os snapshots de anúncio no
-- nível do produto, por dia.
-- ---------------------------------------------------------------------
create or replace view product_price_daily as
select
  i.catalog_product_id                                            as product_id,
  s.captured_date                                                 as dia,
  round(percentile_cont(0.5) within group (order by s.price)::numeric, 2) as preco_mediano,
  min(s.price)                                                    as preco_min,
  count(distinct i.id)                                            as anuncios,
  count(distinct i.seller_id)                                     as vendedores
from items i
join item_snapshots s on s.item_id = i.id
where i.catalog_product_id is not null and s.price is not null
group by 1, 2;

-- ---------------------------------------------------------------------
-- GERAÇÃO DE ALERTAS
--
-- Compara a leitura mais recente com a anterior, só para os produtos
-- que alguém está acompanhando. Roda depois da coleta diária.
--
-- Os limiares (3 posições, 5% de preço) existem para não gerar ruído.
-- Alerta que dispara todo dia deixa de ser lido no terceiro dia.
-- ---------------------------------------------------------------------
create or replace function gerar_alertas()
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  n int := 0;
begin
  -- ---- movimento de posição ----
  with duas as (
    select
      d.product_id,
      d.captured_date,
      d.position,
      row_number() over (partition by d.product_id order by d.captured_date desc) as r
    from product_rank_daily d
    where d.product_id in (select product_id from tracked_products)
  ),
  cmp as (
    select
      h.product_id,
      h.captured_date as dia,
      o.position as antes,
      h.position as depois
    from duas h
    join duas o on o.product_id = h.product_id and o.r = 2
    where h.r = 1 and o.position is distinct from h.position
  ),
  ins as (
    insert into product_alerts (user_id, product_id, dia, tipo, titulo, detalhe, antes, depois)
    select
      t.user_id, c.product_id, c.dia,
      case
        when c.antes > 10 and c.depois <= 10 then 'entrou_top10'
        when c.antes <= 10 and c.depois > 10 then 'saiu_top10'
        when c.antes - c.depois >= 3         then 'subiu'
        when c.depois - c.antes >= 3         then 'caiu'
      end,
      case
        when c.antes > 10 and c.depois <= 10 then 'Entrou no top 10'
        when c.antes <= 10 and c.depois > 10 then 'Saiu do top 10'
        when c.antes - c.depois >= 3         then 'Subiu ' || (c.antes - c.depois) || ' posições'
        when c.depois - c.antes >= 3         then 'Caiu ' || (c.depois - c.antes) || ' posições'
      end,
      'De ' || c.antes || 'º para ' || c.depois || 'º',
      c.antes, c.depois
    from cmp c
    join tracked_products t on t.product_id = c.product_id
    where c.antes > 10 and c.depois <= 10
       or c.antes <= 10 and c.depois > 10
       or abs(c.antes - c.depois) >= 3
    on conflict (user_id, product_id, tipo, dia) do nothing
    returning 1
  )
  select count(*) into n from ins;

  -- ---- movimento de preço ----
  with duas as (
    select
      p.product_id, p.dia, p.preco_mediano, p.anuncios,
      row_number() over (partition by p.product_id order by p.dia desc) as r
    from product_price_daily p
    where p.product_id in (select product_id from tracked_products)
  ),
  cmp as (
    select h.product_id, h.dia, o.preco_mediano as antes, h.preco_mediano as depois,
           o.anuncios as ant_anuncios, h.anuncios as dep_anuncios
    from duas h join duas o on o.product_id = h.product_id and o.r = 2
    where h.r = 1
  ),
  ins2 as (
    insert into product_alerts (user_id, product_id, dia, tipo, titulo, detalhe, antes, depois)
    select
      t.user_id, c.product_id, c.dia,
      case when c.depois < c.antes then 'preco_caiu' else 'preco_subiu' end,
      case when c.depois < c.antes
           then 'Preço caiu ' || round(abs(c.depois - c.antes) / c.antes * 100) || '%'
           else 'Preço subiu ' || round(abs(c.depois - c.antes) / c.antes * 100) || '%' end,
      'De R$ ' || to_char(c.antes,'FM999G999D00') || ' para R$ ' || to_char(c.depois,'FM999G999D00'),
      c.antes, c.depois
    from cmp c
    join tracked_products t on t.product_id = c.product_id
    where c.antes > 0 and abs(c.depois - c.antes) / c.antes >= 0.05
    on conflict (user_id, product_id, tipo, dia) do nothing
    returning 1
  ),
  ins3 as (
    insert into product_alerts (user_id, product_id, dia, tipo, titulo, detalhe, antes, depois)
    select
      t.user_id, c.product_id, c.dia, 'concorrencia',
      case when c.dep_anuncios > c.ant_anuncios
           then (c.dep_anuncios - c.ant_anuncios) || ' concorrente(s) a mais'
           else (c.ant_anuncios - c.dep_anuncios) || ' concorrente(s) a menos' end,
      'De ' || c.ant_anuncios || ' para ' || c.dep_anuncios || ' anúncios',
      c.ant_anuncios, c.dep_anuncios
    from cmp c
    join tracked_products t on t.product_id = c.product_id
    where c.ant_anuncios is distinct from c.dep_anuncios
      and abs(c.dep_anuncios - c.ant_anuncios) >= 2
    on conflict (user_id, product_id, tipo, dia) do nothing
    returning 1
  )
  select n + (select count(*) from ins2) + (select count(*) from ins3) into n;

  return n;
end;
$$;

revoke all on function gerar_alertas() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- RPCs DO MONITOR
--
-- monitorar_produto respeita o limite do plano: no gratuito são 4.
-- Diferente das buscas, aqui a quota não é consumo mensal e sim teto
-- simultâneo — então checamos a contagem, não o contador.
-- ---------------------------------------------------------------------
create or replace function monitorar_produto(p_produto text, p_nota text default null)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_plano text;
  v_lim   int;
  v_atual int;
  v_pos   int;
  v_preco numeric;
begin
  if v_user is null then raise exception 'nao autenticado' using errcode = '28000'; end if;

  select plan into v_plano from profiles where id = v_user;
  select coalesce((limits ->> 'tracked_items')::int, 0) into v_lim
    from plans where code = coalesce(v_plano, 'free');
  select count(*) into v_atual from tracked_products where user_id = v_user;

  if v_lim >= 0 and v_atual >= v_lim then
    return jsonb_build_object('ok', false, 'motivo', 'limite_do_plano',
                              'limite', v_lim, 'usados', v_atual);
  end if;

  select position into v_pos from product_rank_snapshots
   where product_id = p_produto order by captured_at desc limit 1;
  select median_price into v_preco from product_competition where product_id = p_produto;

  insert into tracked_products (user_id, product_id, nota, pos_inicial, preco_inicial)
  values (v_user, p_produto, p_nota, v_pos, v_preco)
  on conflict (user_id, product_id) do nothing;

  return jsonb_build_object('ok', true, 'usados', v_atual + 1,
                            'limite', v_lim, 'pos_inicial', v_pos);
end;
$$;

create or replace function desmonitorar_produto(p_produto text)
returns void
language sql
security definer set search_path = public
as $$
  delete from tracked_products where user_id = auth.uid() and product_id = p_produto;
$$;

create or replace function listar_monitorados()
returns table (
  product_id text, nome text, categoria text, nota text,
  pos_inicial int, pos_atual int, delta_desde_inicio int,
  preco_inicial numeric, preco_atual numeric, variacao_preco numeric,
  concorrentes int, dias_no_top10 int, dias_observados int,
  alertas_novos bigint, criado_em timestamptz
)
language sql
security definer set search_path = public
as $$
  select
    t.product_id,
    p.name,
    c.name,
    t.nota,
    t.pos_inicial,
    m.position_now,
    case when t.pos_inicial is not null and m.position_now is not null
         then t.pos_inicial - m.position_now end,
    t.preco_inicial,
    k.median_price,
    case when t.preco_inicial > 0 and k.median_price is not null
         then round((k.median_price - t.preco_inicial) / t.preco_inicial, 4) end,
    k.listings,
    m.days_in_top10,
    m.days_observed,
    (select count(*) from product_alerts a
      where a.user_id = t.user_id and a.product_id = t.product_id and not a.lido),
    t.criado_em
  from tracked_products t
  left join catalog_products p      on p.id = t.product_id
  left join categories c            on c.id = p.category_id
  left join product_rank_metrics m  on m.product_id = t.product_id
  left join product_competition k   on k.product_id = t.product_id
  where t.user_id = auth.uid()
  order by t.criado_em desc
$$;

create or replace function listar_alertas(p_limite int default 50)
returns table (
  id bigint, product_id text, nome text, dia date, tipo text,
  titulo text, detalhe text, lido boolean, criado_em timestamptz
)
language sql
security definer set search_path = public
as $$
  select a.id, a.product_id, p.name, a.dia, a.tipo,
         a.titulo, a.detalhe, a.lido, a.criado_em
    from product_alerts a
    left join catalog_products p on p.id = a.product_id
   where a.user_id = auth.uid()
   order by a.criado_em desc
   limit least(p_limite, 200)
$$;

create or replace function marcar_alertas_lidos()
returns void
language sql
security definer set search_path = public
as $$
  update product_alerts set lido = true where user_id = auth.uid() and not lido;
$$;

-- ---------------------------------------------------------------------
-- Segurança
-- ---------------------------------------------------------------------
alter table tracked_products enable row level security;
alter table product_alerts   enable row level security;

drop policy if exists own_rows on tracked_products;
create policy own_rows on tracked_products for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists own_rows on product_alerts;
create policy own_rows on product_alerts for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on tracked_products from anon;
revoke all on product_alerts   from anon;
grant select, insert, update, delete on tracked_products to authenticated;
grant select, update on product_alerts to authenticated;

grant execute on function monitorar_produto(text, text) to authenticated;
grant execute on function desmonitorar_produto(text)    to authenticated;
grant execute on function listar_monitorados()          to authenticated;
grant execute on function listar_alertas(int)           to authenticated;
grant execute on function marcar_alertas_lidos()        to authenticated;
