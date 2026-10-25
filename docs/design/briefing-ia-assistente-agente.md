# Briefing de design: sugestão de resposta, assistente de configuração e agente da extensão

Pedido de três boards novos para o arquivo **Dish Desk Design.html**. Eles seguem o **Sistema de Design** que já está no arquivo: cores, tipografia, botões, inputs, badges e balões. Não criar estilos novos. Se uma peça não existir no sistema, desenhar a partir das que existem e marcar no board que ela é nova.

O produto é o **Dish Desk**, um CRM de atendimento para restaurantes. A equipe responde os clientes do WhatsApp, do Instagram e do iFood numa Inbox só. O painel é só para desktop: não desenhar versão mobile.

Logo: manter o ícone de barras (três linhas no quadrado), não o monograma "D".

Os textos abaixo são sugestões. O tom é o do resto do produto: frases curtas, em português, sem jargão técnico.

---

## Board 1 — Inbox · Composer · Sugerir com IA

### Contexto
O restaurante que tem o módulo **Atendimento com IA** já recebe três coisas: a IA atende o cliente, revisa a resposta do atendente antes do envio (balão com "ver original") e avalia cada atendimento. Agora o atendente também pode pedir à IA **uma sugestão de resposta** quando ainda não escreveu nada.

### Onde fica
No composer da Inbox (board "Inbox · Conversa ativa · Painel do cliente", área "Input área"), na barra de baixo, à esquerda do botão **Enviar**, junto do botão **Template** (quando ele aparece).

### Como funciona
1. O atendente clica em **Sugerir com IA**.
2. A IA lê a conversa e os dados do restaurante e devolve um texto em 1 a 3 segundos.
3. O texto entra no campo de mensagem. O atendente edita o que quiser e envia normalmente. Nada é enviado sozinho.
4. Ao enviar, a revisão por IA vale como para qualquer resposta.

### Estados a desenhar
| Estado | O que acontece |
|---|---|
| Disponível | Campo vazio, aba **Responder**, conversa com mensagem do cliente. Botão ativo. |
| Carregando | Botão com "Carregando…" e desabilitado (guard de duplo clique). O campo fica bloqueado enquanto espera. |
| Sugestão no campo | O texto sugerido aparece no campo. Precisa de um indicador discreto de que veio da IA (ex.: uma linha pequena acima do campo, "Sugestão da IA · revise antes de enviar") e de um jeito de **descartar** (limpa o campo). O indicador some quando o atendente edita ou envia. |
| Campo com texto | O atendente já escreveu algo: o botão fica desabilitado (a sugestão nunca apaga o que ele escreveu). |
| Sem mensagem do cliente | Conversa sem nenhuma mensagem do cliente para responder: botão desabilitado, com dica no hover. |
| Erro | A IA não respondeu ou inventou um dado (a sugestão é descartada): mensagem de erro curta abaixo do campo, como os outros erros do composer ("A IA não conseguiu sugerir uma resposta agora. Tente de novo."). |
| Nota interna | Na aba **Nota interna**, o botão não aparece. |
| Sem o módulo | Restaurante sem o Atendimento com IA: o botão não aparece. |

### Componentes reaproveitados
Botão `ghost` ou `outline` tamanho `sm` (o mesmo do Template), mensagem de erro do composer e o campo de mensagem atual.

---

## Board 2 — Configurações · Assistente de configuração (primeiro acesso)

### Contexto
Hoje um restaurante novo entra no Dish Desk e precisa descobrir sozinho o que configurar. O assistente leva o **administrador** passo a passo até **a primeira mensagem de um cliente chegar na Inbox**.

### Premissas (decididas para este board)
- O assistente **abre sozinho no primeiro login do administrador**. Enquanto não terminar, a tela inicial da Inbox mostra um aviso **"Termine a configuração"**, com o progresso e um botão para continuar.
- Só o administrador vê o assistente. Os atendentes não têm tour.
- Dá para **sair a qualquer momento e continuar depois** de onde parou. Em **Configurações** há uma entrada para reabrir o assistente, por exemplo para ligar uma integração que foi pulada.
- O assistente **não tem formulários próprios**: cada passo usa o mesmo conteúdo de Configurações → Integrações e das outras abas de Configurações (o modal do QR Code do WhatsApp, o login do Instagram, o código de vinculação do iFood, o campo da chave do Cardápio Web, o horário de funcionamento, a personalidade, os links para pedir, o convite de usuários).

### Estrutura
Tela cheia ou modal grande, com:
- **Progresso** (lista de passos à esquerda ou barra no topo) com o estado de cada passo: a fazer, atual, concluído, pulado, em andamento.
- **Área do passo atual**, com título, explicação curta, a ação e os botões **Voltar**, **Pular** e **Continuar**.
- **Sair e continuar depois**, sempre visível.

### Passos, nesta ordem
**Integrações.** Antes de cada uma, o assistente pergunta se o restaurante usa aquele sistema. "Sim" abre o passo a passo; "Não" ou "Agora não" pula para a próxima. Nenhuma é obrigatória.

1. **WhatsApp:** "Você atende pelo WhatsApp?" A conexão é por **QR Code**, como no WhatsApp Web: abrir o WhatsApp no celular → Aparelhos conectados → Conectar um aparelho → apontar para o QR Code. Mostra o QR Code ali mesmo e confirma quando o número conectar.
2. **Instagram:** "Você atende pelo Instagram?" Explica que a conta precisa ser **Profissional** e abre o login do Instagram.
3. **iFood:** "Você vende pelo iFood?" Conecta a loja pelo código de vinculação (o administrador cola o código no Portal do Parceiro iFood) e ensina a **instalar a extensão do Chrome** do Dish Desk, que leva o chat do iFood para a Inbox.
4. **Cardápio Web:** "Você vende pelo Cardápio Web?" Mostra onde gerar a chave no Portal do Cardápio Web (Configurações → Integrações → API) e o campo para colar.

**Depois das integrações:**

5. **Horário de funcionamento.**
6. **Personalidade do atendimento** e mensagens automáticas (Cordial, Formal, Jovial, Descontraído, Acolhedor, Direto).
7. **Links para fazer pedido.**
8. **Convidar os atendentes.**
9. **Pronto:** "Esperando a primeira mensagem". O assistente mostra que está aguardando e sugere mandar uma mensagem de teste de outro celular para o WhatsApp conectado. Quando ela chegar, a tela comemora e leva para a Inbox.

### Estados de cada passo de integração
| Estado | O que mostrar |
|---|---|
| Pergunta | "Você atende pelo WhatsApp?" com **Sim** / **Agora não**. |
| Passo a passo | Explicação curta em passos numerados + a ação (QR Code, login, código, campo da chave). |
| Conferindo | A conexão é conferida antes de avançar (a mesma conferência de Integrações). Indicador de carregamento. |
| Conectado | Confirmação em verde e o nome da conta ou da loja conectada. |
| Falhou | O que deu errado e **o que corrigir**, em tomate (ex.: "A chave não foi aceita pelo Cardápio Web. Gere uma nova no Portal e cole aqui."), com **Tentar de novo**. |
| Em andamento | Algo que depende de terceiros e demora (ex.: a autorização da loja no Portal do Parceiro iFood). O passo fica âmbar com "Em andamento" e o assistente segue para o próximo; o administrador é avisado quando sair. |
| Importar contatos | Logo depois de conectar um sistema que permite (hoje, o Cardápio Web): oferecer **importar a base de clientes**, com o número de contatos importados ao terminar. |

### Também desenhar
- O aviso **"Termine a configuração"** na tela inicial da Inbox (com o progresso, ex.: "3 de 9 passos").
- A entrada **"Assistente de configuração"** em Configurações, para reabrir.

---

## Board 3 — Extensão do Chrome · Agente de implantação e suporte

### Contexto
A extensão do Chrome do Dish Desk (que hoje só leva o chat do iFood para a Inbox) ganha uma **IA que controla o navegador** junto com o parceiro (o dono do restaurante). Ela faz duas coisas:
- **Implantação:** executa com ele o passo a passo do assistente de configuração (board 2), inclusive nos sites de fora do Dish Desk, onde não temos API: Portal do Parceiro iFood, Portal do Cardápio Web, Meta Business / Instagram.
- **Suporte:** tira dúvidas sobre o Dish Desk e investiga problemas (canal desconectado, mensagem que não chegou, configuração errada) na tela do parceiro.

A IA lê a página (a estrutura dos elementos, sem capturas de tela), clica, preenche e navega. Ela mostra cada ação que faz.

### Onde fica
No **painel lateral do Chrome** (side panel), à direita da página, com cerca de 360 a 400 px de largura. O painel fica aberto enquanto o parceiro navega entre as abas e os sites.

### Premissas (decididas para este board)
- É a **mesma extensão** do iFood ("Dish Desk"), que ganha o painel lateral.
- O parceiro precisa estar **logado no Dish Desk** no mesmo Chrome. Sem login, o painel mostra um estado "Entre no Dish Desk para começar", com um botão que abre o login.
- A IA só age numa **lista fechada de sites** (Dish Desk, Portal do Parceiro iFood, Portal do Cardápio Web, Meta Business e Instagram). Para abrir outro site, ela pede permissão.
- O **suporte humano** que recebe as transferências é a equipe do Dish Desk, numa Inbox própria. O parceiro conversa com essa pessoa no mesmo painel.

### Partes do painel
1. **Cabeçalho:** logo, o modo atual (**Implantação** ou **Suporte**), o estado da IA (trabalhando, esperando você, pausada) e os controles **Pausar** e **Parar**.
2. **Conversa com a IA:** balões no estilo da Inbox. Mensagens do parceiro (saída, ink) e da IA (entrada, branca). Campo para escrever no pé ("Peça em linguagem natural: conecta o meu WhatsApp…").
3. **Ações da IA na conversa:** cada ação aparece como uma linha compacta entre os balões, com ícone e estado: "Abrindo o Portal do Parceiro iFood", "Clicando em **Aplicativos**", "Preenchendo **Código de vinculação**". Estados: em andamento, feita, falhou.
4. **Progresso da implantação:** os mesmos passos do assistente (board 2) com o estado de cada um, recolhível no topo da conversa.

### Cartões especiais (estados a desenhar)
| Cartão | Quando aparece | Conteúdo |
|---|---|---|
| **Confirmar ação** | Antes de tudo o que não dá para desfazer ou que fala em nome do restaurante: aceitar termos, enviar documentos, publicar, pagar, apagar. | O que a IA vai fazer e onde ("Clicar em **Aceitar termos** no Portal do Parceiro iFood"), com **Confirmar** e **Não fazer**. A IA fica parada até a resposta. |
| **Sua vez** | Campos que a IA nunca preenche: senha, código de verificação (SMS, e-mail, autenticador) e dados de cartão. | "Digite a sua senha na página e clique em **Continuar** quando terminar." O campo é destacado na página. Botão **Pronto**. |
| **Permissão de site** | A IA quer abrir um site fora da lista. | O endereço, **Permitir** e **Não permitir**. |
| **Pausada** | O parceiro clicou em Pausar ou começou a usar a página. | "Pausada. Você está no controle." **Continuar**. |
| **A IA se perdeu** | A página mudou de layout ou a IA errou várias vezes seguidas. | O que ela tentava fazer, com **Tentar de novo** e **Falar com o suporte**. |
| **Passo concluído** | A integração foi conferida pelo Dish Desk (a mesma conferência de Configurações → Integrações). | Confirmação em verde e o próximo passo. |
| **Transferido para o suporte** | A IA não resolveu, o parceiro pediu, ou o assunto é cobrança ou conta. | "Chamamos alguém da equipe Dish Desk. Ela já recebeu o histórico da conversa e das ações." Depois, as mensagens da pessoa do suporte aparecem na mesma conversa, com o nome dela. Fora do horário do suporte: quando ele volta. |
| **Importar contatos** | Ao concluir uma integração que permite (hoje, o Cardápio Web). | Oferecer importar a base de clientes. |

### Indicador na página
Enquanto a IA age, a página precisa mostrar o que ela está fazendo: o elemento que ela vai clicar ou preencher ganha um **contorno** com um rótulo pequeno ("IA clicando"), e uma faixa fina no topo da página indica "O Dish Desk está controlando esta aba · Pausar". Desenhar esse contorno e essa faixa.

### Estados gerais do painel
- **Sem login** no Dish Desk.
- **Início:** boas-vindas, com duas entradas: **Configurar o Dish Desk** (implantação) e **Preciso de ajuda** (suporte), mais o campo livre.
- **Trabalhando**, **Esperando você**, **Pausada**, **Concluído**.
- **IA indisponível:** a IA do Dish Desk está fora do ar. Oferecer o suporte humano.

---

## O que entregar
Os três boards no **Dish Desk Design.html**, com os estados das tabelas acima, seguindo o Sistema de Design. Se algum fluxo daqui não fizer sentido na tela, ajustar o fluxo e anotar no board.
