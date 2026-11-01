-- SENAI Fila Zero: atualizar somente as imagens dos seis produtos já cadastrados.
-- Não cria produtos, não altera quantidades e não apaga histórico.

UPDATE public.cardapio
SET imagem_url = CASE lower(trim(nome))
  WHEN 'pão de queijo' THEN '/imagens/pao-de-queijo.jpg'
  WHEN 'sanduíche' THEN 'https://padariamercopan.com.br/wp-content/uploads/2024/10/Triangulo-Branco.jpg'
  WHEN 'salgado' THEN 'https://assets.instabuy.app.br/ib.item.image.large/l-1dc30354c82c4c01902cd75016b329a5.png'
  WHEN 'bolo' THEN '/imagens/bolo.jpg'
  WHEN 'suco de pêssego' THEN '/imagens/suco-pessego.jpg'
  WHEN 'suco de uva' THEN '/imagens/suco-uva.jpg'
  ELSE imagem_url
END
WHERE lower(trim(nome)) IN (
  'pão de queijo', 'sanduíche', 'salgado', 'bolo',
  'suco de pêssego', 'suco de uva'
);

NOTIFY pgrst, 'reload schema';
