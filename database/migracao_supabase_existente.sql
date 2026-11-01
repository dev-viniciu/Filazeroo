-- SENAI Fila Zero — migração para o banco EXISTENTE informado pelo usuário.
-- Faça backup antes de executar. Este script não apaga o histórico de retiradas.
-- Estrutura esperada: alunos(id uuid,nome,email), funcionarios(id uuid,nome,email,usuario,perfil),
-- cardapio(id bigint,nome,descricao,imagem,disponivel), estoque(id,cardapio_id,quantidade),
-- retiradas(id,aluno_id,cardapio_id,quantidade,retirado_em).

begin;

-- Campos de controle diário já iniciados no banco; IF NOT EXISTS torna a migração repetível.
alter table public.estoque add column if not exists quantidade_inicial integer;
alter table public.estoque add column if not exists retiradas_no_dia integer not null default 0;
alter table public.estoque add column if not exists data_referencia date not null default (timezone('America/Sao_Paulo', now())::date);
update public.estoque set quantidade_inicial = quantidade where quantidade_inicial is null;
alter table public.estoque alter column quantidade_inicial set default 0;
alter table public.estoque alter column quantidade_inicial set not null;

-- Metadados adicionais para auditoria, sem alterar os IDs nem apagar retiradas antigas.
alter table public.retiradas add column if not exists tipo text not null default 'primeira';
alter table public.retiradas add column if not exists funcionario_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'retiradas_tipo_check') then
    alter table public.retiradas add constraint retiradas_tipo_check check (tipo in ('primeira','repeticao'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'retiradas_funcionario_id_fkey') then
    alter table public.retiradas add constraint retiradas_funcionario_id_fkey
      foreign key (funcionario_id) references public.funcionarios(id) on delete set null;
  end if;
end $$;

create table if not exists public.configuracoes_fila_zero (
  singleton boolean primary key default true check (singleton),
  repeticao_liberada boolean not null default false,
  inicio_ciclo timestamptz not null default now(),
  data_referencia date not null default (timezone('America/Sao_Paulo', now())::date),
  atualizado_em timestamptz not null default now()
);
insert into public.configuracoes_fila_zero(singleton) values (true) on conflict (singleton) do nothing;

alter table public.configuracoes_fila_zero enable row level security;
revoke all on public.configuracoes_fila_zero from anon, authenticated;

-- Funcionários podem consultar a lista de alunos no painel; aluno comum só vê seu próprio registro.
drop policy if exists "funcionario consulta todos alunos" on public.alunos;
create policy "funcionario consulta todos alunos" on public.alunos
for select to authenticated using (public.eh_funcionario());

-- Histórico somente leitura para funcionários. Escrita ocorre exclusivamente pela RPC transacional.
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='retiradas' loop
    execute format('drop policy %I on public.retiradas', p.policyname);
  end loop;
end $$;
create policy "funcionario consulta retiradas" on public.retiradas
for select to authenticated using (public.eh_funcionario());

create or replace function public.garantir_dia_atual()
returns void language plpgsql security definer set search_path = public, auth
as $$
declare v_hoje date:=timezone('America/Sao_Paulo',now())::date; v_data date;
begin
  if auth.uid() is null then raise exception 'Autenticação necessária.'; end if;
  select data_referencia into v_data from public.configuracoes_fila_zero where singleton=true for update;
  if v_data is distinct from v_hoje then
    update public.estoque set quantidade=quantidade_inicial,retiradas_no_dia=0,data_referencia=v_hoje,atualizado_em=now();
    update public.configuracoes_fila_zero set repeticao_liberada=false,inicio_ciclo=now(),data_referencia=v_hoje,atualizado_em=now() where singleton=true;
  end if;
end;
$$;

create or replace function public.status_repeticao()
returns jsonb language plpgsql stable security definer set search_path = public, auth
as $$
declare v_liberada boolean; v_total bigint; v_receberam bigint; v_inicio timestamptz;
begin
  if not public.eh_funcionario() then raise exception 'Acesso negado: funcionário autorizado necessário.'; end if;
  select repeticao_liberada, inicio_ciclo into v_liberada, v_inicio
  from public.configuracoes_fila_zero where singleton = true;
  select count(*) into v_total from public.alunos;
  select count(distinct r.aluno_id) into v_receberam from public.retiradas r
  where r.retirado_em >= v_inicio and r.tipo = 'primeira';
  return jsonb_build_object('liberada', coalesce(v_liberada,false), 'total_alunos', v_total,
    'alunos_que_receberam', v_receberam, 'todos_receberam', (v_total > 0 and v_receberam >= v_total));
end;
$$;

create or replace function public.liberar_repeticao()
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare v_total bigint; v_receberam bigint; v_inicio timestamptz;
begin
  if not public.eh_funcionario() then raise exception 'Acesso negado: funcionário autorizado necessário.'; end if;
  select inicio_ciclo into v_inicio from public.configuracoes_fila_zero where singleton = true for update;
  select count(*) into v_total from public.alunos;
  select count(distinct r.aluno_id) into v_receberam from public.retiradas r
    where r.retirado_em >= v_inicio and r.tipo = 'primeira';
  if v_total = 0 or v_receberam < v_total then
    raise exception 'A repetição só pode ser liberada depois que todos os alunos receberem o primeiro lanche (% de %).', v_receberam, v_total;
  end if;
  update public.configuracoes_fila_zero set repeticao_liberada=true, atualizado_em=now() where singleton=true;
  return jsonb_build_object('liberada',true,'mensagem','REPETIÇÃO LIBERADA!');
end;
$$;

create or replace function public.registrar_retirada(p_aluno_id uuid, p_cardapio_id bigint)
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare
  v_estoque public.estoque%rowtype; v_repeticao boolean; v_inicio timestamptz;
  v_ja_retirou boolean; v_id bigint; v_funcionario uuid; v_nome text;
begin
  if not public.eh_funcionario() then raise exception 'Acesso negado: funcionário autorizado necessário.'; end if;
  if p_aluno_id is null or not exists(select 1 from public.alunos where id=p_aluno_id) then
    raise exception 'Aluno não encontrado.';
  end if;
  select repeticao_liberada, inicio_ciclo into v_repeticao, v_inicio
    from public.configuracoes_fila_zero where singleton=true for update;
  perform pg_advisory_xact_lock(hashtext(p_aluno_id::text)::bigint);
  select exists(select 1 from public.retiradas r where r.aluno_id=p_aluno_id and r.retirado_em>=v_inicio)
    into v_ja_retirou;
  if v_ja_retirou and not v_repeticao then
    raise exception 'Este aluno já recebeu o primeiro lanche. A repetição ainda não foi liberada.';
  end if;
  select * into v_estoque from public.estoque where cardapio_id=p_cardapio_id for update;
  if not found or v_estoque.quantidade <= 0 then raise exception 'Sem estoque disponível para este lanche.'; end if;
  select id,nome into v_funcionario,v_nome from public.funcionarios where id=auth.uid();
  update public.estoque set quantidade=quantidade-1, retiradas_no_dia=retiradas_no_dia+1,
    atualizado_em=now(), data_referencia=timezone('America/Sao_Paulo',now())::date
    where id=v_estoque.id;
  insert into public.retiradas(aluno_id,cardapio_id,quantidade,retirado_em,tipo,funcionario_id)
    values(p_aluno_id,p_cardapio_id,1,now(),case when v_ja_retirou then 'repeticao' else 'primeira' end,v_funcionario)
    returning id into v_id;
  return jsonb_build_object('id',v_id,'tipo',case when v_ja_retirou then 'repeticao' else 'primeira' end,
    'quantidade_disponivel',v_estoque.quantidade-1,'funcionario',v_nome);
end;
$$;

create or replace function public.listar_retiradas_hoje()
returns table(id bigint,aluno_id uuid,aluno_nome text,item text,quantidade integer,tipo text,retirado_em timestamptz)
language plpgsql stable security definer set search_path = public, auth
as $$
declare v_inicio timestamptz;
begin
  if auth.uid() is null then raise exception 'Autenticação necessária.'; end if;
  select inicio_ciclo into v_inicio from public.configuracoes_fila_zero where singleton=true;
  return query select r.id,r.aluno_id,a.nome,c.nome,r.quantidade,r.tipo,r.retirado_em
    from public.retiradas r join public.alunos a on a.id=r.aluno_id
    join public.cardapio c on c.id=r.cardapio_id
    where r.retirado_em>=v_inicio
      and (r.retirado_em at time zone 'America/Sao_Paulo')::date=timezone('America/Sao_Paulo',now())::date
      and (public.eh_funcionario() or r.aluno_id=auth.uid())
    order by r.retirado_em desc;
end;
$$;

create or replace function public.atualizar_estoque_item(p_cardapio_id bigint,p_quantidade integer,p_quantidade_inicial integer default null)
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare v public.estoque%rowtype;
begin
  if not public.eh_funcionario() then raise exception 'Acesso negado: funcionário autorizado necessário.'; end if;
  if p_quantidade is null or p_quantidade<0 then raise exception 'Quantidade inválida.'; end if;
  if p_quantidade_inicial is not null and (p_quantidade_inicial<0 or not public.eh_admin()) then
    raise exception 'Somente administradores podem alterar a quantidade inicial.';
  end if;
  select * into v from public.estoque where cardapio_id=p_cardapio_id for update;
  if not found then raise exception 'Item de estoque não encontrado.'; end if;
  update public.estoque set quantidade=p_quantidade,
    quantidade_inicial=coalesce(p_quantidade_inicial,quantidade_inicial),atualizado_em=now()
    where id=v.id returning * into v;
  return jsonb_build_object('cardapio_id',p_cardapio_id,'quantidade',v.quantidade,'quantidade_inicial',v.quantidade_inicial);
end;
$$;

create or replace function public.reiniciar_estoque_dia()
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare v_total integer; v_data date:=timezone('America/Sao_Paulo',now())::date;
begin
  if not public.eh_admin() then raise exception 'Acesso negado: somente administradores podem reiniciar o estoque.'; end if;
  update public.estoque set quantidade=quantidade_inicial,retiradas_no_dia=0,data_referencia=v_data,atualizado_em=now();
  get diagnostics v_total=row_count;
  update public.configuracoes_fila_zero set repeticao_liberada=false,inicio_ciclo=now(),data_referencia=v_data,atualizado_em=now() where singleton=true;
  return jsonb_build_object('data_referencia',v_data,'itens_reiniciados',v_total);
end;
$$;

revoke all on function public.garantir_dia_atual() from public;
revoke all on function public.status_repeticao() from public;
revoke all on function public.liberar_repeticao() from public;
revoke all on function public.registrar_retirada(uuid,bigint) from public;
revoke all on function public.listar_retiradas_hoje() from public;
revoke all on function public.atualizar_estoque_item(bigint,integer,integer) from public;
revoke all on function public.reiniciar_estoque_dia() from public;
grant execute on function public.garantir_dia_atual() to authenticated;
grant execute on function public.status_repeticao() to authenticated;
grant execute on function public.liberar_repeticao() to authenticated;
grant execute on function public.registrar_retirada(uuid,bigint) to authenticated;
grant execute on function public.listar_retiradas_hoje() to authenticated;
grant execute on function public.atualizar_estoque_item(bigint,integer,integer) to authenticated;
grant execute on function public.reiniciar_estoque_dia() to authenticated;

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='estoque') then alter publication supabase_realtime add table public.estoque; end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='retiradas') then alter publication supabase_realtime add table public.retiradas; end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='cardapio') then alter publication supabase_realtime add table public.cardapio; end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='configuracoes_fila_zero') then alter publication supabase_realtime add table public.configuracoes_fila_zero; end if;
  end if;
end $$;

commit;
