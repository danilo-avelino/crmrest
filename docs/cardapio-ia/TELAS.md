# Cardápio digital com IA: telas para o Claude Design

Briefing para o Claude Design desenhar os boards que entram no `Dish Desk Design.html`. Nenhuma tela foi desenhada aqui.

## Regras gerais (valem para todas as telas)

- **Sistema de design:** Dish Desk (CLAUDE.md §8). Papel `#F7F4EF`, tinta `#1A1814`, tomate `#C4341A`, Fraunces nos títulos, Inter na interface, números em `tabular-nums` e botões de 36 px.
- **As três regras do design novo:**
  1. Um número principal, com o filtro dentro do bloco que ele altera.
  2. O aviso fica colado no item a que se refere, com a ação ao lado.
  3. O estado aparece na forma e sempre é confirmado por texto ou número.
- **Cardápio público (W):** é mobile-first, com 360 px de largura e abre no navegador interno do WhatsApp e do Instagram. Desenhar também a versão desktop de 1280 px, com a sacola lateral fixa. O cardápio usa a marca do **restaurante** (logo, capa e uma cor de destaque configurável). O Dish Desk aparece só no rodapé ("Feito com Dish Desk"). Os botões têm no mínimo 44 px de altura no celular.
- **Painel (P, C, I):** desktop, no padrão das telas atuais.
- **Todo botão novo** mostra o estado "Carregando…" e fica desabilitado no segundo clique (CLAUDE.md §6).
- **Estados obrigatórios** em toda tela com dados: carregando (skeleton), vazio (com a ação para sair dele), erro (em português, com "Tentar de novo") e sucesso.
- **Exemplo para os mockups:** pizzaria fictícia "Forno da Vila", com pizzas de um sabor, meio a meio, combo, bebidas (uma esgotada) e sobremesas.
- **Requisitos R1 a R16** (PLANO, seção 3): cada tela indica os que precisa cumprir.

---

## A. Cardápio público (cliente)

### W1. Topo da loja e cardápio
- **Conteúdo:**
  - capa e logo, nome e cidade;
  - status em forma e texto: "Aberto até 23h" (verde) ou "Fechado · Abre às 18h" com o botão "Agendar pedido";
  - "Mais informações", que abre W19;
  - faixa da entrega: "Entrega R$ 5 a R$ 12 · grátis acima de R$ 150 · 40–50 min" (R11);
  - "Destaques" primeiro e depois a categoria principal (R5).
- **Cards do item:** foto, nome, descrição de 2 linhas e preço. O preço aparece como "R$ 49,90" ou "a partir de R$ 34,90 (broto)". Os selos são Mais pedido, Novidade, Vegetariano e Picante. O item esgotado fica esmaecido com o selo "Esgotado", sem sair da lista.
- **Logado:** carrossel "Peça novamente" no topo, com o item já configurado e o "+" para adicionar.
- **Estados:** carregando, loja fechada, loja pausada ("Pausado agora, volte em instantes") e cardápio vazio.

### W2. Cabeçalho fixo, categorias e busca
- **Ao rolar:** o cabeçalho fica fixo com o logo, as abas de categoria (rolagem horizontal, com a categoria atual marcada) e a lupa.
- **Busca em tela cheia:** procura por nome, ingrediente e apelido. Estados: inicial (sugestões e mais pedidos), skeleton, resultados com o termo destacado e "nada encontrado" com o atalho "Ver cardápio completo" e "Pedir pelo WhatsApp".

### W3. Vitrine de promoções
- Bottom sheet no celular e modal no desktop. Abre no máximo 1 vez a cada 24 h, e o "Fechar" fica bem visível (R4).
- O preço cheio aparece riscado, com o selo "−10%". Não mostrar item esgotado.

### W4. Ficha do item simples (bebida)
- Foto, nome, volume e preço, com stepper de quantidade.
- O botão mostra o total: "Adicionar · R$ 14,00".
- A observação fica recolhida ("Adicionar observação"), porque é item simples.

### W5. Ficha da pizza (um sabor)
- **Grupos, cada um com o rótulo "Obrigatório" ou "Opcional · até 3":**
  - tamanho (broto, média, grande), com o preço de cada um e a quantidade de fatias e de pessoas;
  - borda;
  - adicionais;
  - upsell "Combina com": sobremesas (até 3) e bebidas (até 5), com foto e stepper.
- **Detalhes:** ingredientes, alérgenos e "Serve 2–3 pessoas".
- **Botão:** sem tamanho escolhido, fica desabilitado com "Escolha o tamanho" e nunca mostra R$ 0,00 (R6). Com tamanho, mostra "Adicionar · R$ 62,80" e muda a cada escolha.
- **Erro:** ao tentar avançar sem um grupo obrigatório, o grupo é destacado com a mensagem logo abaixo.
- **Desktop:** modal com a foto à esquerda e as opções à direita.

### W6. Ficha da pizza meio a meio
- Escolha das 2 metades com o contador "1 de 2" e "2 de 2", e a busca dentro da lista de sabores.
- Regra de preço escrita no modal (R7), por exemplo "O preço é o da metade mais cara" ou "a soma das metades". Cada sabor mostra o preço da sua metade.
- O total muda a cada escolha.
- **Variante "editar item da sacola":** o mesmo modal, com o botão "Atualizar · R$ X".
- **Combo:** grupos claros ("Escolha 3 cookies · o 4º é grátis") e sabor em falta marcado.

### W7. Sacola
- **Celular:** barra fixa embaixo ("2 itens · R$ 76,80 · Ver sacola") e a sacola em tela cheia.
- **Desktop:** coluna lateral sempre visível.
- **Itens:** cada item com as opções em linha, "Editar" (abre W5 ou W6 com "Atualizar"), "Remover" e stepper.
- **Carrossel "Peça também"** (bebida, sobremesa).
- **Frete grátis:** barra de progresso "Faltam R$ 23,20 para entrega grátis", com sugestões que completam o valor (R11).
- **Cupom:** o campo fica visível para todos, sem pedir telefone (R8). Estados: aplicado, inválido e abaixo do mínimo.
- **Totais:** subtotal, entrega ("a calcular", ou a faixa) e total.
- **Botão:** com a loja aberta, "Continuar". Com a loja fechada, "Agendar para as 18h" (R2), nunca um botão travado.
- **Estados:** sacola vazia e item que esgotou depois de entrar na sacola (aviso no item, com "Trocar" e "Remover").

### W8. Identificação com código (R1)
- Passo 1: telefone, com DDD e máscara, e a explicação "Enviamos um código pelo WhatsApp".
- Passo 2: 6 dígitos, com "Reenviar em 0:45", "Trocar número" e "Não recebi".
- Erros: código errado (tentativas restantes), muitas tentativas (espera) e envio falhou.
- Opção "Continuar sem salvar meus dados": checkout de visitante que não mostra endereços salvos.
- Checkbox de opt-in de marketing, desmarcado por padrão (regra 9 e LGPD).

### W9. Checkout · Entrega ou retirada
- Indicador de passos: Entrega, Pagamento e Revisão. Não há passo de fidelidade (R9).
- Dois cartões grandes, Entrega (taxa e prazo) e Retirada (endereço da loja e prazo), sem sobreposição (R13).
- **Quando:** "Agora (40–50 min)" ou "Agendar", que abre as faixas de horário de hoje e amanhã (R2). Com a loja fechada, só "Agendar".

### W10. Checkout · Endereço
- Endereços salvos no topo, com rótulos Casa e Trabalho (R10). Aparecem só depois do OTP.
- Novo endereço por CEP, por "Não sei meu CEP" (busca pela rua) ou pela localização atual.
- **Formulário:**
  - rua, número, complemento, bairro e cidade;
  - "Sem número" é uma opção;
  - o ponto de referência é **opcional**, com uma dica (R12).
- **Validação (R3):** em português, com todos os erros de uma vez, cada um embaixo do seu campo, mais um resumo no topo.
- Mapa para confirmar o pino, com "Editar".
- **Fora da área:** "Não entregamos nesse endereço", com as saídas "Retirar na loja" e "Falar com a loja".
- Taxa e prazo calculados aparecem logo abaixo.

### W11. Checkout · Pagamento
- **Pagar agora:** Pix com o selo "Mais usado", aprovado na hora.
- **Pagar na entrega, ou "na retirada" conforme o modo (R15):** dinheiro, cartão de crédito e cartão de débito.
- **Dinheiro:** "Precisa de troco?" (sim ou não) e "Troco para quanto?", com a validação de valor maior que o total.
- **Erro:** "Escolha uma forma de pagamento", colado no bloco.

### W12. Checkout · Revisão
- **Conteúdo:**
  - previsão ou horário agendado;
  - modo e endereço;
  - itens editáveis;
  - observação do pedido;
  - cupom;
  - subtotal, entrega, desconto e total;
  - forma de pagamento.
- **Botão:** "Fazer pedido · R$ 98,70". Com Pix, "Ir para o pagamento · R$ 98,70".
- **Erro de preço mudou:** "O preço da Calabresa mudou de R$ X para R$ Y", com "Aceitar" e "Voltar".

### W13. Erros do envio
- Loja fechou durante o checkout (com "Agendar"), item esgotou, falha de rede (com "Tentar de novo" sem duplicar o pedido).

### W14. Pagamento Pix (R14)
- QR grande, botão "Copiar código Pix" (com o estado "Copiado!"), valor e contador "Expira em 14:32".
- Passo a passo curto: "Abra o app do banco, Pix, Copia e cola".
- **Aguardando:** indicador "Esperando a confirmação do banco…". Ao confirmar, vai sozinho para W15.
- **Vencido:** "O Pix venceu", com "Gerar novo Pix", "Trocar forma de pagamento" e "Cancelar pedido".
- Aviso: "Não precisa enviar comprovante; a confirmação é automática".

### W15. Pedido confirmado e acompanhamento
- Número do pedido, previsão e timeline: recebido, pago, em preparo, saiu para entrega ou pronto para retirar, e entregue.
- "Falar com a loja" (WhatsApp), resumo do pedido e endereço.
- **Depois de entregue:** avaliação por estrelas, mais o pedido de permissão de notificação só aqui (R16).
- **Estado cancelado:** com o motivo.

### W16. Minha conta
- Pedidos (lista paginada, com "Pedir de novo" em cada card), endereços (rótulos, editar e excluir) e dados.
- Preferências de mensagens (opt-in e opt-out).
- "Sair", com confirmação curta (R16).

### W17. Pedidos sem estar identificado
- A explicação, mais o botão "Entrar com o código" (W8). Não pedir permissão de notificação.

### W18. Consentimento de cookies (LGPD)
- Faixa inferior, que não cobre o botão da sacola, com "Aceitar", "Recusar" e "Preferências".

### W19. Mais informações
- Sobre, horário da semana com o dia atual destacado, formas de pagamento, áreas de entrega e taxas, endereço com mapa, CNPJ e telefone.

### W20. Estados da loja indisponível
- Slug inexistente, cardápio desativado pelo restaurante e restaurante com assinatura suspensa (texto neutro, sem expor o motivo).

---

## B. Painel do restaurante: cardápio

### P1. Lista do cardápio
- **Número principal:** "84 itens · 3 esgotados", com o filtro dentro do bloco (Todos, Esgotados, Sem foto, Fora do horário).
- **Categorias:** ordenáveis por arrastar, com ligar e desligar.
- **Linha do item:** foto, nome, preço, tags e o interruptor "Disponível / Esgotado", que funciona com 1 clique.
- **Ações:** duplicar, editar e arquivar.
- **Avisos colados no item** ("Sem foto", "Sem ingredientes, a IA não responde sobre este item"), com a ação ao lado.
- **Barra:** "Novo item", "Importar" e "Ver cardápio público".
- **Estados:** cardápio vazio, com 3 caminhos: criar, importar CSV ou importar foto/PDF.

### P2. Item: edição
- **Abas ou seções:** Básico (nome, descrição, foto, preço, categoria), Tamanhos, Complementos, Disponibilidade e **Para a IA**.
- **Para a IA:** ingredientes, alérgenos, serve quantas pessoas, tags, apelidos ("calab", "pizza de linguiça"), observação para a IA ("sugerir borda recheada") e "Combina com" (itens).
- **Prévia:** como o item aparece no cardápio (W5), ao lado.
- **Upload de foto:** recorte, estados de envio e erro (tamanho ou formato).

### P3. Grupos de complementos
- Grupo com nome, obrigatório ou opcional, mínimo e máximo, opções com preço e esgotado por opção.
- Reaproveitar um grupo em vários itens ("Usado em 12 itens").
- **Meio a meio:** liga e desliga por categoria, com a regra de preço (maior, média, soma) e o texto que o cliente vai ver.

### P4. Disponibilidade e horários do item
- Dias da semana e faixas ("almoço só de seg a sex, 11h–15h"). O aviso aparece se o item nunca estiver disponível no horário da loja.

### P5. Importação
- **CSV:** baixar o modelo, enviar, e ver a tabela de revisão com os erros por linha e "Importar 80 de 84".
- **Foto/PDF por IA:** enviar, "lendo o cardápio…" (progresso), e a revisão lado a lado (imagem original e itens extraídos editáveis). Os campos de baixa confiança ficam marcados, com sugestão de correção ortográfica. Nada salva sem "Confirmar".

### P6. Funil de vendas
- **Número principal:** pedidos e faturamento do período, com o filtro de período dentro do bloco.
- **Funil:** visitou, viu item, adicionou à sacola, iniciou checkout, gerou Pix e pagou. Cada etapa mostra o número, a % e a queda ("onde o cliente parou").
- **Quebras:** canal (site e WhatsApp), origem (anúncio, campanha, orgânico, link direto, Instagram) e ticket médio.
- Um gráfico por série, no padrão de gráficos do Dish Desk.

### P7. Carrinhos e Pix abandonados
- **Lista:** cliente, itens, valor, etapa em que parou e há quanto tempo.
- **Ação:** "Mandar mensagem de recuperação", com o aviso colado quando a janela de 24 h passou (só por template).
- **Estados:** vazio, enviado e respondido.

### P8. Pedidos: o que muda na tela atual
- O pedido do cardápio próprio entra na lista de Pedidos com o canal "Cardápio Dish Desk". Os selos são "Pago via Pix", "Pagar na entrega: dinheiro, troco R$ 100" e "Agendado 19:30".
- **Detalhe:** itens com tamanho e meio a meio legíveis para a cozinha e a origem (site, WhatsApp pela IA, anúncio).
- **Pix vencido** não aparece como pedido. Aparece em P7.

---

## C. Configurações

### C1. Configurações → Cardápio e entrega
- Link público (copiar e QR para imprimir), ligar e desligar o cardápio, endereço da loja, retirada (sim ou não) e tempo de preparo.
- **Áreas de entrega:** por bairro (tabela bairro e taxa) ou por raio (mapa com anéis e taxa por anel). Inclui pedido mínimo, frete grátis a partir de e prazo.
- **Agendamento:** liga e desliga, antecedência mínima e intervalo das faixas.
- **Promoções da vitrine (W3):** quais itens e a frequência.

### C2. Configurações → Pagamentos do cardápio
- **Pix:** provedor, credenciais (campos mascarados depois de salvos) e "Testar conexão" com o resultado em texto. A validade do Pix fica em minutos.
- **Na entrega:** dinheiro, crédito e débito, cada um com liga e desliga.
- **Estados:** não configurado (aviso: "sem Pix, só pagamento na entrega"), conectado e erro de credencial.

### C3. Configurações → Integrações → Meta Ads
- Pixel ID, token da Conversions API (mascarado) e código de teste de eventos.
- **Saúde:** últimos eventos enviados, erros da CAPI e dedup (% de eventos com par navegador e servidor). Em cada linha de erro, o aviso fica colado e a ação ao lado.

### C4. Configurações → Atendimento com IA → Pedidos pela IA
- Liga e desliga a IA de pedidos, nome do atendente e regras da casa (texto livre, com o limite mostrado).
- "Sugerir complementos" (liga e desliga) e o teto por conversa.
- A personalidade usa a que já existe (link para Personalidade).
- **Simular conversa:** uma caixa de chat de teste contra o cardápio real, sem criar pedido.

---

## D. Inbox (atendimento)

### I1. Carrinho na conversa
- **No painel do cliente:** bloco "Carrinho pela IA", com os itens, o total, a etapa (montando, aguardando confirmação, aguardando Pix, pago) e o contador do Pix.
- **Ações:** "Assumir conversa" (a IA para) e "Devolver à IA".

### I2. Ações do agente na timeline
- **Eventos de sistema centralizados**, no estilo das notas de automação (âmbar): "IA adicionou 1 Pizza Calabresa G", "IA gerou Pix R$ 98,70", "Pagamento confirmado", "IA chamou a equipe: endereço fora da área".
- **Mensagens com opções numeradas,** como o cliente vê.

### I3. Áudio com transcrição
- Balão de áudio com o player e a transcrição embaixo.
- **Estados:** transcrevendo, falhou (com o texto "Pedimos para o cliente repetir") e áudio longo demais.

### I4. Mensagem do Pix no WhatsApp (referência para o texto, não é tela do app)
- Mostrar a sequência: o resumo com as opções "1 Confirmar · 2 Alterar · 3 Cancelar", a imagem do QR, a mensagem só com o código e a confirmação de pagamento. O texto varia pela personalidade.

---

## E. Plataforma (super admin)

### X1. Módulo Cardápio por restaurante
- O interruptor `MENU` na lista de restaurantes, como o módulo de IA, com o uso: itens, pedidos do mês e custo de IA e de transcrição.

---

## Ordem sugerida para desenhar

1. W1, W5, W6, W7 e W12 (o núcleo da compra).
2. W8 a W11 e W14 a W15 (checkout e Pix).
3. P1 a P3 e C1 a C2 (o restaurante consegue publicar).
4. I1 a I3 e C4 (o agente).
5. P5 a P8, C3, W16 a W20 e X1.
