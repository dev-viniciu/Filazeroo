-- SENAI Fila Zero: entrega conjunta de 1 lanche + 1 suco.
-- Executar uma vez no SQL Editor do Supabase. Mantém o histórico existente.
create or replace function public.registrar_entrega_completa(
  p_aluno_id text,
  p_funcionario text,
  p_lanche text,
  p_suco text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_inicio timestamptz;
  v_repeticao_liberada boolean;
  v_ja_recebeu boolean;
  v_tipo text;
  v_qtd_lanche integer;
  v_qtd_suco integer;
  v_total_alunos bigint;
  v_receberam bigint;
  v_nome_funcionario text;
begin
  if not public.eh_funcionario() then
    raise exception 'Acesso negado: funcionário autorizado necessário.';
  end if;
  if p_aluno_id is null or not exists (
    select 1 from public.alunos where id = p_aluno_id and ativo = true
  ) then
    raise exception 'Aluno não encontrado ou inativo.';
  end if;
  if coalesce(trim(p_lanche), '') = '' or coalesce(trim(p_suco), '') = '' then
    raise exception 'Selecione um lanche e um suco.';
  end if;
  if lower(trim(p_lanche)) like 'suco%' or lower(trim(p_suco)) not like 'suco%' then
    raise exception 'Selecione um item da categoria lanche e outro da categoria suco.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_aluno_id)::bigint);
  select inicio_ciclo, repeticao_liberada
    into v_inicio, v_repeticao_liberada
    from public.configuracoes_fila_zero
    where singleton = true for update;

  select exists (
    select 1 from public.retiradas
    where aluno_id = p_aluno_id and retirado_em >= coalesce(v_inicio, now())
      and tipo = 'primeira'
  ) into v_ja_recebeu;

  if not v_ja_recebeu then
    v_tipo := 'primeira';
  else
    if not coalesce(v_repeticao_liberada, false) then
      raise exception 'Este aluno já recebeu o lanche. A repetição ainda não foi liberada.';
    end if;
    v_tipo := 'repeticao';
    if exists (
      select 1 from public.retiradas
      where aluno_id = p_aluno_id and retirado_em >= coalesce(v_inicio, now())
        and tipo = 'repeticao'
    ) then
      raise exception 'Este aluno já recebeu a repetição neste ciclo.';
    end if;
  end if;

  -- Trava os dois itens antes de alterar qualquer quantidade: ou entrega os dois, ou nenhum.
  select quantidade into v_qtd_lanche from public.estoque
    where item = p_lanche for update;
  if not found or v_qtd_lanche <= 0 then
    raise exception 'Sem estoque disponível para o lanche selecionado.';
  end if;
  select quantidade into v_qtd_suco from public.estoque
    where item = p_suco for update;
  if not found or v_qtd_suco <= 0 then
    raise exception 'Sem estoque disponível para o suco selecionado.';
  end if;

  select nome into v_nome_funcionario from public.funcionarios
    where auth_user_id = auth.uid() and ativo = true;

  update public.estoque set quantidade = quantidade - 1,
    retiradas_no_dia = coalesce(retiradas_no_dia, 0) + 1, atualizado_em = now()
    where item in (p_lanche, p_suco);

  insert into public.retiradas (aluno_id, funcionario, item, quantidade, tipo, retirado_em, data_local)
  values
    (p_aluno_id, coalesce(v_nome_funcionario, p_funcionario, 'Funcionário'), p_lanche, 1, v_tipo, now(), timezone('America/Sao_Paulo', now())::date),
    (p_aluno_id, coalesce(v_nome_funcionario, p_funcionario, 'Funcionário'), p_suco, 1, v_tipo, now(), timezone('America/Sao_Paulo', now())::date);

  return jsonb_build_object('aluno_id', p_aluno_id, 'tipo', v_tipo,
    'lanche', p_lanche, 'suco', p_suco, 'entregues', 2);
end;
$$;

revoke all on function public.registrar_entrega_completa(text,text,text,text) from public;
grant execute on function public.registrar_entrega_completa(text,text,text,text) to authenticated;
