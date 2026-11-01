import { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from './QRCodeSVG';
import { supabase } from './supabase';
import Cardapio from './Cardapio';
import './Main.css';
import { carregarEstoque, carregarRetiradasHoje, dataDeHoje, ouvirAtualizacoes } from './store';

function Main() {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [alunoLogado, setAlunoLogado] = useState(null);
  const [estoque, setEstoque] = useState(0);
  const [lanches, setLanches] = useState([]);
  const [horaAtual, setHoraAtual] = useState(() => new Date());
  const [erroLogin, setErroLogin] = useState('');
  const [carregando, setCarregando] = useState(false);

  const atualizarCarteirinha = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const [itens, registros] = await Promise.all([carregarEstoque(), carregarRetiradasHoje()]);
      setEstoque(itens.reduce((total, item) => total + item.quantidade, 0));
      setLanches(registros);
      setHoraAtual(new Date());
    } catch (error) { setErroLogin(`Não foi possível atualizar os dados: ${error.message}`); }
  }, []);

  useEffect(() => {
    let ativo = true;
    async function restaurarSessao() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || !ativo) return;
      const { data: aluno, error } = await supabase.from('alunos')
        .select('id,nome,email,auth_user_id')
        .eq('auth_user_id', session.user.id)
        .maybeSingle();
      if (!ativo) return;
      if (error) setErroLogin(`Não foi possível validar o aluno: ${error.message}`);
      else if (aluno) setAlunoLogado(aluno);
      else await supabase.auth.signOut();
    }
    restaurarSessao().then(atualizarCarteirinha);
    let remover = () => {};
    try { remover = ouvirAtualizacoes(atualizarCarteirinha); } catch { /* atualização ao focar */ }
    const timer = window.setInterval(atualizarCarteirinha, 30000);
    return () => { ativo = false; remover(); window.clearInterval(timer); };
  }, [atualizarCarteirinha]);

  async function entrar(e) {
    e.preventDefault(); setErroLogin(''); setCarregando(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password: senha });
      if (error || !data.user) throw error || new Error('Login inválido.');
      const { data: aluno, error: alunoError } = await supabase.from('alunos').select('id,nome,email,auth_user_id').eq('auth_user_id', data.user.id).maybeSingle();
      if (alunoError) throw alunoError;
      if (!aluno) { await supabase.auth.signOut(); throw new Error('Esta conta não está cadastrada como aluno.'); }
      setAlunoLogado(aluno); setSenha(''); await atualizarCarteirinha();
    } catch (error) { setErroLogin(error.message || 'Usuário ou senha incorretos.'); }
    finally { setCarregando(false); }
  }

  async function sair() {
    try { await supabase.auth.signOut(); } finally { setAlunoLogado(null); setEmail(''); setSenha(''); setErroLogin(''); }
  }

  if (alunoLogado) {
    const conteudoQR = JSON.stringify({ id: alunoLogado.id, nome: alunoLogado.nome });
    const retiradasAluno = lanches.filter((r) => r.alunoId === alunoLogado.id).length;
    const agora = horaAtual.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    return <main className="site-main">
      <section id="area-aluno" className="carteirinha">
        <span className="eyebrow">SENAI · ALIMENTAÇÃO</span><h2>SENAI Fila Zero</h2><h3>Carteirinha digital</h3>
        <div className="carteirinha-identidade"><span className="avatar-aluno" aria-hidden="true">{alunoLogado.nome.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase()}</span><div><p className="nome-aluno">{alunoLogado.nome}</p><p className="numero-aluno">Nº da carteirinha: <strong>{alunoLogado.id}</strong></p></div></div>
        <div className="qr-area"><QRCodeSVG value={conteudoQR} size={180} /><p>Apresente este QR Code ao funcionário.</p></div>
        <div className="status-intervalo status-carteirinha status-liberado" role="status">{retiradasAluno === 0 ? 'Você ainda não retirou seu lanche hoje.' : `Retiradas registradas hoje: ${retiradasAluno}.`}</div>
        <p>Estoque total disponível: {estoque}</p><p>Atualizado às {agora}</p>
        <div className="acoes-carteirinha"><button className="btn-atualizar-carteirinha" type="button" onClick={atualizarCarteirinha}>Atualizar carteirinha</button><button className="btn-secundario" type="button" onClick={sair}>Sair</button></div>
      </section>
      <Cardapio />
    </main>;
  }

  return <main className="site-main"><section id="area-aluno" className="main-container login-aluno">
    <span className="eyebrow">ACESSO DO ESTUDANTE</span><h1>Entre na sua carteirinha</h1>
    <p className="texto-intro">Digite o e-mail e a senha cadastrados no sistema para acessar seu QR Code.</p>
    <form onSubmit={entrar}><label htmlFor="emailAluno">E-mail</label><input id="emailAluno" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="seu e-mail escolar" autoComplete="username" required />
      <label htmlFor="senhaAluno">Senha</label><input id="senhaAluno" type="password" value={senha} onChange={(e) => setSenha(e.target.value)} placeholder="Digite sua senha" autoComplete="current-password" required />
      {erroLogin && <p className="erro-login" role="alert">{erroLogin}</p>}<button className="btn-login" type="submit" disabled={carregando}>{carregando ? 'Entrando...' : 'Entrar'}</button>
    </form>
    <Cardapio />
  </section></main>;
}
export default Main;
