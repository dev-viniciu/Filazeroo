import "./Footer.css";

export default function Footer() {
  return (
    <footer className="footer">
      <h3>SENAI Fila Zero</h3>

      <a href="mailto:aisenai.filazero@gmail.com">
        senai.filazero@gmail.com
      </a>

      <p>
        © {new Date().getFullYear()} SENAI Fila Zero.
        Todos os direitos reservados.
      </p>
    </footer>
  );
}