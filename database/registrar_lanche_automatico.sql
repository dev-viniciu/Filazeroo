-- Corrige a validação: o banco anterior não tinha a assinatura sem parâmetros
-- que a função de entrega automática chama. funcionarios.id guarda o UUID do Auth.
create or replace function public.eh_funcionario(p_admin boolean)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select auth.uid() is not null and exists (
    select 1 from public.funcionarios f
    where f.id = auth.uid()
      and (not p_admin or lower(coalesce(f.perfil, '')) = 'admin')
  );
$$;

create or replace function public.eh_funcionario()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.eh_funcionario(false);
$$;

revoke all on function public.eh_funcionario(boolean) from public;
revoke all on function public.eh_funcionario() from public;
grant execute on function public.eh_funcionario(boolean) to authenticated;
grant execute on function public.eh_funcionario() to authenticated;

-- SENAI Fila Zero: entrega automática do lanche destacado no Cardápio do dia.
-- Não apaga tabelas nem histórico. Compatível com alunos.id e retiradas.aluno_id TEXT,
-- estoque.item TEXT e retiradas.item TEXT.
create or replace function public.registrar_lanche_automatico(
  p_aluno_id text,
  p_funcionario text,
  p_item text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_estoque public.estoque%rowtype;
  v_inicio timestamptz;
  v_repeticao_liberada boolean;
  v_ja_retirou boolean;
  v_tipo text;
  v_nome text;
begin
  if not public.eh_funcionario() then
    raise exception 'Acesso permitido somente a funcionários.';
  end if;
  if p_aluno_id is null or not exists (
    select 1 from public.alunos where id = p_aluno_id and ativo = true
  ) then
    raise exception 'Aluno não encontrado ou inativo.';
  end if;
  if p_item is null or btrim(p_item) = '' then
    raise exception 'O lanche do dia não foi informado.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_aluno_id)::bigint);
  select inicio_ciclo, repeticao_liberada
    into v_inicio, v_repeticao_liberada
    from public.configuracoes_fila_zero where singleton = true for update;

  select exists (
    select 1 from public.retiradas r
    where r.aluno_id = p_aluno_id and r.retirado_em >= v_inicio
  ) into v_ja_retirou;

  if v_ja_retirou and not coalesce(v_repeticao_liberada, false) then
    raise exception 'Este aluno já retirou o lanche. A repetição ainda não foi liberada.';
  end if;
  if v_ja_retirou and exists (
    select 1 from public.retiradas r
    where r.aluno_id = p_aluno_id and r.retirado_em >= v_inicio and r.tipo = 'repeticao'
  ) then
    raise exception 'Este aluno já recebeu a repetição.';
  end if;

  select * into v_estoque
    from public.estoque
    where lower(btrim(item)) = lower(btrim(p_item))
    for update;
  if not found or coalesce(v_estoque.quantidade, 0) <= 0 then
    raise exception 'Sem estoque disponível para %.', p_item;
  end if;

  select nome into v_nome from public.funcionarios where id = auth.uid();
  update public.estoque
    set quantidade = quantidade - 1,
        retiradas_no_dia = coalesce(retiradas_no_dia, 0) + 1,
        atualizado_em = now()
    where id = v_estoque.id;

  v_tipo := case when v_ja_retirou then 'repeticao' else 'primeira' end;
  insert into public.retiradas(aluno_id, funcionario, item, quantidade, tipo, retirado_em)
    values (p_aluno_id, coalesce(v_nome, p_funcionario), v_estoque.item, 1, v_tipo, now());

  return jsonb_build_object(
    'sucesso', true, 'aluno_id', p_aluno_id, 'item', v_estoque.item,
    'tipo', v_tipo, 'quantidade_disponivel', v_estoque.quantidade - 1
  );
end;
$$;

revoke all on function public.registrar_lanche_automatico(text, text, text) from public;
grant execute on function public.registrar_lanche_automatico(text, text, text) to authenticated;

NOTIFY pgrst, 'reload schema';
