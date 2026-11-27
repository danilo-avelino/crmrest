# Back office do Cardápio Web × Dish Desk

Fonte: auditoria do painel do gestor da Aglio Nero no Cardápio Web (PDF "Painel_Gestor_CardapioWeb_AglioNero", 25/11/2026). Análise feita em 26/11/2026 para decidir o que adaptar no Cardápio do Dish Desk. Nada aqui foi construído além da faixa lateral (item 1).

## 1. Navegação (feito em 26/11/2026)

O Cardápio Web organiza o catálogo em abas no topo (Produtos · Complementos · Opções) e o resto em itens do menu principal. No Dish Desk, o Cardápio passou a usar o padrão de Configurações: ícone na barra da esquerda e, ao lado, a faixa com as páginas em grupos.

- **Catálogo:** Itens e categorias (`/cardapio`, acende também na ficha do item e no Importar), Complementos.
- **Vendas:** Funil de vendas, Carrinhos abandonados.
- O "Mais" do topo saiu (a faixa leva às mesmas páginas). O "Importar" e o "Novo item" ficam no topo.
- **26/11/2026:** o grupo "Cardápio" de Configurações veio para a faixa (grupos Loja e Marketing), com as abas novas do `cardapio-backstage.html`. Ver TAREFAS.md.

## 2. O que já temos equivalente

| Cardápio Web | Dish Desk | Diferença que vale olhar |
| --- | --- | --- |
| Produto → Complemento → Opção | Item → grupo de complementos → opção, com "Usado em" | Lá a opção é entidade própria (foto, custo, código PDV, estoque) reaproveitada por vários grupos; aqui vive dentro do grupo. |
| Disponibilidade do produto (tipo de pedido, link, horário) | Aba Disponibilidade do item | Conferir se cobrimos os três eixos; lá a categoria e o complemento também têm disponibilidade própria. |
| Vitrine "A partir de" | Faixa de preço dos tamanhos ("R$ 34,90 (Broto) a R$ 56,90 (Grande)") | Lá o produto com preço R$ 0,00 assusta; manter a nossa regra de mostrar o preço efetivo. |
| Áreas de entrega (círculo/polígono no mapa) | Por bairro ou por raio (tabela) | Lá o desenho no mapa e o polígono com tempo próprio. |
| Pedido mínimo, entrega grátis, agendamento | Cardápio e entrega | Equivalente. |
| Horários por dia + datas personalizadas | Horário + fechamentos (store-closures) | Lá separa horário de delivery e de retirada. |
| Pix automático online | Pix Pagar.me | Lá mostra histórico de transações e repasses no painel. |
| Site Analytics (funil visita → sacola → checkout → pedido, tempo entre etapas) | Funil de vendas | Lá mostra o tempo entre etapas e novos × recorrentes. |
| Resgata (carrinho abandonado, app pago) | Carrinhos abandonados, nativo | Vantagem nossa. |
| Clientes com RFV, filtros e importar/exportar | Clientes com tags (VIP, Recorrente, Sumido…) e importação das integrações | Lá tem construtor de segmentos com contagem antes de salvar. |
| Avaliações (5 critérios, ocultar até 5%) | Avaliações | Lá decide se mostra a nota no cardápio público. |
| Chatbot por tom (inativo na loja) | IA de atendimento com personalidade + agente que fecha pedido | Vantagem nossa. |
| Notificações de status por WhatsApp | Automações por status, no tom da personalidade | Equivalente. |
| Cupons | Vantagens por tag (cupom ou presente) | Lá o cupom é genérico (código, R$/%/frete grátis, validade, dias, horário, mínimo, novos clientes, produtos/categorias). |
| Visão geral multi-loja | Seletor de restaurante no painel master | Lá há o consolidado das lojas da mesma conta. |

## 3. O que não temos (por prioridade sugerida)

Prioridade pelo encaixe com o que o Dish Desk vende (atendimento + cardápio com IA), não pelo tamanho do Cardápio Web.

**Alta (perto do cardápio que já existe)**

1. **Edição em planilha do catálogo** (status, preço, custo, descrição, foto e destaque por linha, com filtros). Lá é "Filtros avançados" + "Edição em massa". Útil quando o cardápio passa de dezenas de itens.
2. **Cupom genérico** além das vantagens por tag: código opcional, R$/%/entrega grátis, validade, dias e horário, mínimo, só novos clientes, uso único por cliente, produtos/categorias. Com o estado "Fora do horário" na lista e os usos em R$.
3. **Relatório de vendas por item e por opção** (quantidade, faturamento, preço médio) e faturamento do dia como conta explícita: produtos + taxas − descontos, comparado ao dia anterior hora a hora.
4. **Custo e margem do item** (preço de custo no item e na opção). Lá a margem de 100% com custo vazio confunde: mostrar "sem custo" em vez de 100%.
5. **Disponibilidade na categoria e no grupo de complementos** (por canal e horário), não só no item.

**Média**

6. **Áreas de entrega no mapa** (círculo e polígono com taxa e tempo).
7. **Avisos no cardápio** (imagem, título, texto e disponibilidade).
8. **Fidelidade** (pontos por real, recompensas, extrato com pendente → confirmado conforme o pedido).
9. **Segmentos salvos** de clientes com contagem antes de salvar, para usar em campanhas.
10. **Exibir a nota das avaliações no cardápio público**, com teto de avaliações ocultas.
11. **Numeração sequencial do pedido** configurável e finalização automática após 24 h.

**Fora do nosso foco agora (operação de loja / PDV)**

PDV interno, KDS, Caixa (sangria, suprimento), impressão térmica com setores, mesas e comandas, fiado, estoque e ficha técnica, financeiro, entregadores próprios. O Cardápio Web vende vários como módulos pagos; o Dish Desk integra com quem já faz isso (Cardápio Web, Neemo, iFood).

## 4. Cuidados que o próprio Cardápio Web mostra

- Rótulos de dinheiro sem ambiguidade: a tela de descontos deles mostra "Faturamento total R$ 0,00" no mesmo dia em que vendas mostra R$ 417,48. Nomear bruto, desconto e líquido.
- Tela vazia continua de pé (cancelamentos zerados ainda mostram o bloco e o motivo).
- Criar acesso de equipe pede código por e-mail antes; o 2FA fica no menu do usuário.
- Ao trocar um relatório de layout, manter o antigo com um aviso do caminho novo durante a migração.
