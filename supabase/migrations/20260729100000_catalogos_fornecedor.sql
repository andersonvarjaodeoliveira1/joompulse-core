-- =====================================================================
-- Catálogos de fornecedores (PDF) enviados pelo app
--
-- O usuário sobe o PDF. Guardamos metadados aqui + o arquivo no Storage
-- (bucket "catalogos"). Uma Edge Function manda o arquivo por e-mail
-- para análise. Conversão automática PDF→tabela de produtos NÃO roda
-- aqui — entra em Produtos locais depois do processamento manual/CSV.
-- =====================================================================

create table if not exists supplier_catalogs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  nome_arquivo    text not null,
  storage_path    text not null,
  tamanho_bytes   bigint,
  mime            text not null default 'application/pdf',
  fornecedor_nome text,
  notas           text,
  status          text not null default 'recebido'
                  check (status in ('recebido','email_enviado','erro_email')),
  email_enviado_em timestamptz,
  email_erro      text,
  criado_em       timestamptz not null default now()
);

create index if not exists supplier_catalogs_user_idx
  on supplier_catalogs(user_id, criado_em desc);

alter table supplier_catalogs enable row level security;

create policy supplier_catalogs_select_own on supplier_catalogs
  for select to authenticated
  using (user_id = auth.uid());

create policy supplier_catalogs_insert_own on supplier_catalogs
  for insert to authenticated
  with check (user_id = auth.uid());

-- Usuário não edita/apaga direto — só a function (service role) marca e-mail.
revoke update, delete on supplier_catalogs from authenticated;
grant select, insert on supplier_catalogs to authenticated;

create or replace function listar_meus_catalogos(p_limite int default 50)
returns table (
  id uuid, nome_arquivo text, tamanho_bytes bigint, fornecedor_nome text,
  status text, email_enviado_em timestamptz, email_erro text, criado_em timestamptz
)
language sql
security definer set search_path = public
as $$
  select id, nome_arquivo, tamanho_bytes, fornecedor_nome,
         status, email_enviado_em, email_erro, criado_em
    from supplier_catalogs
   where user_id = auth.uid()
   order by criado_em desc
   limit least(coalesce(p_limite, 50), 100)
$$;

grant execute on function listar_meus_catalogos(int) to authenticated;

-- Storage: bucket privado de PDFs (até 20 MB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'catalogos', 'catalogos', false, 20971520,
  array['application/pdf']::text[]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Pasta = user_id/...
drop policy if exists catalogos_select_own on storage.objects;
drop policy if exists catalogos_insert_own on storage.objects;

create policy catalogos_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'catalogos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy catalogos_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'catalogos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

notify pgrst, 'reload schema';
