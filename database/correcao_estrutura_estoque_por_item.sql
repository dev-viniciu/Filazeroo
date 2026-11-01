-- Compatibilidade com o banco existente: estoque.item (TEXT), sem cardapio_id.
-- Faça backup antes. Não apaga nem recria tabelas e preserva o histórico.

BEGIN;

ALTER TABLE public.cardapio
  ADD COLUMN IF NOT EXISTS categoria text,
  ADD COLUMN IF NOT EXISTS imagem_url text;

ALTER TABLE public.estoque
  ADD COLUMN IF NOT EXISTS atualizado_em timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS quantidade_inicial integer,
  ADD COLUMN IF NOT EXISTS retiradas_no_dia integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS data_referencia date NOT NULL DEFAULT (timezone('America/Sao_Paulo', now())::date);

UPDATE public.estoque
SET quantidade_inicial = quantidade
WHERE quantidade_inicial IS NULL;

ALTER TABLE public.estoque ALTER COLUMN quantidade_inicial SET DEFAULT 0;
ALTER TABLE public.estoque ALTER COLUMN quantidade_inicial SET NOT NULL;

CREATE OR REPLACE FUNCTION public.atualizar_estoque_item(
  p_item text,
  p_quantidade integer,
  p_quantidade_inicial integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE v public.estoque%ROWTYPE;
BEGIN
  IF NOT public.eh_funcionario() THEN
    RAISE EXCEPTION 'Acesso negado: funcionário autorizado necessário.';
  END IF;
  IF p_item IS NULL OR p_quantidade IS NULL OR p_quantidade < 0 THEN
    RAISE EXCEPTION 'Item ou quantidade inválida.';
  END IF;
  IF p_quantidade_inicial IS NOT NULL AND (p_quantidade_inicial < 0 OR NOT public.eh_admin()) THEN
    RAISE EXCEPTION 'Somente administradores podem alterar a quantidade inicial.';
  END IF;
  SELECT * INTO v FROM public.estoque WHERE item = p_item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item de estoque não encontrado: %', p_item; END IF;
  UPDATE public.estoque
  SET quantidade = p_quantidade,
      quantidade_inicial = COALESCE(p_quantidade_inicial, quantidade_inicial),
      atualizado_em = now()
  WHERE id = v.id RETURNING * INTO v;
  RETURN jsonb_build_object('item', v.item, 'quantidade', v.quantidade, 'quantidade_inicial', v.quantidade_inicial);
END;
$$;

CREATE OR REPLACE FUNCTION public.registrar_retirada(p_aluno_id uuid, p_cardapio_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_nome_produto text;
  v_estoque public.estoque%ROWTYPE;
  v_repeticao boolean;
  v_inicio timestamptz;
  v_ja_retirou boolean;
  v_id bigint;
  v_funcionario uuid;
  v_nome_funcionario text;
BEGIN
  IF NOT public.eh_funcionario() THEN RAISE EXCEPTION 'Acesso negado: funcionário autorizado necessário.'; END IF;
  PERFORM public.garantir_dia_atual();
  IF p_aluno_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.alunos WHERE id = p_aluno_id) THEN
    RAISE EXCEPTION 'Aluno não encontrado.';
  END IF;
  SELECT nome INTO v_nome_produto FROM public.cardapio WHERE id = p_cardapio_id AND disponivel = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Produto não encontrado ou indisponível no cardápio.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_aluno_id::text)::bigint);
  SELECT repeticao_liberada, inicio_ciclo INTO v_repeticao, v_inicio
  FROM public.configuracoes_fila_zero WHERE singleton = true FOR UPDATE;
  SELECT EXISTS (
    SELECT 1 FROM public.retiradas r
    WHERE r.aluno_id = p_aluno_id AND r.retirado_em >= v_inicio
  ) INTO v_ja_retirou;
  IF v_ja_retirou AND NOT COALESCE(v_repeticao, false) THEN
    RAISE EXCEPTION 'Este aluno já recebeu o primeiro lanche. A repetição ainda não foi liberada.';
  END IF;
  SELECT * INTO v_estoque FROM public.estoque WHERE lower(trim(item)) = lower(trim(v_nome_produto)) FOR UPDATE;
  IF NOT FOUND OR v_estoque.quantidade <= 0 THEN RAISE EXCEPTION 'Sem estoque disponível para este lanche.'; END IF;
  SELECT id, nome INTO v_funcionario, v_nome_funcionario FROM public.funcionarios WHERE id = auth.uid();
  UPDATE public.estoque
  SET quantidade = quantidade - 1,
      retiradas_no_dia = retiradas_no_dia + 1,
      atualizado_em = now(),
      data_referencia = timezone('America/Sao_Paulo', now())::date
  WHERE id = v_estoque.id;
  INSERT INTO public.retiradas(aluno_id, cardapio_id, quantidade, retirado_em, tipo, funcionario_id)
  VALUES (p_aluno_id, p_cardapio_id, 1, now(),
    CASE WHEN v_ja_retirou THEN 'repeticao' ELSE 'primeira' END, v_funcionario)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id,
    'tipo', CASE WHEN v_ja_retirou THEN 'repeticao' ELSE 'primeira' END,
    'quantidade_disponivel', v_estoque.quantidade - 1,
    'funcionario', v_nome_funcionario);
END;
$$;

REVOKE ALL ON FUNCTION public.atualizar_estoque_item(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.atualizar_estoque_item(text, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.registrar_retirada(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_retirada(uuid, bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
