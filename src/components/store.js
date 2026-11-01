import { supabase } from './supabase';

export function dataDeHoje() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function client() {
  if (!supabase) throw new Error('Supabase não configurado. Confira VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.');
  return supabase;
}

export async function carregarEstoque() {
  const { data: { session } } = await client().auth.getSession();
  if (session) {
    const { error: diaError } = await client().rpc('garantir_dia_atual');
    if (diaError) throw diaError;
  }
  // O banco existente identifica o estoque pelo texto de estoque.item.
  // Não existe estoque.cardapio_id nem relacionamento FK com cardapio.
  const { data, error } = await client().from('estoque')
    .select('id,item,quantidade,quantidade_inicial,retiradas_no_dia,data_referencia,atualizado_em')
    .order('item');
  if (error) throw error;
  return (data || []).map((row) => ({ ...row, cardapio_id: null }));
}

export async function carregarCardapio() {
  const { data, error } = await client().from('cardapio')
    .select('id,nome,descricao,categoria,imagem_url,disponivel').eq('disponivel', true).order('nome');
  if (error) throw error;
  return data || [];
}

export async function carregarRetiradasHoje() {
  const { data, error } = await client().rpc('listar_retiradas_hoje');
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id, alunoId: row.aluno_id, nome: row.aluno_nome || row.aluno_id,
    item: row.item, quantidade: row.quantidade, tipo: row.tipo,
    hora: new Date(row.retirado_em).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })
  }));
}

export async function carregarAlunos() {
  const { data, error } = await client().from('alunos').select('id,nome').order('nome');
  if (error) throw error;
  return data || [];
}

export async function atualizarQuantidade(cardapioId, quantidade, quantidadeInicial = null) {
  const { data, error } = await client().rpc('atualizar_estoque_item', {
    p_item: cardapioId, p_quantidade: quantidade, p_quantidade_inicial: quantidadeInicial
  });
  if (error) throw error;
  return data;
}

export async function registrarRetirada(alunoId, funcionario, item) {
  // RPC exclusiva para a entrega automática; evita conflito com a antiga
  // sobrecarga registrar_retirada(uuid, bigint).
  const { data, error } = await client().rpc('registrar_lanche_automatico', {
    p_aluno_id: String(alunoId),
    p_funcionario: String(funcionario),
    p_item: String(item)
  });
  if (error) throw error;
  return data;
}

export async function registrarEntregaCompleta(alunoId, funcionario, lanche, suco) {
  const { data, error } = await client().rpc('registrar_entrega_completa', {
    p_aluno_id: String(alunoId),
    p_funcionario: String(funcionario),
    p_lanche: String(lanche),
    p_suco: String(suco)
  });
  if (error) throw error;
  return data;
}

export async function liberarRepeticao() {
  const { data, error } = await client().rpc('liberar_repeticao');
  if (error) throw error;
  return data;
}

export async function carregarStatusRepeticao() {
  const { data, error } = await client().rpc('status_repeticao');
  if (error) throw error;
  return data;
}

export async function reiniciarDia() {
  const { data, error } = await client().rpc('reiniciar_estoque_dia');
  if (error) throw error;
  return data;
}

export function ouvirAtualizacoes(callback) {
  const channel = client().channel(`filazero-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'estoque' }, callback)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'retiradas' }, callback)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cardapio' }, callback)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'configuracoes_fila_zero' }, callback)
    .subscribe();
  return () => client().removeChannel(channel);
}
