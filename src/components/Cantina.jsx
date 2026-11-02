
import { useCallback, useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import './Main.css';
import {
  carregarEstoque,
  carregarCardapio,
  carregarRetiradasHoje,
  carregarAlunos,
  atualizarQuantidade,
  registrarRetirada,
  liberarRepeticao,
  carregarStatusRepeticao,
  reiniciarDia,
  ouvirAtualizacoes
} from './store';
import { supabase } from './supabase';

const EMAIL_FUNCIONARIO = (usuario) => {
  const valor = usuario.trim().toLowerCase();
  return valor.includes('@') ? valor : `${valor}@funcionarios.filazero.com`;
};

function Cantina() {
  const [funcionario, setFuncionario] = useState(null);
  const [login, setLogin] = useState({ usuario: '', senha: '' });
  const [codigo, setCodigo] = useState('');
  const [aluno, setAluno] = useState(null);
  const [mensagem, setMensagem] = useState('');
  const [lendo, setLendo] = useState(false);
  const [estoque, setEstoque] = useState([]);
  const [retiradas, setRetiradas] = useState([]);
  const [alunos, setAlunos] = useState([]);
  const [statusRepeticao, setStatusRepeticao] = useState({ liberada: false, todos_receberam: false });
  const [quantidades, setQuantidades] = useState({});
  const [carregando, setCarregando] = useState(true);
  const [entregando, setEntregando] = useState(false);
  const entregaEmAndamento = useRef(false);

  const atualizarDados = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const itens = await carregarEstoque();
      setEstoque(itens);
      setQuantidades((atual) => ({
        ...atual,
        ...Object.fromEntries(itens.map((item) => [item.item, String(item.quantidade)]))
      }));

      if (session) {
        const [registros, lista, status] = await Promise.all([
          carregarRetiradasHoje(),
          carregarAlunos(),
          carregarStatusRepeticao()
        ]);
        setRetiradas(registros);
        setAlunos(lista);
        setStatusRepeticao(status || { liberada: false, todos_receberam: false });
      } else {
        setRetiradas([]);
      }
    } catch (error) {
      setMensagem(`Não foi possível carregar os dados: ${error.message}`);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    Promise.resolve().then(atualizarDados);
    let remover = () => {};

    try {
      remover = ouvirAtualizacoes(atualizarDados);
    } catch {
      /* atualização ao focar */
    }

    const foco = () => atualizarDados();
    window.addEventListener('focus', foco);

    return () => {
      remover();
      window.removeEventListener('focus', foco);
    };
  }, [atualizarDados]);

  useEffect(() => {
    if (!lendo) return undefined;

    const leitor = new Html5Qrcode('leitor-qr');
    let cancelado = false;

    leitor.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 250 },
      async (texto) => {
        if (cancelado) return;
        setLendo(false);

        try {
          let numero = texto.trim();

          try {
            const dados = JSON.parse(texto);
            numero = String(dados.id || dados.carteirinha || dados.numero || '').trim();
          } catch {
            /* QR pode conter diretamente o número da carteirinha */
          }

          if (!numero) throw new Error('QR Code inválido.');

          const encontrado = alunos.find(
            (a) => String(a.id).replace(/\s+/g, '').toUpperCase() ===
              numero.replace(/\s+/g, '').toUpperCase()
          );

          if (!encontrado) throw new Error('Aluno não encontrado no cadastro.');

          await registrarLancheAutomatico(encontrado);
        } catch (error) {
          setMensagem(error.message);
        }
      },
      () => {}
    ).catch(() => {
      if (!cancelado) {
        setMensagem('Não foi possível abrir a câmera. Digite o número da carteirinha do aluno.');
        setLendo(false);
      }
    });

    return () => {
      cancelado = true;
      try {
        leitor.stop().catch(() => {});
      } catch {
        /* câmera já encerrada */
      }
    };
  }, [lendo, alunos]);

  async function entrar(e) {
    e.preventDefault();
    setMensagem('');

    try {
      if (!supabase) {
        throw new Error('Supabase não configurado. Confira o arquivo .env.local e reinicie o servidor.');
      }

      const email = EMAIL_FUNCIONARIO(login.usuario);

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password: login.senha
      });

      if (error) {
        console.error('Falha na autenticação do funcionário:', {
          message: error.message,
          status: error.status,
          code: error.code
        });

        throw new Error(
          error.message === 'Invalid login credentials'
            ? 'E-mail ou senha não conferem com a conta do Supabase Auth. Confira o e-mail cadastrado e a senha; o sistema não consegue consultar a senha atual.'
            : `Falha no login: ${error.message}`
        );
      }

      if (!data.user) {
        throw new Error('O Supabase não retornou um usuário autenticado.');
      }

      const { data: perfil, error: perfilError } = await supabase
        .from('funcionarios')
        .select('id,nome,usuario,perfil')
        .eq('id', data.user.id)
        .maybeSingle();

      if (perfilError) throw perfilError;

      if (!perfil) {
        await supabase.auth.signOut();
        throw new Error('Esta conta não está cadastrada como funcionário.');
      }

      setFuncionario(perfil);
      setLogin({ usuario: '', senha: '' });
      await atualizarDados();
    } catch (error) {
      console.error('Erro ao entrar no painel:', error);
      setMensagem(error.message || 'Não foi possível entrar.');
    }
  }

  async function sair() {
    await supabase.auth.signOut();
    setFuncionario(null);
    setAluno(null);
    setMensagem('');
  }

  useEffect(() => {
    const valor = codigo.trim().replace(/\s+/g, '').toUpperCase();

    if (!valor || !funcionario || entregando || entregaEmAndamento.current) return;

    const encontrado = alunos.find(
      (a) => String(a.id).replace(/\s+/g, '').toUpperCase() === valor
    );

    if (encontrado) registrarLancheAutomatico(encontrado);
  }, [codigo, alunos, funcionario, entregando]);

  async function registrarLancheAutomatico(alunoAtual) {
    if (!alunoAtual || entregaEmAndamento.current) return;

    entregaEmAndamento.current = true;
    setEntregando(true);
    setMensagem(`Registrando o lanche de hoje para ${alunoAtual.nome}...`);

    try {
      const cardapio = await carregarCardapio();

      const lanchesDoDia = cardapio.filter(
        (item) => !/suco|água|bebida/i.test(item.nome)
      );

      const lancheDoDia = lanchesDoDia[0];

      if (!lancheDoDia) {
        throw new Error('Não há lanche cadastrado no cardápio de hoje.');
      }

      const itemEstoque = estoque.find(
        (item) => normalizarItem(item.item) === normalizarItem(lancheDoDia.nome)
      );

      if (!itemEstoque || itemEstoque.quantidade <= 0) {
        throw new Error(`Sem estoque para ${lancheDoDia.nome}.`);
      }

      await registrarRetirada(alunoAtual.id, funcionario.nome, itemEstoque.item);

      setCodigo('');
      setMensagem(
        `Lanche retirado com sucesso! ${alunoAtual.nome} recebeu ${itemEstoque.item} + suco de maçã.`
      );

      await atualizarDados();
    } catch (error) {
      console.error('Falha ao registrar lanche automaticamente:', error);
      setMensagem(error.message || 'Não foi possível registrar a retirada.');
      await atualizarDados();
    } finally {
      entregaEmAndamento.current = false;
      setEntregando(false);
    }
  }

  const normalizarItem = (nome) =>
    (nome || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();

  const retiradasDoAluno = (id) => retiradas.filter((r) => r.alunoId === id);

  async function salvarEstoque(item) {
    const disponivel = Number(quantidades[item.item]);

    if (!Number.isInteger(disponivel) || disponivel < 0) {
      setMensagem('Informe uma quantidade inteira e não negativa.');
      return;
    }

    try {
      await atualizarQuantidade(item.item, disponivel);
      setMensagem(`Estoque de ${item.item} atualizado.`);
      await atualizarDados();
    } catch (error) {
      setMensagem(error.message);
    }
  }

  async function liberar() {
    if (!window.confirm('Confirma liberar a repetição para os alunos?')) return;

    try {
      const resultado = await liberarRepeticao();
      setMensagem(resultado?.mensagem || 'REPETIÇÃO LIBERADA!');
      await atualizarDados();
    } catch (error) {
      setMensagem(error.message || 'Não foi possível liberar a repetição.');
    }
  }

  async function reiniciar() {
    if (!window.confirm('Confirma reiniciar o estoque para o próximo dia? O histórico de retiradas será preservado.')) return;

    try {
      const resultado = await reiniciarDia();
      setMensagem(`Estoque reiniciado: ${resultado.itens_reiniciados} itens.`);
      await atualizarDados();
    } catch (error) {
      setMensagem(error.message);
    }
  }

  if (!funcionario) {
    return (
      <div id="area-cantina" className="funcionario">
        <h2>SENAI Fila Zero</h2>
        <h3>Login do Funcionário</h3>

        <form onSubmit={entrar}>
          <label htmlFor="usuarioFunc">Usuário</label>
          <input
            id="usuarioFunc"
            className="input-2"
            value={login.usuario}
            onChange={(e) => setLogin({ ...login, usuario: e.target.value })}
            required
          />

          <label htmlFor="senhaFunc">Senha</label>
          <input
            id="senhaFunc"
            className="input-3"
            type="password"
            value={login.senha}
            onChange={(e) => setLogin({ ...login, senha: e.target.value })}
            required
          />

          <button className="btn-2" type="submit">Entrar</button>
        </form>

        {mensagem && <p role="alert">{mensagem}</p>}
      </div>
    );
  }

  const retiradasPorAluno = (id) =>
    retiradas.filter((r) => r.alunoId === id).length;

  const totalDisponivel = estoque.reduce((s, i) => s + i.quantidade, 0);
  const totalRetirado = retiradas.reduce((s, r) => s + r.quantidade, 0);

  return (
    <div id="area-cantina" className="funcionario">
      <h2>SENAI Fila Zero</h2>
      <h3>Painel do Funcionário</h3>

      <p>Olá, {funcionario.nome} ({funcionario.perfil})!</p>
      <button type="button" onClick={sair}>Sair</button>

      {lendo ? (
        <>
          <div id="leitor-qr" style={{ width: 300 }} />
          <button type="button" onClick={() => setLendo(false)}>Cancelar</button>
        </>
      ) : (
        <button
          className="btn-1"
          type="button"
          onClick={() => {
            setMensagem('');
            setLendo(true);
          }}
        >
          Ler QR Code com a câmera
        </button>
      )}

      <div className="painel-estoque">
        <h3>Estoque de lanches</h3>

        {carregando ? (
          <p>Carregando...</p>
        ) : (
          <>
            <p><strong>Disponíveis agora:</strong> {totalDisponivel}</p>
            <p><strong>Retirados hoje:</strong> {totalRetirado}</p>

            {estoque.map((item) => (
              <div className="aluno-retirada" key={item.id}>
                <p><strong>{item.item}</strong></p>
                <p>
                  Inicial: {item.quantidade_inicial} · Disponível: {item.quantidade} ·
                  Retirado hoje: {item.retiradas_no_dia}
                </p>

                <label htmlFor={`qtd-${item.id}`}>Definir quantidade disponível</label>
                <input
                  id={`qtd-${item.id}`}
                  type="number"
                  min="0"
                  step="1"
                  value={quantidades[item.item] ?? item.quantidade}
                  onChange={(e) =>
                    setQuantidades({ ...quantidades, [item.item]: e.target.value })
                  }
                />

                <button type="button" onClick={() => salvarEstoque(item)}>
                  Salvar estoque
                </button>
              </div>
            ))}
          </>
        )}

        <p className={`rodada-status ${statusRepeticao.liberada ? 'liberada' : ''}`}>
          {statusRepeticao.liberada
            ? 'Repetição liberada.'
            : 'Primeira distribuição em andamento. O funcionário pode liberar a repetição quando terminar.'}
        </p>

        {!statusRepeticao.liberada && (
          <button
            className="btn-2"
            type="button"
            disabled={totalDisponivel <= 0}
            onClick={liberar}
          >
            LIBERAR REPETIÇÃO
          </button>
        )}

        {funcionario.perfil === 'admin' && (
          <button className="btn-2" type="button" onClick={reiniciar}>
            REINICIAR ESTOQUE PARA O PRÓXIMO DIA
          </button>
        )}
      </div>

      <div className="busca-carteirinha">
        <label htmlFor="codigo">Número da carteirinha do aluno</label>
        <input
          id="codigo"
          className="input-1"
          value={codigo}
          onChange={(e) => {
            setCodigo(e.target.value);
            setMensagem('');
          }}
          placeholder="Digite o número da carteirinha"
          autoComplete="off"
        />
      </div>

      {mensagem && <p role="status">{mensagem}</p>}
      {entregando && <p role="status">Registrando retirada automaticamente...</p>}

      <section className="lista-alunos-funcionario">
        <h3>Alunos e retiradas</h3>

        {alunos.map((a) => (
          <div className="aluno-retirada" key={a.id}>
            <p><strong>{a.nome}</strong></p>
            <p>Retiradas hoje: {retiradasPorAluno(a.id)}</p>
          </div>
        ))}
      </section>

      <h3>Lanches entregues hoje ({retiradas.length})</h3>

      {retiradas.length === 0 ? (
        <p>Nenhum lanche entregue ainda.</p>
      ) : (
        <ul>
          {retiradas.map((r) => (
            <li key={r.id}>
              {r.hora} — {r.nome} ({r.item})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default Cantina;
