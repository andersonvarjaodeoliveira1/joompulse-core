-- =====================================================================
-- Assinatura ativa (extensão + futuro gateway)
--
-- A coluna profiles.subscription_status já existia e não era usada.
-- Agora status_assinatura() é a fonte única: login da extensão e
-- resolver_anuncio consultam isso.
--
-- Ativa quando:
--   • subscription_status IN ('active','trialing'), ou
--   • trial_ends_at ainda no futuro, ou
--   • plan pago (starter/pro/business) — até o gateway existir,
--     plano pago atribuído na mão também libera.
--
-- Gateway futuro: webhook deve setar subscription_status + plan.
-- =====================================================================

create or replace function status_assinatura()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  p      record;
  v_ativa boolean;
  v_motivo text;
begin
  if v_user is null then
    return jsonb_build_object('ativa', false, 'motivo', 'nao_autenticado');
  end if;

  select plan, subscription_status, trial_ends_at, email
    into p
    from profiles
   where id = v_user;

  if not found then
    return jsonb_build_object('ativa', false, 'motivo', 'sem_perfil');
  end if;

  if coalesce(p.subscription_status, 'none') in ('active', 'trialing') then
    v_ativa := true;
    v_motivo := p.subscription_status;
  elsif p.trial_ends_at is not null and p.trial_ends_at > now() then
    v_ativa := true;
    v_motivo := 'trial';
  elsif coalesce(p.plan, 'free') <> 'free' then
    v_ativa := true;
    v_motivo := 'plano_pago';
  else
    v_ativa := false;
    v_motivo := case coalesce(p.subscription_status, 'none')
      when 'past_due' then 'pagamento_pendente'
      when 'canceled' then 'cancelada'
      else
        case
          when p.trial_ends_at is not null and p.trial_ends_at <= now()
            then 'trial_expirado'
          else 'sem_assinatura'
        end
    end;
  end if;

  return jsonb_build_object(
    'ativa', v_ativa,
    'motivo', v_motivo,
    'plan', coalesce(p.plan, 'free'),
    'subscription_status', coalesce(p.subscription_status, 'none'),
    'trial_ends_at', p.trial_ends_at,
    'email', p.email
  );
end;
$$;

grant execute on function status_assinatura() to authenticated;

-- Trava a extensão: sem assinatura ativa não resolve anúncio.
create or replace function resolver_anuncio(p_mlb text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  q       jsonb;
  v_ass   jsonb;
  v_prod  text;
  v_item  record;
  v_p     record;
  v_seg   boolean;
begin
  if v_user is null then raise exception 'nao autenticado' using errcode = '28000'; end if;

  v_ass := status_assinatura();
  if not coalesce((v_ass ->> 'ativa')::boolean, false) then
    return jsonb_build_object(
      'status', 'sem_assinatura',
      'motivo', v_ass ->> 'motivo',
      'plan',   v_ass ->> 'plan'
    );
  end if;

  q := consume_quota('extension_view');
  if not (q ->> 'allowed')::boolean then
    return jsonb_build_object('status','sem_quota','restantes',0,
                              'motivo', q ->> 'reason');
  end if;

  select i.id, i.catalog_product_id, i.seller_id, i.category_id,
         s.nickname as vendedor
    into v_item
    from items i left join sellers s on s.id = i.seller_id
   where i.id = p_mlb;

  if v_item.id is null then
    if exists (select 1 from catalog_products where id = p_mlb) then
      v_prod := p_mlb;
    else
      return jsonb_build_object('status','desconhecido','mlb',p_mlb,
                                'restantes', q -> 'remaining');
    end if;
  else
    v_prod := v_item.catalog_product_id;
  end if;
  if v_prod is null then
    return jsonb_build_object('status','sem_ranking','mlb',p_mlb,
                              'vendedor', v_item.vendedor,
                              'restantes', q -> 'remaining');
  end if;

  select * into v_p from product_search_view where product_id = v_prod;
  if v_p.product_id is null then
    return jsonb_build_object('status','sem_ranking','mlb',p_mlb,
                              'produto', v_prod, 'restantes', q -> 'remaining');
  end if;

  select exists(select 1 from tracked_products
                 where user_id = v_user and product_id = v_prod) into v_seg;

  return jsonb_build_object(
    'status','encontrado',
    'mlb', p_mlb,
    'produto', v_prod,
    'nome', v_p.name,
    'categoria', v_p.category_name,
    'posicao', v_p.position_now,
    'melhor_posicao', v_p.best_position,
    'delta_7d', v_p.delta_7d,
    'momentum', v_p.momentum,
    'consistencia', v_p.consistencia,
    'dias_top10', v_p.days_in_top10,
    'dias_observados', v_p.days_observed,
    'concorrentes', v_p.listings,
    'vendedores', v_p.sellers,
    'preco_min', v_p.min_price,
    'preco_mediano', v_p.median_price,
    'preco_max', v_p.max_price,
    'full_share', v_p.full_share,
    'monitorado', v_seg,
    'restantes', q -> 'remaining'
  );
end;
$$;

-- Dono do projeto: libera uso da extensão até o gateway de pagamento.
update profiles
   set subscription_status = 'active',
       plan = case when coalesce(plan,'free') = 'free' then 'pro' else plan end
 where lower(email) = 'andersonvarjaodeoliveira1@gmail.com';

notify pgrst, 'reload schema';
