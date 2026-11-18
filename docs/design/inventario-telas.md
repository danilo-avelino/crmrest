# Inventário das telas para o design definitivo

Lista do que cada tela do app faz hoje. Serve de conferência: **uma tela só está pronta no design quando todos os itens dela têm lugar**, ou quando o usuário pediu para tirar um item.

Levantado em 18/11/2026 a partir de todos os componentes de `apps/web/components`, das páginas de `apps/web/app`, dos tipos de `packages/shared` e dos títulos do site. O levantamento usou os textos de tela, rótulos e comentários extraídos de cada componente, com leitura direta só de alguns trechos, e o app não foi aberto: conferir cada tela ao redesenhá-la. Marque `[x]` quando o item entrar no design.

## 1. Em todas as telas

- [ ] Barra lateral: início, Inbox, Pedidos, Clientes, Avaliações, Campanhas (ainda sem página), Configurações e Plataforma (só super admin)
- [ ] Atendente vê só a Inbox; as outras páginas são de administrador
- [ ] Menu da conta: trocar de restaurante, tema (claro, escuro, igual ao computador), sair, selo de painel master e de acesso de suporte
- [ ] Aviso de chamado fora da Inbox: bipe, contagem falada, número no título da aba, atalho "Abrir Inbox", "clique para ativar o som"
- [ ] Lembrete de liberação por confiança, com dias restantes e "Concluir pagamento"
- [ ] Seletor de restaurante no painel master, com "Todos os restaurantes" onde couber
- [ ] Páginas de erro e de endereço não encontrado
- [ ] Estados de carregando, erro com "Tentar de novo" e vazio em cada lista

## 2. Inbox

### Início (sem conversa aberta)
- [x] Hoje até agora: conversas abertas, resolvidas, sem a equipe, com a equipe, quem espera agora e há quanto tempo, tempo de resposta, nota do atendimento
- [x] Clique em "esperando" abre quem espera há mais tempo
- [x] Integrações por sistema: conectado, com erro, desconectado, não conectado, com Conectar, Reconectar e "Conectar nova integração"
- [x] Chat do iFood: extensão, autorização do widget, verificando, "Usar aqui" quando foi recusado neste computador
- [x] Atendimento com IA: IA + equipe, Fechado, 100% automático, clientes esperando, ligar e desligar
- [x] Aviso "Termine a configuração" com o anel de passos

### Faixas no topo
- [x] Canal desconectado (tomate) e token perto de vencer (âmbar), com Reconectar ou "Avise um administrador"
- [x] Dish Desk pausado, com "Retomar em Configurações"
- [x] Extensão do iFood faltando: Instalar e Recarregar
- [x] Sem conexão com o servidor: "Reconectando…"

### Lista de conversas
- [x] Abas Ativos, Automáticos e Resolvidos; filtros Todos, Abertos e Pendentes
- [x] Busca por nome, telefone ou CPF; filtro por restaurante; "Carregar mais"
- [x] Alarme "conversas chamando um atendente" com Abrir; faixa separada de "aguardando" sem urgência
- [x] Convite para ativar notificações e aviso para ativar o som
- [x] Linha: logo do canal, nome ou "Cliente sem nome", prévia, tempo, código do pedido, não lidas
- [x] Selos: Entregador chamando, Chamando atendente, Alerta de fraude, Pendente, Resolvida, Telefone pendente, Só a equipe
- [x] Cliente lido e sem resposta há 10 min ou mais: tempo em âmbar
- [x] "Última mensagem da equipe" na prévia

### Conversa
- [x] Cabeçalho: tempo aberta, responsável (atribuir, remover), Resolver, Reabrir, Marcar como pendente ou aberta
- [x] Resolver abre a conversa seguinte
- [x] Pergunta "Esta pessoa é um entregador?": Sim, Não é, Ver a conversa antes
- [x] Alerta de fraude no topo e aviso "O cliente não está nesta conversa"
- [x] Dia entre as mensagens; mensagens seguidas agrupadas; "novas mensagens" para quem lê acima
- [ ] Mensagens do cliente com foto; da equipe com autor, "pelo celular", IA, "revisada pela IA", "Encaminhada"
- [x] Status: enviando, ✓, ✓✓, falha com motivo e "Tentar novamente"
- [x] Mídia: imagem ampliável, figurinha, áudio, vídeo, documento, localização com "Abrir no mapa", arquivo expirado
- [x] Todas as automações, com o nome de cada uma; notas internas
- [x] Eventos de fraude, "Só a equipe vê"
- [x] Resposta bloqueada por má conduta
- [x] Avaliação da IA no ponto da conversa (só admin)
- [ ] Card do pedido: itens, valores, horários, "Enviar previsão", "Avisar saída" com confirmação, conversar com o cliente, "Sem contato pelo Dish Desk"
- [x] Encaminhar mensagem, com busca e motivos de bloqueio do destino

### Área de resposta
- [x] Responder e Nota interna; só nota quando o cliente não está ou o canal não permite resposta
- [x] Respostas rápidas pelo botão e por "/", com teclado
- [x] Sugerir com IA: escrevendo, "revise antes de enviar", Descartar, indisponível sem mensagem do cliente
- [x] Template do WhatsApp com variáveis
- [x] Janela de 24h: restante e encerrada
- [x] Intervalo entre respostas; dica de juntar tudo em uma mensagem; campo que cresce; Shift + Enter

### Painel Cliente
- [x] Nome abre o cadastro completo; editar nome e telefone
- [x] Telefone com origem, pendente ou não informado; Informar; botão WhatsApp
- [x] CPF mascarado com "Ver" registrado em auditoria
- [x] Tags automáticas com a regra ao passar o mouse; tags manuais e "+ tag"
- [x] Canais vinculados; endereço com "Copiar"
- [x] Histórico, cancelados, marcados como fraude, últimos pedidos

### Painel Pedidos e pedido atual
- [x] Pedido do cliente: itens, observações e barra de tempo com pronto, saída prevista e entrega prometida
- [x] "Sem atualização há mais de 4 h" e "Sem previsão de saída"
- [x] Pedidos de hoje em produção: Em produção, Atrasados, Prontos, Em rota, Entregues
- [x] Busca de pedido por número ou nome; "Cliente pediu cancelamento"; "Abrir Pedidos"
- [x] Modal do pedido com detalhes, ações e "Abrir conversa"

## 3. Pedidos

- [ ] Período: Hoje, 7 dias, 30 dias; filtros de Status e Origem; paginação
- [ ] Colunas: pedido, cliente, restaurante, feito em, preparo, saída, total, status, alerta
- [ ] Histórico na linha ("5 pedidos · 1 cancelado"), Retirada, "interação manual", atrasado, selo de fraude
- [ ] Linha expandida: itens com complementos, taxa, linha do tempo da plataforma, motivo do cancelamento
- [ ] Pagamento, troco, cupom e quem paga, código de coleta, CPF/CNPJ na nota, observações
- [ ] Ações do iFood com a trava ligada: Confirmar pedido, Marcar como pronto, Despachar, com "Enviado ao iFood" até atualizar
- [ ] Cancelar pedido; Abrir conversa
- [ ] Negociação do iFood: aceitar ou recusar, motivo, prazo e o que acontece sem resposta
- [ ] Modal de cancelamento: motivos do iFood ou texto opcional, marcar como fraude, prévia da mensagem, espera pela resposta
- [ ] Marcar como fraude e Remover marca em pedido cancelado

### Alerta de fraude
- [ ] Níveis alto (tomate) e "Atenção ao histórico" (âmbar, recolhido)
- [ ] Aberto, recolhido, decidido, aguardando a plataforma
- [ ] Resumo, análise da IA, itens do pedido, tabela de cancelamentos e "Ver todos"
- [ ] Bloco do endereço marcado, sem dados do outro cliente
- [ ] Selos Importado, Após a saída, Pela loja, Fraude
- [ ] Manter pedido, Cancelar pedido, ou onde cancelar quando o Dish Desk não pode
- [ ] "Pedido de outra unidade" e "Sem conversa"

## 4. Clientes

### Lista
- [ ] Números: Clientes, novos em 30 dias, VIPs, Recorrentes, Inativos, Chateados, Ticket médio, Telefone pendente, Aniversariantes
- [ ] Aviso de possíveis duplicados com Revisar (só admin)
- [ ] Busca por nome, telefone ou CPF; filtros Tag, Canal, Bairro (com busca), telefone pendente, último pedido cancelado, Último contato; Limpar
- [ ] Busca, filtros, ordem e página guardados no endereço
- [ ] Colunas: cliente, telefone, canais, bairro, pedidos, total gasto, cliente desde; ordenação
- [ ] Cliente anonimizado, sem nome, pendente, não informado
- [ ] Vazia, sem resultado, carregando, erro

### Detalhe
- [ ] Abre como página e como modal na Inbox
- [ ] Abrir conversa, Editar, Exportar dados, Anonimizar
- [ ] Aviso "pode ser a mesma pessoa" com Comparar
- [ ] Contato, e-mail, CPF, canais, endereços, observações, tags
- [ ] Modo edição com validação
- [ ] Métricas: pedidos, total gasto, cliente há, conversas
- [ ] Aba Conversas com a avaliação da IA; aba Pedidos com linha expandida
- [ ] Bloco Cancelamentos
- [ ] Perfil anonimizado

### Duplicados (só admin)
- [ ] Fila de pares com a chance segundo o Jev
- [ ] Comparação campo a campo: igual, será copiado, o que fica e o que sai
- [ ] Análise do Jev ou motivo do par
- [ ] Unir com confirmação, "Não são a mesma pessoa", próximo par
- [ ] Bloqueio por telefone ou CPF diferentes; fila vazia

### LGPD
- [ ] Exportar: gerar, baixar, aviso de auditoria
- [ ] Anonimizar: lista do que é apagado e confirmação digitando o nome

## 5. Avaliações

- [ ] Menu: Visão geral, Atendimentos, Equipe, Pesquisa, iFood; seletor de restaurante; período
- [ ] **Visão geral com IA:** nota, resolvidos, satisfeitos, nota dos clientes, explicação da nota
- [ ] **Visão geral sem IA:** nota dos clientes, 1ª resposta, passados à equipe, sem resposta
- [ ] Precisa da sua atenção: má conduta, notas baixas, insatisfeitos, em recuperação, sem resposta, "Nada pendente"
- [ ] Assuntos, O que deu errado, de quem foi a falha
- [ ] Quem resolveu, com os motivos da passagem; Fila sem atendente
- [ ] **Atendimentos:** filtros Todos, Notas baixas, Não resolvidos, Insatisfeitos, Risco de perder, por atendente; colunas nota, cliente, assunto, problema, atendente, resolvido, reação, risco, quando; aviso do módulo
- [ ] **Equipe:** números, tabela por atendente (nota da IA, nota dos clientes, respondidos, 1ª resposta, reescritas), última reescrita antes e depois, sem resposta, má conduta
- [ ] **Pesquisa:** média, distribuição, últimas respostas
- [ ] **iFood:** nota da loja, períodos de 7 a 90 dias, distribuição, mais citados, prazo das respostas, filtros, responder, privada, sem loja conectada, falha parcial

## 6. Configurações

- [ ] Menu em grupos: Personalidade, Horário, Links de pedido, Respostas rápidas, Integrações, Usuários, Notificações, Pagamento, Pausa; seletor de restaurante; entrada do assistente
- [ ] Aviso para quem não é administrador em cada página
- [ ] **Personalidade:** escolha, prévia das mensagens, "pedidos na frente", convite de avaliação no iFood
- [ ] **Horário:** ligar e desligar, vários horários por dia, virada de dia, Replicar, mensagem fora do horário
- [ ] **Links de pedido:** até 5, validação por linha
- [ ] **Respostas rápidas:** criar, editar, apagar, atalho
- [ ] **Integrações:** cartões por grupo, situação, catálogo com busca
- [ ] Modal de conta: detalhes, renomear, desconectar, excluir com confirmação, restaurantes atendidos, credencial pendente
- [ ] Conexões: QR Code do WhatsApp, login do Instagram, código de vinculação e escolha de lojas do iFood, chave do Cardápio Web, token da Neemo
- [ ] Importar histórico de pedidos com andamento; nota do iFood sem histórico
- [ ] **Usuários:** criar, perfil, convite, cancelar convite, desativar, reativar
- [ ] **Notificações:** números, má conduta, relatório semanal, relatório de teste
- [ ] **Pagamento:** situação, plano mensal, plano anual, trocar cartão, confirmação em andamento
- [ ] **Pausa:** pausar, retomar, o que para, todos os restaurantes

## 7. Acesso e assinatura

- [ ] Login: e-mail, senha, Google, erros do Google, "Esqueceu?", envio do link
- [ ] Redefinir ou criar senha, link expirado, convite
- [ ] Cadastro do teste grátis
- [ ] Escolha de restaurante: papel, conversas abertas, bloqueado, teste já usado, painel master, adicionar restaurante
- [ ] Modal de novo restaurante e restaurante de teste
- [ ] Bloqueio de assinatura nas quatro situações, planos, confirmação do pagamento, liberação por confiança, falar no WhatsApp

## 8. Assistente de configuração

- [ ] Abertura: usar o Chrome, instalar a extensão, "Configurar sem a extensão"
- [ ] Nove passos: horário, personalidade, links, equipe, WhatsApp, Instagram, iFood, Cardápio Web, primeira mensagem
- [ ] Estados do passo: feito, pulado, em andamento, com erro, aguardando o Portal do Parceiro
- [ ] Pergunta antes de cada integração; Voltar, Pular, Continuar; sair e continuar depois
- [ ] Final: esperando a primeira mensagem, comemoração, sem canal conectado

## 9. Extensão do Chrome

- [ ] Desconectado e sem permissão
- [ ] Início: Configurar, Preciso de ajuda, Fazer uma sugestão
- [ ] Estados: Trabalhando, Esperando você, Pausada, IA indisponível, Concluído
- [ ] Progresso da implantação, recolhido e aberto
- [ ] Ações da IA em andamento, feitas e com falha
- [ ] Cartões: confirmar ação, sua vez, login feito, abrir outro site, copiar código, próximo passo
- [ ] Pausar, Continuar, Parar; pausa quando o parceiro mexe na página
- [ ] Ticket ao suporte; sugestão; implantação concluída

## 10. Plataforma (super admin)

- [ ] **Restaurantes:** criar, adicionar usuário, lista com uso, suspender, reativar, entrar como suporte, plano, liberar acesso, módulos
- [ ] **Tickets** e **Sugestões** por assunto
- [ ] **Tráfego:** conclusões, visitantes, páginas, cadastros, origens, aparelhos, horas, páginas mais vistas
- [ ] **Gastos com IA:** mês, total, média, previsão, Claude × Jev, dia a dia, modelos, restaurantes, situação da IA
- [ ] **Defesa da API:** casos, análise do Jev, banir, desbanir
- [ ] **Auditoria**

## 11. Site

- [ ] Início, Funcionalidades, Extensão, Privacidade, Exclusão de dados

## 12. Correções no design atual

O design publicado em 18/11 mostra algumas coisas diferentes do app. Tratar no redesenho:

- [x] **Chamado de atendente:** falta o estado mais urgente da lista, com alarme e selo
- [x] **Andamento do pedido:** a barra de tempo atual, com saída prevista e entrega prometida, tem mais informação que a trilha de etapas. Combinar as duas
- [x] **Alerta de fraude:** faltam motivos por pedido, endereço marcado, análise da IA, nível baixo e recolher
- [x] **Cancelar pedido:** precisa do modal com motivo, marca de fraude e prévia da mensagem
- [ ] **Clientes:** os grupos substituíram números que existem hoje (Inativos, Chateados, Ticket médio, Telefone pendente, Aniversariantes)
- [ ] **Avaliações:** o bloco "Agora" e a atenção precisam cobrir os cinco pontos reais, e existe a versão sem IA
- [x] **Painel do cliente:** faltam CPF, endereço, edição e tags manuais

## 13. Novas aplicações das três regras

"Pronto" quer dizer que o dado já chega ao app. As ideias marcadas com ★ são as que eu faria primeiro.

### Um número principal, com o filtro no lugar certo

| Ideia | Onde | Dado |
|---|---|---|
| ★ **"Quem espera agora"** vira o número principal do início, com o tempo do mais antigo e o botão para abrir | Inbox, início | Pronto |
| ★ **Avaliações que vencem em menos de 24 h** lideram a página, com a nota da loja ao lado | Avaliações, iFood | Pronto |
| Total do mês em destaque, com o seletor de mês dentro dele; a previsão fica fora, porque não muda com o mês | Plataforma, Gastos com IA | Pronto |
| Funil visitantes → cadastros como bloco principal | Plataforma, Tráfego | Pronto |
| Situação e próxima data antes dos planos | Pagamento | Pronto |

### Aviso no item

| Ideia | Onde | Dado |
|---|---|---|
| ★ **Canal desconectado na própria conversa:** marca na linha e aviso na área de resposta, além da faixa do topo | Inbox | Pronto |
| ★ **Prazo da negociação do iFood na linha do pedido:** tempo restante e o que acontece sem resposta | Pedidos, painel da Inbox | Pronto |
| ★ **"Da última vez":** cliente que volta em recuperação abre com o resumo do atendimento ruim e o risco de perda | Painel do cliente | Pronto |
| Má conduta na linha do atendente | Avaliações, Equipe | Pronto |
| Token perto de vencer no cartão, com o tempo restante e Reconectar | Integrações | Pronto |
| Aniversário no painel durante a conversa | Painel do cliente | Falta a data no retorno da API |

### Reconhecer antes de ler

| Ideia | Onde | Dado |
|---|---|---|
| ★ **Quadro da cozinha:** colunas Em produção, Prontos, Em rota e Entregues, com atrasados em destaque | Pedidos, nova visão | Pronto |
| ★ **Marcas de cancelamento:** 9 marcas, 4 preenchidas, com texto "4 de 9" | Alerta de fraude, cadastro | Pronto |
| Janela de 24h como anel na área de resposta e na lista | Inbox | Pronto |
| Medidor do risco do Jev, sempre com a porcentagem | Alerta de fraude | Pronto |
| Quem responde agora (IA, equipe, chamando) como ícone na linha | Inbox | Pronto |
| Divisão dos pedidos por origem em uma barra | Painel do cliente | Pronto |
| Tempo de preparo comparado com o normal da casa | Pedidos | Falta a média na API |
| **Foto do prato** nos itens do pedido, a aplicação mais parecida com a do vídeo | Pedidos, card do pedido | Falta conferir se as plataformas entregam e guardar |
