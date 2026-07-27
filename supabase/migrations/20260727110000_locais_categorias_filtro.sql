-- Sidebar de categorias (raiz + contagem real de produtos locais) e
-- filtro multi-categoria + data de publicacao pra bater com o layout
-- pedido. Contagem usa root_id (ja existe em categories) pra agrupar
-- folha -> raiz sem recursao.
create or replace function categorias_locais_contagem()
returns table (id text, nome text, total bigint)
language sql
security definer set search_path = public
as $$
  select r.id, r.name,
         count(sp.id)
    from categories r
    left join categories cc on cc.root_id = r.id
    left join supplier_products sp on sp.category_id = cc.id and sp.ativo
   where r.level = 0
   group by r.id, r.name
   order by r.name
$$;

grant execute on function categorias_locais_contagem() to authenticated;

-- listar_produtos_locais ganha p_categorias (array, multi-select) e
-- filtro por data de criacao. Os 7 primeiros params sao iguais aos da
-- assinatura antiga -- chamar so com esses seria ambiguo entre as duas
-- (mesmo problema ja documentado com create or replace + assinatura
-- diferente). Precisa dropar a antiga primeiro.
drop function if exists listar_produtos_locais(text,text,text,numeric,numeric,boolean,int);

create or replace function listar_produtos_locais(
  p_texto        text    default null,
  p_categoria    text    default null,
  p_estado       text    default null,
  p_custo_max    numeric default null,
  p_margem_min   numeric default null,
  p_so_vinculados boolean default false,
  p_limite       int     default 50,
  p_categorias   text[]  default null,
  p_custo_min    numeric default null,
  p_criado_desde date    default null,
  p_caixa_min    int     default null,
  p_caixa_max    int     default null,
  p_offset       int     default 0
)
returns setof produtos_locais_view
language sql
security definer set search_path = public
as $$
  select * from produtos_locais_view v
   where (p_texto       is null or v.nome ilike '%' || p_texto || '%')
     and (p_categoria   is null or v.category_id = p_categoria)
     and (p_categorias  is null or v.category_id = any(
           select cc.id from categories cc where cc.root_id = any(p_categorias) or cc.id = any(p_categorias)))
     and (p_estado      is null or v.estado = p_estado)
     and (p_custo_max   is null or v.custo <= p_custo_max)
     and (p_custo_min   is null or v.custo >= p_custo_min)
     and (p_margem_min  is null or v.margem_bruta >= p_margem_min)
     and (p_criado_desde is null or v.criado_em::date >= p_criado_desde)
     and (p_caixa_min   is null or v.unidades_por_caixa >= p_caixa_min)
     and (p_caixa_max   is null or v.unidades_por_caixa <= p_caixa_max)
     and (not p_so_vinculados or v.catalog_product_id is not null)
   order by v.margem_bruta desc nulls last, v.custo asc
   limit least(p_limite, 200) offset p_offset
$$;

grant execute on function listar_produtos_locais(
  text,text,text,numeric,numeric,boolean,int,text[],numeric,date,int,int,int) to authenticated;
