# Prompt para o design: abas do Cardápio (painel do restaurante)

Prepare um HTML único com os boards das abas do **Cardápio** no painel do Dish Desk (desktop, 1440 × 900). Siga o sistema de design do arquivo `Dish Desk Design.html` (cores, tipografia, botões, badges e inputs) e as três regras dele: um número principal com o filtro dentro do bloco que ele altera; aviso colado no item a que se refere, com a ação ao lado; estado mostrado na forma e sempre confirmado por texto ou número.

## Padrão da navegação (obrigatório em todos os boards)

O Cardápio usa o mesmo padrão de **Configurações**:

1. **Barra de ícones à esquerda** (estreita, fixa, igual às outras telas): logo de barras no topo (três linhas no quadrado; não usar o monograma "D"), ícones de Inbox, Pedidos, Clientes, Avaliações, Campanhas, **Cardápio** (ativo) e Configurações; embaixo, o escudo e o avatar.
2. **Faixa lateral de 236 px** que abre ao lado da barra quando o ícone do Cardápio está ativo: fundo branco, borda direita `rule`, título "Cardápio" em Fraunces 700/21 px e, embaixo, o nome do restaurante (ou o seletor de restaurante, no painel master). As páginas ficam em grupos com rótulo em caixa alta, 10 px, `ink-3`, espaçado. Cada item tem ícone de 16 px e texto de 13 px. O item ativo tem a borda esquerda de 3 px em tomate, fundo `tomate-lt`, texto `ink` em peso 500 e ícone tomate. Os inativos ficam em `ink-2`, com hover em `paper`.
3. **Área da página** ao lado, sobre o fundo `paper`, com o conteúdo em cartões brancos. O cabeçalho da página tem o título em Fraunces e as ações à direita.

Grupos e itens da faixa (mostrar a faixa completa em todos os boards, com o item da página aceso):

- **Catálogo:** Itens e categorias · Complementos · Opções (nova) · Edição em planilha (nova)
- **Vendas:** Relatório de vendas (nova) · Funil de vendas · Carrinhos abandonados
- **Promoções:** Cupons (nova) · Vantagens por tag · Avisos no cardápio (nova)
- **Loja:** Cardápio e entrega · Áreas de entrega (nova) · Pagamentos do cardápio · Pedidos pela IA
- **Marketing:** Meta Ads

Hoje "Cardápio e entrega", "Pagamentos do cardápio", "Pedidos pela IA", "Vantagens por tag" e "Meta Ads" ficam em Configurações. Desenhe-os dentro desta faixa, para avaliarmos a mudança.

## Boards

As telas que já existem estão nos boards P1 a P8 e C1 a C4 de `docs/cardapio-ia/Cardápio digital com IA · Painel.html`. Para elas, mantenha o conteúdo e todas as funções e troque só a moldura pela faixa nova. As telas novas são as que seguem:

1. **Itens e categorias (P1 na moldura nova).** Sem o botão "Mais" no topo: ficam "Ver cardápio público", "Importar" e "Novo item".
2. **Opções.** Grade das opções (meias, tamanhos, bebidas, extras) com foto, nome, selo Ativo/Pausado e "Usado em N grupos", que mostra os grupos com a borda tracejada de tag. Formulário de opção com foto, nome, código, preço de custo, descrição e o interruptor de estoque. O preço de venda fica no grupo de complementos; deixar isso escrito no formulário.
3. **Edição em planilha.** Tabela do catálogo com seleção por linha, filtros (categoria, status, sem foto, sem descrição, sem custo) e edição direto na célula: status, preço, preço promocional, custo, destaque. Barra de ações em massa ao selecionar linhas (pausar, ativar, mudar categoria, ajustar preço em %). Mostrar uma linha alterada e ainda não salva, e o botão "Salvar alterações" com o número delas.
4. **Relatório de vendas.** Número principal: o faturamento do período, com o filtro de período dentro do bloco. Embaixo, a conta explícita: produtos + taxas de entrega − descontos = faturamento. Gráfico por hora comparando com o período anterior. Abas Categorias · Itens · Opções, com quantidade, faturamento, preço médio, custo e margem. Item sem custo mostra "sem custo" em vez de margem de 100%.
5. **Cupons.** Lista com situação (Disponível, Fora do horário, Expirado, Inativo), nome, código, desconto, validade, usos e valor descontado em R$. Formulário de cupom: nome, código (sem código = vale para todos; aplicação automática), tipo (R$, %, entrega grátis), validade, dias da semana, horário, tipo de pedido, quantidade, pedido mínimo, só novos clientes, um uso por cliente; em avançado, formas de pagamento, categorias e itens. Mostrar ao lado do formulário o resumo da regra em uma frase ("10% em pizzas, de seg a qui, das 18h às 20h, a partir de R$ 50").
6. **Avisos no cardápio.** Cartões com imagem, título e texto, e a disponibilidade (dias e horário). Prévia de como o aviso aparece no cardápio público.
7. **Áreas de entrega.** Mapa com a loja no centro, raios em círculos e áreas em polígono; à direita, a lista de áreas com taxa e prazo, e os modos Por bairro, Por raio e Por área desenhada. Estado de desenho com instruções curtas (círculo: clique e arraste; polígono: clique nos pontos e feche no primeiro).

Para cada tela nova, desenhe também o estado vazio, o carregamento e um erro com a ação ao lado. Todo botão que salva mostra "Carregando…" e fica desabilitado enquanto espera.

## Fora do escopo

Versão celular (o MVP é só desktop), PDV, KDS, caixa, impressão, mesas, fiado, estoque e fidelidade.
