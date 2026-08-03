-- =====================================================================
-- Checkout Mercado Pago (esqueleto)
-- Preferências/cobranças ficam registradas; o webhook ativa o plano.
-- Sem MP_ACCESS_TOKEN a Edge Function devolve gateway_nao_configurado.
-- =====================================================================

alter table profiles
  add column if not exists mp_customer_id text,
  add column if not exists mp_preapproval_id text;

create table if not exists payment_checkouts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  plan_code       text not null references plans(code),
  periodo         text not null check (periodo in ('mes','ano')),
  amount_brl      numeric(12,2) not null,
  mp_preference_id text,
  mp_payment_id   text,
  status          text not null default 'pending'
                  check (status in ('pending','approved','rejected','cancelled','refunded')),
  init_point      text,
  payload         jsonb not null default '{}'::jsonb,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);

create index if not exists payment_checkouts_user_idx
  on payment_checkouts (user_id, criado_em desc);
create index if not exists payment_checkouts_pref_idx
  on payment_checkouts (mp_preference_id)
  where mp_preference_id is not null;
create index if not exists payment_checkouts_pay_idx
  on payment_checkouts (mp_payment_id)
  where mp_payment_id is not null;

alter table payment_checkouts enable row level security;

drop policy if exists payment_checkouts_own on payment_checkouts;
create policy payment_checkouts_own on payment_checkouts
  for select to authenticated
  using (user_id = auth.uid());

grant select on payment_checkouts to authenticated;

-- Ativa plano após pagamento aprovado (chamado pelo webhook com service role).
create or replace function ativar_assinatura_pagamento(
  p_user_id uuid,
  p_plan text,
  p_periodo text,
  p_payment_id text default null,
  p_preference_id text default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_status text;
begin
  if p_user_id is null or p_plan is null then
    return jsonb_build_object('ok', false, 'erro', 'parametros');
  end if;
  if not exists (select 1 from plans where code = p_plan) then
    return jsonb_build_object('ok', false, 'erro', 'plano_invalido');
  end if;

  update profiles set
    plan = p_plan,
    subscription_status = 'active'
  where id = p_user_id;

  if p_preference_id is not null then
    update payment_checkouts set
      status = 'approved',
      mp_payment_id = coalesce(p_payment_id, mp_payment_id),
      atualizado_em = now()
    where mp_preference_id = p_preference_id
       or (p_payment_id is not null and mp_payment_id = p_payment_id);
  elsif p_payment_id is not null then
    update payment_checkouts set
      status = 'approved',
      mp_payment_id = p_payment_id,
      atualizado_em = now()
    where mp_payment_id = p_payment_id
       or id::text = (
         select id::text from payment_checkouts
          where user_id = p_user_id and status = 'pending'
          order by criado_em desc limit 1
       );
  end if;

  select subscription_status into v_status from profiles where id = p_user_id;
  return jsonb_build_object(
    'ok', true,
    'plan', p_plan,
    'periodo', p_periodo,
    'subscription_status', v_status
  );
end;
$$;

-- Só service role / edge function (não authenticated)
revoke all on function ativar_assinatura_pagamento(uuid, text, text, text, text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
