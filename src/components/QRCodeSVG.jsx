import { useMemo } from 'react';

// =====================================================================
// Gerador de QR Code sem bibliotecas externas.
// Funciona como o QRCodeSVG do "qrcode.react": <QRCodeSVG value="..." size={180} />
// Usa modo byte (aceita acentos) e correção de erros nível M.
// =====================================================================

// Tabelas do padrão QR (versões 1 a 40, nível de correção M)
const ECC_POR_BLOCO = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const NUM_BLOCOS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

function bit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

// Quantidade de módulos que sobram para dados + correção de erros
function modulosBrutos(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
}

function codewordsDeDados(v) {
  return Math.floor(modulosBrutos(v) / 8) - ECC_POR_BLOCO[v] * NUM_BLOCOS[v];
}

// ----- Reed-Solomon (correção de erros) -----
function multiplicaGF(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisorRS(grau) {
  const r = new Array(grau).fill(0);
  r[grau - 1] = 1;
  let raiz = 1;
  for (let i = 0; i < grau; i++) {
    for (let j = 0; j < grau; j++) {
      r[j] = multiplicaGF(r[j], raiz);
      if (j + 1 < grau) r[j] ^= r[j + 1];
    }
    raiz = multiplicaGF(raiz, 0x02);
  }
  return r;
}

function restoRS(dados, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of dados) {
    const fator = b ^ r.shift();
    r.push(0);
    divisor.forEach((coef, i) => {
      r[i] ^= multiplicaGF(coef, fator);
    });
  }
  return r;
}

// ----- Texto -> bytes de dados -----
function codificar(texto) {
  const bytes = Array.from(new TextEncoder().encode(texto));

  // Acha a menor versão em que o texto cabe
  let v = 1;
  for (; ; v++) {
    if (v > 40) throw new Error('Texto grande demais para o QR Code');
    const usado = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
    if (usado <= codewordsDeDados(v) * 8) break;
  }

  const bits = [];
  const add = (valor, tam) => {
    for (let i = tam - 1; i >= 0; i--) bits.push((valor >>> i) & 1);
  };

  add(0b0100, 4); // modo byte
  add(bytes.length, v <= 9 ? 8 : 16); // quantidade de caracteres
  bytes.forEach((b) => add(b, 8));

  const cap = codewordsDeDados(v) * 8;
  add(0, Math.min(4, cap - bits.length)); // terminador
  add(0, (8 - (bits.length % 8)) % 8); // completa o byte
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) add(pad, 8);

  const dados = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dados.push(b);
  }
  return { v, dados };
}

// Divide em blocos, calcula a correção de erros e intercala
function comCorrecao(dados, v) {
  const numBlocos = NUM_BLOCOS[v];
  const eccLen = ECC_POR_BLOCO[v];
  const total = Math.floor(modulosBrutos(v) / 8);
  const numCurtos = numBlocos - (total % numBlocos);
  const tamCurto = Math.floor(total / numBlocos);

  const divisor = divisorRS(eccLen);
  const blocos = [];
  for (let i = 0, k = 0; i < numBlocos; i++) {
    const dat = dados.slice(k, k + tamCurto - eccLen + (i < numCurtos ? 0 : 1));
    k += dat.length;
    const ecc = restoRS(dat, divisor);
    if (i < numCurtos) dat.push(0);
    blocos.push(dat.concat(ecc));
  }

  const saida = [];
  for (let i = 0; i < blocos[0].length; i++) {
    blocos.forEach((bloco, j) => {
      if (i !== tamCurto - eccLen || j >= numCurtos) saida.push(bloco[i]);
    });
  }
  return saida;
}

// ----- Desenho da matriz -----
function posicoesAlinhamento(v) {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2;
  const passo = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = v * 4 + 10; r.length < n; pos -= passo) r.splice(1, 0, pos);
  return r;
}

function penalidade(m, n) {
  let p = 0;

  // Regras 1 e 3: sequências iguais e padrões parecidos com os cantos
  const linhas = [];
  for (let y = 0; y < n; y++) linhas.push(m[y]);
  for (let x = 0; x < n; x++) linhas.push(m.map((l) => l[x]));
  for (const linha of linhas) {
    let cont = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && linha[i] === linha[i - 1]) cont++;
      else {
        if (cont >= 5) p += cont - 2;
        cont = 1;
      }
    }
    const s = linha.map((c) => (c ? '1' : '0')).join('');
    for (const padrao of ['00001011101', '10111010000']) {
      let i = s.indexOf(padrao);
      while (i !== -1) {
        p += 40;
        i = s.indexOf(padrao, i + 1);
      }
    }
  }

  // Regra 2: blocos 2x2 da mesma cor
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
  }

  // Regra 4: equilíbrio entre módulos claros e escuros
  let escuros = 0;
  m.forEach((l) => l.forEach((c) => c && escuros++));
  const total = n * n;
  p += (Math.ceil(Math.abs(escuros * 20 - total * 10) / total) - 1) * 10;

  return p;
}

// Gera a matriz de módulos (true = escuro) para o texto
function gerarMatriz(texto) {
  const { v, dados } = codificar(texto);
  const codewords = comCorrecao(dados, v);
  const n = v * 4 + 17;

  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fixo = Array.from({ length: n }, () => new Array(n).fill(false));
  const setFixo = (x, y, escuro) => {
    m[y][x] = escuro;
    fixo[y][x] = true;
  };

  // Linhas de tempo
  for (let i = 0; i < n; i++) {
    setFixo(6, i, i % 2 === 0);
    setFixo(i, 6, i % 2 === 0);
  }

  // Os três quadrados grandes dos cantos
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < n && y >= 0 && y < n) setFixo(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(n - 4, 3);
  finder(3, n - 4);

  // Quadradinhos de alinhamento
  const alin = posicoesAlinhamento(v);
  const na = alin.length;
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFixo(alin[i] + dx, alin[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Bits de formato (nível M = 0 + máscara)
  const formato = (mascara) => {
    const d = (0 << 3) | mascara;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const bits = ((d << 10) | r) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFixo(8, i, bit(bits, i));
    setFixo(8, 7, bit(bits, 6));
    setFixo(8, 8, bit(bits, 7));
    setFixo(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) setFixo(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) setFixo(n - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) setFixo(8, n - 15 + i, bit(bits, i));
    setFixo(8, n - 8, true);
  };
  formato(0);

  // Bits de versão (versões 7 ou maiores)
  if (v >= 7) {
    let r = v;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (v << 12) | r;
    for (let i = 0; i < 18; i++) {
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFixo(a, b, bit(bits, i));
      setFixo(b, a, bit(bits, i));
    }
  }

  // Coloca os dados em zigue-zague
  let k = 0;
  for (let dir = n - 1; dir >= 1; dir -= 2) {
    if (dir === 6) dir = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = dir - j;
        const sobe = ((dir + 1) & 2) === 0;
        const y = sobe ? n - 1 - vert : vert;
        if (!fixo[y][x] && k < codewords.length * 8) {
          m[y][x] = bit(codewords[k >>> 3], 7 - (k & 7));
          k++;
        }
      }
    }
  }

  // Máscara: testa as 8 e fica com a de menor penalidade
  const aplicaMascara = (mascara) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let inverte;
        switch (mascara) {
          case 0: inverte = (x + y) % 2 === 0; break;
          case 1: inverte = y % 2 === 0; break;
          case 2: inverte = x % 3 === 0; break;
          case 3: inverte = (x + y) % 3 === 0; break;
          case 4: inverte = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inverte = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inverte = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inverte = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!fixo[y][x] && inverte) m[y][x] = !m[y][x];
      }
    }
  };

  let melhor = 0;
  let menor = Infinity;
  for (let mascara = 0; mascara < 8; mascara++) {
    aplicaMascara(mascara);
    formato(mascara);
    const pen = penalidade(m, n);
    if (pen < menor) {
      menor = pen;
      melhor = mascara;
    }
    aplicaMascara(mascara); // desfaz
  }
  aplicaMascara(melhor);
  formato(melhor);

  return m;
}

// ===== Componente =====
// Props: value (texto), size (px), bgColor, fgColor, margin (borda branca, em módulos)
export function QRCodeSVG({
  value,
  size = 128,
  bgColor = '#ffffff',
  fgColor = '#000000',
  margin = 4,
  ...resto
}) {
  const matriz = useMemo(() => gerarMatriz(String(value ?? '')), [value]);
  const n = matriz.length;
  const lado = n + margin * 2;

  let d = '';
  matriz.forEach((linha, y) => {
    linha.forEach((escuro, x) => {
      if (escuro) d += `M${x + margin},${y + margin}h1v1h-1z`;
    });
  });

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${lado} ${lado}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR Code"
      {...resto}
    >
      <rect width={lado} height={lado} fill={bgColor} />
      <path d={d} fill={fgColor} />
    </svg>
  );
}

export default QRCodeSVG;
