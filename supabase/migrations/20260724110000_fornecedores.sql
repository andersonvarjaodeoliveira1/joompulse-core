-- =====================================================================
-- 011_fornecedores.sql — produtos locais e diretório de fornecedores
--
-- DE ONDE VEM ESTE DADO
--
-- Não vem da API do Mercado Livre. Não existe endpoint que devolva
-- custo de fornecedor ou contato de importadora. O JoomPulse monta esse
-- diretório por fora — e diz isso no rodapé do próprio card: "os
-- detalhes de contato são obtidos a partir dos catálogos dos
-- fornecedores. O JoomPulse não os verifica."
--
-- Aqui as origens possíveis estão declaradas em suppliers.origem:
--   cadastro_proprio  — você cadastrou um fornecedor que conhece
--   parceria          — o fornecedor se inscreveu para receber lead
--   planilha          — importado de catálogo em CSV
--
-- Isso importa porque muda a responsabilidade. Fornecedor com
-- origem='parceria' e verificado=true é um que você checou. Os outros
-- levam o mesmo aviso que o JoomPulse dá.
-- =====================================================================

create table if not exists suppliers (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  cnpj          text,
  -- contatos: só saem por RPC, depois de desbloqueio
  telefone      text,
  email         text,
  site          text,
  instagram     text,
  whatsapp      text,
  -- públicos
  cidade        text,
  estado        text,
  tipo          text,                       -- importador | distribuidor | fabricante
  descricao     text,
  verificado    boolean not null default false,
  origem        text not null default 'cadastro_proprio',
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now()
);
create index if not exists suppliers_uf_idx on suppliers(estado) where ativo;

create table if not exists supplier_products (
  id                 uuid primary key default gen_random_uuid(),
  supplier_id        uuid not null references suppliers(id) on delete cascade,
  nome               text not null,
  descricao          text,
  imagem             text,
  sku                text,
  -- comercial
  custo              numeric(12,2) not null,
  moeda              text not null default 'BRL',
  moq                int,                   -- pedido mínimo
  unidades_por_caixa int default 1,
  preco_desde        date default current_date,
  -- vínculo com o catálogo do ML: é o que permite calcular margem
  catalog_product_id text references catalog_products(id) on delete set null,
  category_id        text references categories(id),
  ativo              boolean not null default true,
  criado_em          timestamptz not null default now(),
  unique (supplier_id, sku)
);
create index if not exists sp_cat_idx  on supplier_products(catalog_product_id);
create index if not exists sp_nome_trgm on supplier_products using gin(nome gin_trgm_ops);

-- ---------------------------------------------------------------------
-- DESBLOQUEIOS
--
-- Mesmo padrão do print do JoomPulse: "Desbloqueios restantes neste
-- mês: 4". Consome quota UMA VEZ por fornecedor — depois de liberado,
-- abrir de novo é grátis. Cobrar de novo pelo mesmo contato seria
-- pegadinha, não modelo de negócio.
-- ---------------------------------------------------------------------
create table if not exists supplier_unlocks (
  user_id     uuid not null references profiles(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  liberado_em timestamptz not null default now(),
  primary key (user_id, supplier_id)
);

-- Acrescenta a cota de desbloqueio aos planos existentes.
update plans set limits = limits || jsonb_build_object('supplier_unlock',
  case code when 'free' then 4 when 'starter' then 25
            when 'pro' then 100 else -1 end);

-- ---------------------------------------------------------------------
-- VISÃO DE PRODUTO LOCAL
--
-- O número que interessa: quanto custa no fornecedor contra quanto está
-- sendo vendido no Mercado Livre.
--
-- margem_bruta é BRUTA de propósito — não desconta comissão, frete nem
-- imposto. Serve para triagem rápida; a conta real é a Calculadora.
-- Chamar isso de "margem" sem o adjetivo seria enganoso.
-- ---------------------------------------------------------------------
create or replace view produtos_locais_view as
select
  sp.id                       as produto_id,
  sp.nome,
  sp.imagem,
  sp.descricao,
  sp.custo,
  sp.moeda,
  sp.moq,
  sp.unidades_por_caixa,
  sp.preco_desde,
  sp.catalog_product_id,
  cp.name                     as nome_no_ml,
  k.median_price              as preco_medio_ml,
  k.listings                  as concorrentes_ml,
  m.position_now              as posicao_ml,
  case when k.median_price > 0 and sp.custo > 0
       then round((k.median_price - sp.custo) / k.median_price, 4) end as margem_bruta,
  case when sp.custo > 0 and k.median_price is not null
       then round(k.median_price - sp.custo, 2) end                    as lucro_bruto,
  s.id                        as fornecedor_id,
  s.nome                      as fornecedor,
  s.cidade,
  s.estado,
  s.tipo,
  s.verificado,
  s.origem,
  sp.category_id,
  c.name                      as categoria
from supplier_products sp
join suppliers s        on s.id = sp.supplier_id and s.ativo
left join catalog_products cp    on cp.id = sp.catalog_product_id
left join product_competition k  on k.product_id = sp.catalog_product_id
left join product_rank_metrics m on m.product_id = sp.catalog_product_id
left join categories c           on c.id = sp.category_id
where sp.ativo;

-- ---------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------
create or replace function listar_produtos_locais(
  p_texto        text    default null,
  p_categoria    text    default null,
  p_estado       text    default null,
  p_custo_max    numeric default null,
  p_margem_min   numeric default null,
  p_so_vinculados boolean default false,
  p_limite       int     default 50
)
returns setof produtos_locais_view
language sql
security definer set search_path = public
as $$
  select * from produtos_locais_view v
   where (p_texto      is null or v.nome ilike '%' || p_texto || '%')
     and (p_categoria  is null or v.category_id = p_categoria)
     and (p_estado     is null or v.estado = p_estado)
     and (p_custo_max  is null or v.custo <= p_custo_max)
     and (p_margem_min is null or v.margem_bruta >= p_margem_min)
     and (not p_so_vinculados or v.catalog_product_id is not null)
   order by v.margem_bruta desc nulls last, v.custo asc
   limit least(p_limite, 200)
$$;

/**
 * Libera os contatos de um fornecedor.
 *
 * Consome quota só na PRIMEIRA vez. Se já estava liberado, devolve os
 * contatos sem cobrar de novo.
 */
create or replace function desbloquear_fornecedor(p_fornecedor uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_ja   boolean;
  q      jsonb;
  f      record;
begin
  if v_user is null then raise exception 'nao autenticado' using errcode = '28000'; end if;

  select exists(select 1 from supplier_unlocks
                 where user_id = v_user and supplier_id = p_fornecedor) into v_ja;

  if not v_ja then
    q := consume_quota('supplier_unlock');
    if not (q ->> 'allowed')::boolean then
      return jsonb_build_object('ok', false, 'motivo', q ->> 'reason',
                                'restantes', q -> 'remaining');
    end if;
    insert into supplier_unlocks (user_id, supplier_id)
    values (v_user, p_fornecedor) on conflict do nothing;
  end if;

  select nome, telefone, email, site, instagram, whatsapp,
         cidade, estado, tipo, verificado, origem
    into f from suppliers where id = p_fornecedor and ativo;

  if f is null then
    return jsonb_build_object('ok', false, 'motivo', 'fornecedor_inexistente');
  end if;

  return jsonb_build_object(
    'ok', true, 'ja_estava', v_ja,
    'nome', f.nome, 'telefone', f.telefone, 'email', f.email,
    'site', f.site, 'instagram', f.instagram, 'whatsapp', f.whatsapp,
    'cidade', f.cidade, 'estado', f.estado, 'tipo', f.tipo,
    'verificado', f.verificado, 'origem', f.origem
  );
end;
$$;

/** Quais fornecedores este usuário já liberou. Não consome nada. */
create or replace function meus_desbloqueios()
returns table (fornecedor_id uuid, nome text, liberado_em timestamptz)
language sql
security definer set search_path = public
as $$
  select u.supplier_id, s.nome, u.liberado_em
    from supplier_unlocks u join suppliers s on s.id = u.supplier_id
   where u.user_id = auth.uid()
   order by u.liberado_em desc
$$;

-- ---------------------------------------------------------------------
-- Segurança: a tabela suppliers guarda telefone e e-mail. Ninguém lê
-- direto — só pela RPC, que checa o desbloqueio.
-- ---------------------------------------------------------------------
alter table suppliers         enable row level security;
alter table supplier_products enable row level security;
alter table supplier_unlocks  enable row level security;

drop policy if exists own_rows on supplier_unlocks;
create policy own_rows on supplier_unlocks for select using (user_id = auth.uid());

revoke all on suppliers         from anon, authenticated;
revoke all on supplier_products from anon, authenticated;
revoke all on supplier_unlocks  from anon;
grant select on supplier_unlocks to authenticated;

grant execute on function listar_produtos_locais(text,text,text,numeric,numeric,boolean,int) to authenticated;
grant execute on function desbloquear_fornecedor(uuid) to authenticated;
grant execute on function meus_desbloqueios()          to authenticated;

comment on table suppliers is
  'Diretório de fornecedores. NÃO vem da API do ML — ver cabeçalho da migration 011.';
