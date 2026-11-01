import { Home, Utensils, UserRound } from 'lucide-react';
import minhaLogo from '../assets/logo.png';
import './Header.css';

function irPara(id) {
  const destino = document.getElementById(id);
  if (destino) destino.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function Header() {
  return (
    <header className="header-container">
      <button type="button" className="logo-link" onClick={() => irPara('area-aluno')} aria-label="Ir para a área do aluno">
        <img src={minhaLogo} alt="SENAI Fila Zero" className="minhaLogo" />
      </button>
      <nav className="nav" aria-label="Navegação principal">
        <button type="button" className="nav-button" onClick={() => irPara('area-aluno')} aria-label="Início" title="Início">
          <Home className="icon" size={23} />
          <span>Início</span>
        </button>
        <button type="button" className="nav-button" onClick={() => irPara('cardapio')} aria-label="Cardápio" title="Cardápio">
          <Utensils className="icon" size={23} />
          <span>Cardápio</span>
        </button>
        <button type="button" className="nav-button" onClick={() => irPara('area-cantina')} aria-label="Área do funcionário" title="Área do funcionário">
          <UserRound className="icon" size={23} />
          <span>Funcionário</span>
        </button>
      </nav>
    </header>
  );
}
