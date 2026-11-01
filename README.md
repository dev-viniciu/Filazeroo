# SENAI Fila Zero

Aplicação React/Vite para carteirinha digital, QR Code, cardápio e controle de retiradas usando Supabase.

## Configuração

1. Faça backup do banco Supabase.
2. No SQL Editor, execute **`database/migracao_supabase_existente.sql`**. Esse arquivo foi preparado para a estrutura existente: `alunos(id uuid,nome,email)`, `funcionarios(id uuid,nome,email,usuario,perfil)`, `cardapio(id,nome,descricao,imagem,disponivel)`, `estoque(cardapio_id,quantidade)` e `retiradas(aluno_id,cardapio_id,quantidade,retirado_em)`.
3. Configure `.env.local` usando `.env.example` com a URL e a chave pública anon/publishable do Supabase.
4. Execute `npm install` e `npm run dev`.

**Não execute o arquivo antigo `database/supabase_schema.sql` no banco existente.** Ele descreve outro formato de tabelas e poderia criar estruturas paralelas/incompatíveis. A migração nova não apaga o histórico de retiradas.

## Contas

- Aluno: a conta do Supabase Auth precisa ter o mesmo UUID de `alunos.id` e o mesmo e-mail de `alunos.email`. O aluno entra com e-mail e senha.
- Funcionário: a conta Auth precisa ter o mesmo UUID de `funcionarios.id`. O campo `usuario` continua sendo usado como nome de usuário e o e-mail de login é `usuario@funcionarios.filazero.com`.
- Os funcionários cadastrados como `admin` podem reiniciar o dia. Funcionários autorizados podem registrar retiradas, ajustar o saldo disponível e liberar repetição.

## Regra da retirada

- Cada aluno recebe uma primeira retirada por ciclo diário, independentemente do produto escolhido.
- O botão **LIBERAR REPETIÇÃO** só é habilitado depois que todos os alunos cadastrados tiverem recebido a primeira retirada.
- Depois da liberação, novas retiradas são permitidas enquanto houver saldo; o banco valida tudo na RPC para evitar saldo negativo e retiradas duplicadas na primeira rodada.
- O reinício diário restaura cada item para `quantidade_inicial`, zera `retiradas_no_dia` e fecha a repetição. O histórico não é apagado.

## Segurança e observações

- O frontend usa somente a chave pública anon/publishable. Nunca coloque `service_role` no site.
- A escrita de retiradas é feita pela função transacional `registrar_retirada`; a política de INSERT direto em `retiradas` é removida pela migração.
- As contas, permissões, políticas RLS e dados reais devem ser testados no próprio projeto Supabase após executar a migração. Não foi possível validar o banco remoto a partir deste ZIP.

## Correção para o estoque existente por nome

O banco informado nesta conversa usa `estoque.item` (texto), não `estoque.cardapio_id`.
O arquivo `database/correcao_estrutura_estoque_por_item.sql` adapta as funções RPC para essa estrutura.
Faça backup e execute esse SQL no Supabase antes de usar as funções de retirada e edição de estoque.
O frontend lê `cardapio.imagem_url` e associa as quantidades pelo nome do produto.


## Imagens do cardápio

Para associar as imagens aos seis itens já cadastrados no Supabase, abra o SQL Editor e execute `database/atualizar_imagens_cardapio.sql`. O script altera somente `cardapio.imagem_url`; não cria produtos nem altera o estoque. As imagens dos sucos são embalagens Vita Suco. As imagens do sanduíche e da esfirra são carregadas de endereços públicos da internet, então precisam de conexão para aparecer.


## Regra de entrega por aluno

O painel do funcionário agora separa a retirada em duas categorias: um item de lanche e um suco na primeira distribuição. Depois que a repetição é liberada, a interface permite mais uma retirada de cada categoria. O controle da tela usa o histórico retornado por `listar_retiradas_hoje` e o campo `tipo` (`primeira`/`repeticao`).

**Importante:** a regra também precisa ser aplicada dentro da função RPC `registrar_retirada` no Supabase para impedir que chamadas diretas ignorem a interface. A função SQL incluída em versões antigas deste projeto pressupõe colunas que não existem no banco atual informado (`cardapio_id`, `retirado_em`, `funcionario_id`); não execute essas migrações antigas no banco existente sem adaptar a função ao esquema real.

## Configuração das credenciais do Supabase

Crie um arquivo `.env.local` na raiz (ou configure as variáveis no painel da Vercel):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` (chave pública anon/publishable; nunca use `service_role` no navegador)

O login do aluno localiza o cadastro por `alunos.auth_user_id`, que é o vínculo correto entre `auth.users.id` e a tabela `alunos`.

**Atenção:** não execute automaticamente os SQLs antigos desta pasta no banco existente. A estrutura atual de `retiradas` e `funcionarios` foi informada como diferente da estrutura esperada por alguns desses scripts. As funções RPC precisam ser conferidas no Supabase antes de usar o fluxo de retirada/estoque.

## Corrigir senha de um funcionário (uso administrativo local)

O frontend não consegue descobrir nem alterar a senha atual do Supabase Auth. Se a senha cadastrada foi perdida, use o script administrativo abaixo para definir uma nova senha mantendo a mesma conta e o mesmo ID.

1. Copie `.env.admin.example` para `.env.admin.local`.
2. Preencha `FZ_SUPABASE_URL`, `FZ_SERVICE_ROLE_KEY`, `FZ_TARGET_EMAIL` e `FZ_NEW_PASSWORD`.
3. Execute `npm run admin:password` usando Node.js 20.6 ou superior.
4. Apague `.env.admin.local` depois do uso.

**Segurança:** a chave `service_role` tem poderes administrativos. Use somente no computador/dispositivo local, nunca em `src`, em variáveis `VITE_*`, no navegador, GitHub ou Vercel. Não envie esse arquivo a ninguém. O script só atualiza a senha da conta existente; não cria usuário nem muda seu ID/e-mail.
