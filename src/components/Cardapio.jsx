import { useEffect, useState } from 'react';
import './Cardapio.css';
import { carregarCardapio, carregarEstoque, ouvirAtualizacoes } from './store';

function Cardapio() {
  const [itens, setItens] = useState([]);
  const [estoque, setEstoque] = useState({});
  const [erro, setErro] = useState('');

  useEffect(() => {
    let ativo = true;
    const atualizar = async () => {
      try {
        const [catalogo, quantidades] = await Promise.all([carregarCardapio(), carregarEstoque()]);
        if (!ativo) return;
        setItens(catalogo);
        setEstoque(Object.fromEntries(quantidades.map((item) => [item.item.trim().toLocaleLowerCase('pt-BR'), item.quantidade])));
        setErro('');
      } catch (error) { if (ativo) setErro(`Não foi possível carregar o cardápio: ${error.message}`); }
    };
    atualizar();
    let remover = () => {};
    try { remover = ouvirAtualizacoes(atualizar); } catch { /* atualização periódica */ }
    const timer = window.setInterval(atualizar, 30000);
    return () => { ativo = false; remover(); window.clearInterval(timer); };
  }, []);

  const lanches = itens.filter((item) => !/suco|água|bebida/i.test(item.nome));
  const bebidas = itens.filter((item) => /suco|água|bebida/i.test(item.nome));
  const destaque = lanches[0];
  const imagem = (item) => item?.imagem_url || '';
  const quantidade = (item) => estoque[item.nome.trim().toLocaleLowerCase('pt-BR')] ?? 0;

  return (
    <section id="cardapio" className="cardapio">
      <h2>Cardápio do dia</h2>
      <p className="cardapio-subtitulo">Opções cadastradas pela cantina e disponibilidade atual.</p>
      {erro && <p role="alert">{erro}</p>}
      {!erro && itens.length === 0 ? <p>Nenhum item disponível no cardápio.</p> : <>
        {destaque && <>
          <article className="cardapio-principal">
            {imagem(destaque) && <img src={imagem(destaque)} alt={destaque.nome} />}
            <div className="cardapio-principal-texto"><span className="cardapio-etiqueta">LANCHE DE HOJE</span><h3>{destaque.nome}</h3><p>{destaque.descricao}</p><p><strong>{quantidade(destaque) > 0 ? `${quantidade(destaque)} disponíveis` : 'Sem lanche disponível'}</strong></p></div>
          </article>
          {lanches.length > 1 && <><h3 className="cardapio-titulo-secao">Outras opções de lanche</h3><div className="cardapio-lista">{lanches.slice(1).map((item) => <article className="cardapio-item" key={item.id}>{imagem(item) && <img src={imagem(item)} alt={item.nome} loading="lazy" />}<div><h4>{item.nome}</h4><p>{item.descricao}</p><p><strong>{quantidade(item) > 0 ? `${quantidade(item)} disponíveis` : 'Sem lanche disponível'}</strong></p></div></article>)}</div></>}
        </>}
        {bebidas.length > 0 && <><h3 className="cardapio-titulo-secao">Bebidas</h3><div className="cardapio-bebidas">{bebidas.map((item) => <article className="cardapio-bebida" key={item.id}>{imagem(item) && <img src={imagem(item)} alt={item.nome} loading="lazy" />}<span>{item.nome} · {quantidade(item) > 0 ? `${quantidade(item)} disponíveis` : 'Indisponível'}</span></article>)}</div></>}
      </>}
      <p className="cardapio-observacao">A disponibilidade é consultada diretamente no estoque do Supabase.</p>
    </section>
  );
}
export default Cardapio;
