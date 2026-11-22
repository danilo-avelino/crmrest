import { z } from "zod";

// ---------- Personalidade do atendimento ----------

/** Tom das mensagens automáticas, escolhido pelo restaurante em Configurações → Mensagens automáticas. */
export const PERSONALITIES = ["cordial", "formal", "jovial", "descontraido", "acolhedor", "direto"] as const;
export const Personality = z.enum(PERSONALITIES);
export type Personality = z.infer<typeof Personality>;

/** Restaurante que nunca escolheu: os textos de antes das personalidades. */
export const DEFAULT_PERSONALITY: Personality = "cordial";

export const PERSONALITY_INFO: Record<Personality, { label: string; description: string }> = {
  cordial: { label: "Cordial", description: "Simpático e educado, com poucos emojis. É o padrão." },
  formal: { label: "Formal", description: "Respeitoso e sem emojis. Combina com restaurantes clássicos e alta gastronomia." },
  jovial: { label: "Jovial", description: "Animado, com exclamações e emojis. Bom para hamburguerias, açaí e público jovem." },
  descontraido: { label: "Descontraído", description: "Informal, como um papo entre amigos: “e aí”, “beleza”, “fechou”." },
  acolhedor: { label: "Acolhedor", description: "Caloroso e carinhoso, como um restaurante de família." },
  direto: { label: "Direto", description: "Mensagens curtas e objetivas, sem emojis." },
};

/**
 * Todas as mensagens que as automações mandam ao cliente. Marcadores trocados na hora do envio: {nome} (primeiro nome),
 * {pedido} (número do pedido), {status}, {hora} (19:45), {tempo} ("13 minutos atrás"), {quantidade} e {retorno} ("amanhã às 11:00").
 * Uma mensagem automática nova entra aqui, com o texto de cada personalidade (regra do CLAUDE.md).
 */
export type AutomationMessages = {
  /** Saudação do menu; as opções 1, 2 e 3 entram no fim. {nome} */
  greeting: string;
  phoneRequest: string;
  phoneReminder: string;
  phoneConfirmation: string;
  /** Fora do horário, no lugar do menu. {retorno} */
  closedMessage: string;
  /** O menu passou o atendimento à equipe. */
  handoff: string;
  /** A IA precisa da equipe, mas não há atendente online (ou o restaurante está no 100% automático): a conversa espera um. */
  noAgentsOnline: string;
  /**
   * O restaurante fechou com o cliente esperando a equipe, sem resposta: a conversa vai para a equipe quando abrir, e
   * até lá a IA volta a atender. {retorno}
   */
  closedWhileWaiting: string;
  orderNumberRequest: string;
  /** Primeira linha do pedido achado; os itens e o total vêm logo abaixo. {pedido} {status} */
  orderFound: string;
  /** Depois dos itens; "1 - Sim" e "2 - Não" entram no fim. */
  orderFoundQuestion: string;
  orderConfirmed: string;
  /** Depois da confirmação do pedido (e do andamento dele). */
  orderFollowUp: string;
  /** {pedido} */
  orderNotFound: string;
  /** Antes dos links para fazer pedido. */
  orderLinks: string;
  /** A resposta é lida como nota de 1 a 5: o texto precisa pedir um número de 1 a 5. */
  surveyQuestion: string;
  surveyThanks: string;
  /** Convite para avaliar a loja no app do iFood, no chat do pedido, 10 minutos depois da entrega. {pedido} */
  reviewInvite: string;
  inactivityClose: string;
  /** Previsão de saída do pedido. {hora} */
  forecast: string;
  /** Previsão de saída do pedido atrasado, com o pedido de desculpas. {hora} */
  forecastLate: string;
  queueOne: string;
  /** {quantidade} */
  queueMany: string;
  /**
   * O restaurante não marca a saída nesta integração (ex.: Cardápio Web que vai de confirmado direto a concluído) e o
   * tempo normal de preparo já passou: o pedido provavelmente saiu, mas não há como confirmar.
   */
  forecastProbablyOut: string;
  /** O pedido já saiu, na resposta ao cliente. {hora} {tempo} */
  dispatched: string;
  /** Aviso na hora em que o pedido sai. {pedido} {hora} */
  dispatchNotice: string;
  /** Aviso na hora em que o pedido é entregue. {pedido} */
  deliveredNotice: string;
  /** A equipe cancelou o pedido pelo Dish Desk (prevenção de fraude). {pedido} */
  orderCanceled: string;
  /** Aviso na hora em que o pedido fica pronto (só no chat do iFood do pedido). {pedido} */
  readyNotice: string;
  /** Saudação do menu do entregador (cadastro com a tag Entregador); as opções 1 a 4 entram no fim. {nome} */
  courierGreeting: string;
  courierOrderNumberRequest: string;
  /** Para o cliente, no chat do iFood do pedido: o entregador avisou que chegou. */
  courierArrivalNotice: string;
  /** Para o entregador: o cliente foi avisado. {pedido} */
  courierArrivalConfirmed: string;
  /** Para o cliente, no chat do iFood do pedido: o entregador avisou que deixou o pedido na portaria. */
  courierFrontDeskNotice: string;
  /** Para o entregador: o cliente foi avisado da portaria. {pedido} */
  courierFrontDeskConfirmed: string;
  /** Número que não bate com nenhum pedido: o entregador pode mandar de novo (uma vez). {pedido} */
  courierOrderRetry: string;
  /** {pedido} */
  courierOrderNotFound: string;
  /** Pedido achado: pede ao entregador para contar o problema. {pedido} */
  courierProblemRequest: string;
  /** O entregador contou o problema: a equipe é chamada. */
  courierProblemForwarded: string;
  /** Resposta do entregador fora das opções: as opções 1 a 4 vêm logo abaixo. */
  courierNotUnderstood: string;
  /** O entregador mandou só o número e o pedido existe: as opções 1 a 4 vêm logo abaixo. {pedido} */
  courierOrderFound: string;
  /** Primeira resposta ao cliente que escreve no chat do iFood: a equipe já está sendo chamada. */
  ifoodHandoff: string;
  /** Vem logo depois de `ifoodHandoff`, quando o cadastro não tem telefone. */
  ifoodPhoneRequest: string;
  /** O cliente tocou em "Adicionar observação ao pedido" no chat do iFood, que não leva a observação: pergunta qual é (19/11/2026). */
  ifoodObservationAsk: string;
  /** Cardápio digital: introdução do resumo do pedido; os itens e o total vêm logo abaixo. {nome} */
  menuOrderSummary: string;
  /** Pede a confirmação do resumo; as opções 1, 2 e 3 vão no texto. */
  menuConfirmAsk: string;
  /** Pix gerado: o QR Code e o código vão em mensagens separadas. {total} {validade} (hora, ex.: 20:30) */
  menuPixSent: string;
  /** Logo depois do QR Code, antes do código sozinho em outra mensagem. */
  menuPixCodeFollowUp: string;
  /** Pagamento confirmado. {pedido} {hora} (previsão de saída) */
  menuPaymentConfirmed: string;
  /** O Pix venceu sem pagamento: oferece outro. */
  menuPixExpired: string;
  /** Loja fechada no cardápio, com a oferta de agendar. {retorno} */
  menuClosedScheduling: string;
  /** O endereço está fora da área de entrega. */
  menuOutOfArea: string;
  /** Não deu para entender o áudio. */
  menuAudioFailed: string;
  /** Item esgotado: pergunta se serve uma alternativa. {item} */
  menuItemSoldOut: string;
  /** Código de entrada no cardápio digital (OTP), pelo WhatsApp do restaurante. {codigo} {loja} */
  menuLoginCode: string;
  /** O agente de pedidos parou (teto de uso da conversa, falha da IA ou transferência sem texto): a equipe continua o pedido. */
  menuAgentHandoff: string;
  /** Recuperação de carrinho parado (F7-07): mandada pela equipe, só com a janela de 24 h do WhatsApp aberta. {nome}. */
  menuCartRecovery: string;
  /** Recuperação de cliente com tag negativa: oferece o presente sem dizer o motivo. {nome}, {presente}. */
  menuRecoveryOffer: string;
  /** Fecha a pergunta com opções numeradas do agente de pedidos (canais sem botões). */
  menuChoiceHint: string;
  /** Pedido do cardápio com pagamento na entrega ou na retirada, ao cliente com o código confirmado. {nome} {pedido} {quando} (previsão ou horário agendado, já com o ponto final) {pagamento} ("na entrega, em dinheiro") */
  menuOrderConfirmed: string;
};

export const PERSONALITY_MESSAGES: Record<Personality, AutomationMessages> = {
  cordial: {
    greeting: "Olá, {nome}! 👋 Em que podemos ajudar?",
    phoneRequest: "Para garantirmos seu atendimento caso a conversa caia, pode nos informar seu telefone com DDD?",
    phoneReminder: "Só lembrando: pode nos passar seu telefone com DDD? 😊",
    phoneConfirmation: "Obrigado! Já anotamos seu telefone.",
    closedMessage: "Olá! 👋 No momento estamos fechados. Voltamos a atender {retorno} e, assim que abrirmos, respondemos sua mensagem.",
    handoff: "Certo! Um atendente já vai falar com você.",
    noAgentsOnline: "No momento estamos sem atendentes online. Assim que um chegar, sua conversa será encaminhada para ele.",
    closedWhileWaiting: "Nosso horário de atendimento já terminou. Sua mensagem ficou registrada e a equipe responde {retorno}, assim que abrirmos.",
    orderNumberRequest: "Qual é o número do pedido? Ele aparece no aplicativo ou no comprovante.",
    orderFound: "Encontramos o pedido #{pedido} ({status}):",
    orderFoundQuestion: "É este o seu pedido?",
    orderConfirmed: "Pedido confirmado 👍",
    orderFollowUp: "Enquanto um atendente chega, já nos conte o problema ou a sua dúvida, assim agilizamos o atendimento.",
    orderNotFound: "Não encontramos o pedido #{pedido} entre os pedidos de hoje e de ontem. Um atendente já vai te ajudar.",
    orderLinks: "Você pode fazer seu pedido por aqui:",
    surveyQuestion: "Qual nota você dá para nosso atendimento? Digite de 1 a 5",
    surveyThanks: "Obrigado pela avaliação! 😊",
    reviewInvite: "Como foi o seu pedido #{pedido}? 😊 Se puder, deixe sua avaliação da loja aqui no app do iFood. Isso nos ajuda muito!",
    inactivityClose:
      "Encerramos esta conversa por falta de interação. Se precisar de algo, é só mandar uma mensagem que retomamos de onde paramos.",
    forecast: "⏱️ Previsão de saída do restaurante: por volta das {hora}.",
    forecastLate:
      "Pedimos desculpas pela demora! 🙏 Seu pedido está levando mais tempo que o normal.\nNova previsão de saída do restaurante: por volta das {hora}.",
    queueOne: "Há 1 pedido na sua frente na cozinha.",
    queueMany: "Há {quantidade} pedidos na sua frente na cozinha.",
    forecastProbablyOut: "Pelo tempo normal de preparo, seu pedido já deve ter saído para entrega ou está saindo agora. 🛵",
    dispatched: "🛵 Seu pedido já saiu para entrega às {hora} ({tempo}).",
    dispatchNotice: "🛵 Boa notícia! Seu pedido #{pedido} saiu para entrega às {hora}.",
    deliveredNotice: "✅ Seu pedido #{pedido} foi entregue! Bom apetite 😋",
    orderCanceled: "Olá, {nome}! Não conseguimos seguir com o seu pedido #{pedido} e ele foi cancelado. Qualquer dúvida, é só responder aqui.",
    readyNotice: "✅ Seu pedido #{pedido} ficou pronto!",
    courierGreeting: "Olá, {nome}! 👋 Como podemos ajudar na entrega?",
    courierOrderNumberRequest: "Qual é o número do pedido?",
    courierArrivalNotice: "O entregador nos avisou que está na sua porta! 🛵",
    courierArrivalConfirmed: "Pronto! Avisamos o cliente do pedido #{pedido} que você chegou.",
    courierFrontDeskNotice: "📦 O entregador deixou seu pedido na portaria! Bom apetite 😋",
    courierFrontDeskConfirmed: "Pronto! Avisamos o cliente do pedido #{pedido} que o pedido ficou na portaria.",
    courierOrderNotFound: "Não encontramos o pedido #{pedido}. Um atendente já vai falar com você.",
    courierOrderRetry: "Não encontramos o pedido #{pedido}. Pode conferir o número e mandar de novo?",
    courierProblemRequest: "Encontramos o pedido #{pedido}. O que aconteceu com ele?",
    courierProblemForwarded: "Certo! Já estamos encaminhando para um atendente.",
    courierNotUnderstood: "Não consigo te entender dessa forma. Responda apenas com um número. Se quiser falar com um atendente, responda 4.",
    courierOrderFound: "Encontramos o pedido #{pedido}! 👍 Como podemos ajudar?",
    ifoodHandoff: "Olá! 👋 Estamos chamando um atendente.",
    ifoodPhoneRequest:
      "Enquanto ele chega, pode nos enviar seu número de telefone com DDD? É comum a conversa do iFood encerrar e ficarmos sem ter como entrar em contato.",
    ifoodObservationAsk: "Claro! 😊 Qual observação você quer incluir no seu pedido? Pode escrever aqui que passamos para a equipe.",
    menuOrderSummary: "Aqui está o resumo do seu pedido, {nome}:",
    menuConfirmAsk: "Está tudo certo? Responda 1 Confirmar · 2 Alterar · 3 Cancelar",
    menuPixSent: "Pix gerado! 😊 Valor: {total}. Pague até as {validade}.",
    menuPixCodeFollowUp: "Se preferir, é só copiar o código abaixo e colar no app do seu banco.",
    menuPaymentConfirmed: "Pagamento confirmado! 🎉 Seu pedido #{pedido} já está sendo preparado e a previsão de saída é por volta das {hora}.",
    menuPixExpired: "O tempo do Pix acabou e o pagamento não foi identificado. Quer que a gente gere um novo? 😊",
    menuClosedScheduling: "No momento estamos fechados, mas você pode agendar seu pedido para quando abrirmos ({retorno}). Quer agendar?",
    menuOutOfArea: "Infelizmente ainda não entregamos nesse endereço. Se quiser, você pode retirar o pedido na loja ou nos enviar outro endereço.",
    menuAudioFailed: "Não conseguimos entender o seu áudio. Pode repetir ou escrever sua mensagem, por favor?",
    menuItemSoldOut: "Poxa, {item} acabou hoje. Posso sugerir uma alternativa parecida? 😊",
    menuLoginCode: "Olá! Seu código para entrar no cardápio de {loja} é {codigo}. Ele vale por 10 minutos. Se não foi você, é só ignorar esta mensagem.",
    menuAgentHandoff: "Vou chamar alguém da equipe para continuar seu pedido por aqui. Só um instante! 😊",
    menuCartRecovery: "Oi, {nome}! Seu pedido ficou na sacola por aqui. Quer que eu finalize para você? É só responder 😊",
    menuRecoveryOffer: "Oi, {nome}! Separamos um presente para o seu próximo pedido: {presente}. Já entra sozinho no cardápio quando você entrar com o seu número 😊",
    menuChoiceHint: "Responda com o número da opção.",
    menuOrderConfirmed: "Recebemos seu pedido #{pedido}, {nome}! 🎉 {quando} O pagamento é {pagamento}.",
  },
  formal: {
    greeting: "Olá, {nome}. Agradecemos o seu contato. Como podemos ajudar?",
    phoneRequest:
      "Para darmos continuidade ao seu atendimento caso a conversa seja interrompida, poderia, por gentileza, informar seu telefone com DDD?",
    phoneReminder: "Ainda não recebemos o seu telefone. Poderia, por gentileza, informá-lo com DDD?",
    phoneConfirmation: "Agradecemos. Seu telefone foi registrado com sucesso.",
    closedMessage:
      "Olá. No momento estamos fora do horário de atendimento. Retomaremos as atividades {retorno}, quando sua mensagem será respondida.",
    handoff: "Perfeitamente. Um de nossos atendentes dará continuidade ao seu atendimento em instantes.",
    noAgentsOnline: "No momento não há atendentes disponíveis. Assim que um de nossos atendentes estiver online, sua conversa será encaminhada a ele.",
    closedWhileWaiting: "Informamos que nosso horário de atendimento foi encerrado. Sua mensagem está registrada e será respondida pela equipe {retorno}, assim que reabrirmos.",
    orderNumberRequest: "Por gentileza, informe o número do pedido. Ele consta no aplicativo ou no comprovante.",
    orderFound: "Localizamos o pedido #{pedido} ({status}):",
    orderFoundQuestion: "Poderia confirmar se este é o seu pedido?",
    orderConfirmed: "Pedido confirmado.",
    orderFollowUp: "Enquanto um atendente assume a conversa, solicitamos que descreva o ocorrido ou a sua dúvida, para agilizarmos o atendimento.",
    orderNotFound:
      "Não localizamos o pedido #{pedido} entre os pedidos de hoje e de ontem. Um de nossos atendentes dará continuidade ao seu atendimento.",
    orderLinks: "Seu pedido pode ser realizado pelos canais abaixo:",
    surveyQuestion: "Gostaríamos de conhecer sua opinião: qual nota atribui ao nosso atendimento? Responda com um número de 1 a 5.",
    surveyThanks: "Agradecemos a sua avaliação.",
    reviewInvite: "Agradecemos a preferência. Caso possa, pedimos a gentileza de avaliar o pedido #{pedido} no aplicativo do iFood. Sua opinião é muito importante para nós.",
    inactivityClose:
      "Esta conversa foi encerrada por ausência de interação. Caso precise de algo, basta enviar uma nova mensagem e retomaremos o atendimento.",
    forecast: "Previsão de saída do restaurante: por volta das {hora}.",
    forecastLate:
      "Pedimos sinceras desculpas pela demora. Seu pedido está levando mais tempo que o habitual.\nNova previsão de saída do restaurante: por volta das {hora}.",
    queueOne: "Há 1 pedido à frente do seu na cozinha.",
    queueMany: "Há {quantidade} pedidos à frente do seu na cozinha.",
    forecastProbablyOut: "Pelo tempo habitual de preparo, seu pedido já deve ter saído para entrega ou está saindo neste momento.",
    dispatched: "Seu pedido saiu para entrega às {hora} ({tempo}).",
    dispatchNotice: "Informamos que o seu pedido #{pedido} saiu para entrega às {hora}.",
    deliveredNotice: "Seu pedido #{pedido} foi entregue. Agradecemos a preferência e desejamos uma ótima refeição.",
    orderCanceled: "Olá, {nome}. Informamos que não foi possível dar continuidade ao pedido #{pedido}, que foi cancelado. Em caso de dúvida, estamos à disposição por aqui.",
    readyNotice: "Informamos que o seu pedido #{pedido} está pronto.",
    courierGreeting: "Olá, {nome}. Como podemos auxiliar na entrega?",
    courierOrderNumberRequest: "Por gentileza, informe o número do pedido.",
    courierArrivalNotice: "Informamos que o entregador acaba de nos avisar que está à sua porta.",
    courierArrivalConfirmed: "O cliente do pedido #{pedido} foi avisado da sua chegada.",
    courierFrontDeskNotice: "Informamos que o entregador deixou o seu pedido na portaria.",
    courierFrontDeskConfirmed: "O cliente do pedido #{pedido} foi avisado de que o pedido ficou na portaria.",
    courierOrderNotFound: "Não localizamos o pedido #{pedido}. Um de nossos atendentes dará continuidade em instantes.",
    courierOrderRetry: "Não localizamos o pedido #{pedido}. Por gentileza, confira o número e envie novamente.",
    courierProblemRequest: "Localizamos o pedido #{pedido}. Por gentileza, descreva o que ocorreu.",
    courierProblemForwarded: "Agradecemos. O caso está sendo encaminhado a um atendente.",
    courierNotUnderstood: "Não foi possível compreender sua mensagem. Por gentileza, responda apenas com o número da opção. Para falar com um atendente, responda 4.",
    courierOrderFound: "Localizamos o pedido #{pedido}. Por gentileza, escolha uma das opções:",
    ifoodHandoff: "Olá. Estamos acionando um de nossos atendentes.",
    ifoodPhoneRequest:
      "Enquanto isso, poderia, por gentileza, informar seu telefone com DDD? É comum a conversa do iFood ser encerrada, o que nos impede de retomar o contato.",
    ifoodObservationAsk: "Certamente. Poderia nos informar qual observação deseja incluir em seu pedido? Assim que recebermos, encaminharemos à nossa equipe.",
    menuOrderSummary: "Segue o resumo do seu pedido, {nome}:",
    menuConfirmAsk: "O pedido está correto? Responda 1 Confirmar · 2 Alterar · 3 Cancelar",
    menuPixSent: "O Pix foi gerado no valor de {total}, com validade até as {validade}.",
    menuPixCodeFollowUp: "Caso prefira, copie o código a seguir e cole no aplicativo do seu banco.",
    menuPaymentConfirmed: "Pagamento confirmado. Seu pedido #{pedido} está em preparo, com previsão de saída por volta das {hora}.",
    menuPixExpired: "O prazo do Pix expirou e não identificamos o pagamento. Deseja que geremos um novo?",
    menuClosedScheduling: "No momento estamos fechados. Podemos agendar o seu pedido para quando reabrirmos ({retorno}). Deseja agendar?",
    menuOutOfArea: "Lamentamos, mas ainda não realizamos entregas nesse endereço. Poderá retirar o pedido em nossa loja ou nos informar outro endereço.",
    menuAudioFailed: "Não foi possível compreender o seu áudio. Poderia repeti-lo ou escrever a sua mensagem?",
    menuItemSoldOut: "Lamentamos, mas o item {item} está esgotado. Podemos sugerir uma alternativa semelhante?",
    menuLoginCode: "Prezado cliente, o seu código de acesso ao cardápio de {loja} é {codigo}. Ele é válido por 10 minutos. Caso não tenha solicitado, desconsidere esta mensagem.",
    menuAgentHandoff: "Um membro da nossa equipe dará continuidade ao seu pedido por aqui em instantes.",
    menuCartRecovery: "Olá, {nome}. Seu pedido ficou em aberto. Deseja que o finalizemos? Basta responder a esta mensagem.",
    menuRecoveryOffer: "Olá, {nome}. Reservamos uma cortesia para o seu próximo pedido: {presente}. Ela será aplicada automaticamente no cardápio ao entrar com o seu número.",
    menuChoiceHint: "Queira responder com o número da opção desejada.",
    menuOrderConfirmed: "Prezado(a) {nome}, recebemos o seu pedido #{pedido}. {quando} O pagamento será {pagamento}.",
  },
  jovial: {
    greeting: "Oiê, {nome}! 🤩 Que bom te ver por aqui! Como podemos te ajudar hoje?",
    phoneRequest: "Rapidinho: pode mandar seu telefone com DDD? 📱 Assim, se a conversa cair, a gente te encontra!",
    phoneReminder: "Ei, não esquece da gente! 😄 Manda seu telefone com DDD?",
    phoneConfirmation: "Oba, telefone anotado! 🙌 Valeu!",
    closedMessage: "Oiê! 🌙 A gente tá fechadinho agora, mas volta {retorno} e te responde assim que abrir, combinado? 😉",
    handoff: "Show! 🙌 Já já um atendente vem falar com você!",
    noAgentsOnline: "Opa! Agora estamos sem atendentes online 😅 Assim que um chegar, sua conversa vai direto pra ele!",
    closedWhileWaiting: "Poxa, nosso horário de atendimento já acabou 😅 Mas sua mensagem tá guardadinha aqui e a equipe responde {retorno}, assim que a gente abrir!",
    orderNumberRequest: "Bora achar seu pedido! 🔎 Qual é o número dele? Tá no app ou no comprovante.",
    orderFound: "Achamos! 🎉 Pedido #{pedido} ({status}):",
    orderFoundQuestion: "É esse aqui o seu?",
    orderConfirmed: "Pedido confirmado! 🙌",
    orderFollowUp: "Enquanto um atendente chega, já conta pra gente o que rolou ou qual é a dúvida, assim tudo anda mais rápido! 🚀",
    orderNotFound: "Ihh, não achamos o pedido #{pedido} entre os de hoje e de ontem 😕 Mas relaxa: um atendente já vem te ajudar!",
    orderLinks: "Bora pedir? 😋 É só escolher por onde:",
    surveyQuestion: "Conta pra gente: que nota você dá pro nosso atendimento? ⭐ Manda um número de 1 a 5!",
    surveyThanks: "Valeu demais pela nota! 💛",
    reviewInvite: "E o pedido #{pedido}, como foi? 🎉 Conta pra gente avaliando a loja no app do iFood, ajuda demais! 💛",
    inactivityClose:
      "Parece que você saiu um pouquinho, então vamos encerrar por aqui 😉 Precisou de algo, é só chamar que a gente continua de onde parou!",
    forecast: "⏱️ Seu pedido deve sair daqui por volta das {hora}!",
    forecastLate: "Poxa, desculpa a demora! 🙏 Seu pedido tá levando um pouquinho mais que o normal.\nNova previsão de saída: por volta das {hora}!",
    queueOne: "Tem só 1 pedido na sua frente na cozinha! 🍳",
    queueMany: "Tem {quantidade} pedidos na sua frente na cozinha! 🍳",
    forecastProbablyOut: "Pelo tempo de preparo, seu pedido já deve estar a caminho ou saindo agorinha! 🛵",
    dispatched: "🛵 Seu pedido já tá a caminho! Saiu às {hora} ({tempo}).",
    dispatchNotice: "🛵 Oba! Seu pedido #{pedido} saiu para entrega às {hora}! Já já chega aí!",
    deliveredNotice: "🎉 Pedido #{pedido} entregue! Bom apetite! 😋",
    orderCanceled: "Oi, {nome}! Infelizmente não deu para seguir com o seu pedido #{pedido} e ele foi cancelado. Qualquer dúvida, é só chamar aqui!",
    readyNotice: "🎉 Oba! Seu pedido #{pedido} ficou prontinho!",
    courierGreeting: "Oiê, {nome}! 🛵 Como a gente pode te ajudar na entrega?",
    courierOrderNumberRequest: "Manda aí o número do pedido! 🔎",
    courierArrivalNotice: "Chegou! 🎉 O entregador avisou que já está na sua porta! 🛵",
    courierArrivalConfirmed: "Feito! 🙌 Já avisamos o cliente do pedido #{pedido} que você chegou!",
    courierFrontDeskNotice: "Chegou! 🎉 O entregador deixou seu pedido na portaria! Bom apetite! 😋",
    courierFrontDeskConfirmed: "Feito! 🙌 Já avisamos o cliente do pedido #{pedido} que o pedido ficou na portaria!",
    courierOrderNotFound: "Ihh, não achamos o pedido #{pedido} 😕 Mas relaxa: um atendente já vem falar com você!",
    courierOrderRetry: "Ihh, não achamos o pedido #{pedido} 😕 Confere o número e manda de novo!",
    courierProblemRequest: "Achamos o pedido #{pedido}! Conta pra gente: o que rolou com ele?",
    courierProblemForwarded: "Anotado! 🚀 Já estamos passando pra um atendente!",
    courierNotUnderstood: "Ops, assim não consegui te entender 😅 Responde só com o número, tá? Se quiser falar com alguém da equipe, manda 4.",
    courierOrderFound: "Achamos o pedido #{pedido}! 🎉 O que você precisa?",
    ifoodHandoff: "Oiê! 🤩 Já estamos chamando um atendente pra você!",
    ifoodPhoneRequest:
      "Enquanto ele chega, manda seu telefone com DDD? 📱 É que a conversa do iFood costuma encerrar e aí a gente fica sem ter como te chamar!",
    ifoodObservationAsk: "Bora! 🤩 Qual observação você quer colocar no pedido? Manda aqui que a gente já passa pra equipe!",
    menuOrderSummary: "Olha o resumo do seu pedido, {nome}! 😋",
    menuConfirmAsk: "Tá tudo certinho? Manda 1 Confirmar · 2 Alterar · 3 Cancelar",
    menuPixSent: "Pix gerado! 🚀 Valor: {total}. Paga até as {validade}!",
    menuPixCodeFollowUp: "Bora pagar? Copia o código aqui embaixo e cola no app do seu banco! 😉",
    menuPaymentConfirmed: "Pagamento confirmado! 🎉 Seu pedido #{pedido} já tá sendo preparado e deve sair por volta das {hora}!",
    menuPixExpired: "Eita, o Pix venceu e o pagamento não apareceu! 😅 Quer que eu gere outro?",
    menuClosedScheduling: "Agora a gente tá fechado, mas dá pra agendar seu pedido pra quando abrir ({retorno})! 🕒 Quer agendar?",
    menuOutOfArea: "Poxa, ainda não entregamos nesse endereço! 😕 Mas você pode retirar na loja ou mandar outro endereço!",
    menuAudioFailed: "Não consegui entender seu áudio! 🙈 Pode mandar de novo ou escrever pra mim?",
    menuItemSoldOut: "Ixi, {item} acabou! 😱 Quer que eu sugira uma opção parecida?",
    menuLoginCode: "Oi! 😄 Seu código pra entrar no cardápio de {loja} é {codigo}. Vale por 10 minutos! Se não foi você, pode ignorar.",
    menuAgentHandoff: "Vou chamar alguém da equipe pra continuar seu pedido aqui! Rapidinho! 🙌",
    menuCartRecovery: "Ei, {nome}! Teu pedido ficou na sacola! Bora finalizar? É só responder aqui 🙌",
    menuRecoveryOffer: "Ei, {nome}! Tem presente pra você no próximo pedido: {presente}! Entra no cardápio com teu número que já cai sozinho 🎉",
    menuChoiceHint: "Me responde com o número da opção! 😄",
    menuOrderConfirmed: "Oba, {nome}! Pedido #{pedido} recebido! 🎉 {quando} O pagamento é {pagamento}.",
  },
  descontraido: {
    greeting: "E aí, {nome}! Tudo certo? 😎 No que a gente pode te ajudar?",
    phoneRequest: "Passa seu telefone com DDD pra gente? Aí, se a conversa cair, a gente não te perde de vista 😉",
    phoneReminder: "Opa, só lembrando: manda aquele telefone com DDD? 😉",
    phoneConfirmation: "Fechou, telefone anotado! 👊",
    closedMessage: "Opa! Agora a gente tá fechado 😴 Mas relaxa: a gente volta {retorno} e te responde assim que abrir.",
    handoff: "Fechou! Já tem gente da equipe vindo falar com você 👊",
    noAgentsOnline: "Agora não tem ninguém da equipe online, mas fica tranquilo: assim que alguém chegar, sua conversa vai pra ele 👊",
    closedWhileWaiting: "Nosso horário de atendimento já acabou, mas relaxa: sua mensagem tá aqui e a equipe responde {retorno}, quando a gente abrir 👊",
    orderNumberRequest: "Qual o número do pedido? Dá pra ver no app ou no comprovante.",
    orderFound: "Achamos aqui! Pedido #{pedido} ({status}):",
    orderFoundQuestion: "É esse mesmo?",
    orderConfirmed: "Fechou, pedido confirmado 👍",
    orderFollowUp: "Enquanto alguém da equipe chega, já manda aí o que aconteceu ou qual é a dúvida, que adianta o lado 😉",
    orderNotFound: "Xi, não achamos o pedido #{pedido} entre os de hoje e de ontem. Mas sossega: alguém da equipe já vem te ajudar.",
    orderLinks: "Pra pedir é só ir por aqui:",
    surveyQuestion: "E aí, o que achou do atendimento? Manda uma nota de 1 a 5 👇",
    surveyThanks: "Valeu pela nota! 🤙",
    reviewInvite: "E aí, como foi o pedido #{pedido}? Se puder, dá uma moral e avalia a loja no app do iFood 🤙",
    inactivityClose: "Como a conversa deu uma parada, vamos fechar por aqui. Precisando, é só chamar que a gente continua de onde parou 🤙",
    forecast: "⏱️ Seu pedido sai daqui por volta das {hora}.",
    forecastLate: "Foi mal pela demora! 🙏 Seu pedido tá levando mais tempo que o normal.\nNova previsão de saída: por volta das {hora}.",
    queueOne: "Tem 1 pedido na sua frente na cozinha.",
    queueMany: "Tem {quantidade} pedidos na sua frente na cozinha.",
    forecastProbablyOut: "Pelo tempo de preparo, seu pedido já deve ter saído ou tá saindo agora. 🛵",
    dispatched: "🛵 Seu pedido já saiu, foi às {hora} ({tempo}).",
    dispatchNotice: "🛵 Opa! Seu pedido #{pedido} saiu pra entrega às {hora}.",
    deliveredNotice: "✅ Pedido #{pedido} entregue! Bom apetite 🤙",
    orderCanceled: "E aí, {nome}! Não rolou seguir com o seu pedido #{pedido}, então ele foi cancelado. Qualquer dúvida, só chamar aqui.",
    readyNotice: "✅ Opa! Seu pedido #{pedido} tá pronto.",
    courierGreeting: "E aí, {nome}! 😎 No que a gente te ajuda na entrega?",
    courierOrderNumberRequest: "Qual o número do pedido?",
    courierArrivalNotice: "Opa! O entregador avisou que tá aí na sua porta 🛵",
    courierArrivalConfirmed: "Fechou! Avisamos o cliente do pedido #{pedido} que você chegou 👊",
    courierFrontDeskNotice: "Opa! O entregador deixou seu pedido aí na portaria 📦 Bom apetite!",
    courierFrontDeskConfirmed: "Fechou! Avisamos o cliente do pedido #{pedido} que ficou na portaria 👊",
    courierOrderNotFound: "Xi, não achamos o pedido #{pedido}. Mas sossega: alguém da equipe já vem falar com você.",
    courierOrderRetry: "Xi, não achamos o pedido #{pedido}. Dá uma conferida no número e manda de novo?",
    courierProblemRequest: "Achamos o pedido #{pedido}. Manda aí: o que rolou com ele?",
    courierProblemForwarded: "Beleza! Já estamos passando pra alguém da equipe 👊",
    courierNotUnderstood: "Xi, assim não consigo te entender. Manda só o número 👇 Quer falar com o atendente? Manda 4.",
    courierOrderFound: "Achamos o pedido #{pedido} 👊 Qual vai ser?",
    ifoodHandoff: "E aí! Já estamos chamando alguém da equipe pra falar com você 😉",
    ifoodPhoneRequest: "Enquanto isso, passa seu telefone com DDD? A conversa do iFood costuma fechar e aí a gente fica sem ter como te achar.",
    ifoodObservationAsk: "Fechou! 😎 Qual observação você quer incluir no pedido? Manda aí que a gente passa pra equipe.",
    menuOrderSummary: "Dá uma olhada no resumo do pedido, {nome}:",
    menuConfirmAsk: "Tá beleza? Responde 1 Confirmar · 2 Alterar · 3 Cancelar",
    menuPixSent: "Pix gerado, {total}. Paga até as {validade}, beleza? 😎",
    menuPixCodeFollowUp: "Se quiser, copia o código aí embaixo e cola no app do banco.",
    menuPaymentConfirmed: "Fechou! Pagamento confirmado 🙌 O pedido #{pedido} já tá sendo feito e deve sair umas {hora}.",
    menuPixExpired: "E aí, o Pix venceu e o pagamento não caiu. Quer que eu gere outro?",
    menuClosedScheduling: "A gente tá fechado agora, mas dá pra agendar o pedido pra quando abrir ({retorno}). Bora agendar?",
    menuOutOfArea: "Putz, ainda não entregamos nesse endereço. Dá pra retirar na loja ou mandar outro endereço, tranquilo?",
    menuAudioFailed: "Não consegui entender o áudio. Manda de novo ou escreve aí, por favor?",
    menuItemSoldOut: "Putz, {item} acabou. Quer que eu sugira outra coisa parecida?",
    menuLoginCode: "E aí! Teu código pra entrar no cardápio de {loja} é {codigo}. Vale por 10 minutos. Não foi você? Só ignora 👍",
    menuAgentHandoff: "Vou chamar o pessoal da equipe pra seguir com teu pedido aqui, beleza? 👍",
    menuCartRecovery: "E aí, {nome}! Teu pedido ficou parado aqui. Quer fechar? Manda um oi que a gente resolve 👍",
    menuRecoveryOffer: "E aí, {nome}! Guardamos um mimo pro teu próximo pedido: {presente}. Entra no cardápio com teu número que ele aparece sozinho 😉",
    menuChoiceHint: "Manda o número da opção que você quer, beleza? 👍",
    menuOrderConfirmed: "Show, {nome}! Pedido #{pedido} na mão 🙌 {quando} Pagamento {pagamento}.",
  },
  acolhedor: {
    greeting: "Olá, {nome}! 🧡 Que alegria receber sua mensagem. Como podemos cuidar de você hoje?",
    phoneRequest: "Para não perdermos o contato caso a conversa caia, pode nos deixar seu telefone com DDD? 🧡",
    phoneReminder: "Passando para lembrar com carinho: pode nos deixar seu telefone com DDD? 🧡",
    phoneConfirmation: "Muito obrigado! Seu telefone já está guardadinho com a gente.",
    closedMessage:
      "Olá! 🧡 Agora estamos fechados, descansando para te receber da melhor forma. Voltamos {retorno} e respondemos sua mensagem com todo carinho.",
    handoff: "Pode deixar! Alguém da nossa equipe já vem conversar com você 🧡",
    noAgentsOnline: "Neste momento nossa equipe não está online, mas não se preocupe: assim que alguém chegar, sua conversa será encaminhada com todo o carinho 🧡",
    closedWhileWaiting: "Nosso horário de atendimento já terminou, mas não se preocupe: sua mensagem está guardada com carinho e a equipe responde {retorno}, assim que abrirmos 🧡",
    orderNumberRequest: "Vamos encontrar seu pedido juntos! Qual é o número dele? Você encontra no aplicativo ou no comprovante.",
    orderFound: "Encontramos seu pedido #{pedido} ({status}):",
    orderFoundQuestion: "É este o seu pedido?",
    orderConfirmed: "Pedido confirmado 🧡",
    orderFollowUp:
      "Enquanto alguém da equipe chega, pode nos contar com calma o que aconteceu ou qual é a sua dúvida. Assim já adiantamos tudo para você.",
    orderNotFound:
      "Não encontramos o pedido #{pedido} entre os pedidos de hoje e de ontem, mas não se preocupe: alguém da nossa equipe já vem te ajudar 🧡",
    orderLinks: "Que bom que você vai pedir com a gente! 🧡 É só escolher por onde:",
    surveyQuestion: "Sua opinião é muito importante para nós 🧡 Que nota você dá para o nosso atendimento? Digite de 1 a 5",
    surveyThanks: "Muito obrigado pelo carinho e pela avaliação! 🧡",
    reviewInvite: "Como foi o seu pedido #{pedido}? 🧡 Se puder, conte para nós avaliando a loja no app do iFood. Sua opinião é muito especial por aqui.",
    inactivityClose:
      "Como não tivemos mais notícias, vamos encerrar esta conversa por enquanto. Sempre que precisar, é só mandar uma mensagem que retomamos de onde paramos 🧡",
    forecast: "⏱️ Seu pedido está sendo preparado com carinho e deve sair do restaurante por volta das {hora}.",
    forecastLate:
      "Pedimos desculpas de coração pela demora 🙏 Seu pedido está levando mais tempo que o normal.\nNova previsão de saída do restaurante: por volta das {hora}.",
    queueOne: "Há 1 pedido na sua frente na cozinha.",
    queueMany: "Há {quantidade} pedidos na sua frente na cozinha.",
    forecastProbablyOut: "Pelo tempo de preparo, seu pedido já deve estar a caminho, quentinho, ou saindo agora mesmo. 🛵",
    dispatched: "🛵 Seu pedido já está a caminho! Saiu às {hora} ({tempo}).",
    dispatchNotice: "🛵 Que notícia boa! Seu pedido #{pedido} saiu para entrega às {hora}.",
    deliveredNotice: "✅ Seu pedido #{pedido} foi entregue! Esperamos que você aproveite cada pedacinho 🧡",
    orderCanceled: "Oi, {nome}! Sentimos muito, mas não conseguimos seguir com o seu pedido #{pedido} e ele foi cancelado. Qualquer dúvida, estamos aqui para ajudar.",
    readyNotice: "✅ Seu pedido #{pedido} ficou pronto, feito com todo carinho 🧡",
    courierGreeting: "Olá, {nome}! 🧡 Como podemos te ajudar na entrega?",
    courierOrderNumberRequest: "Pode nos dizer o número do pedido?",
    courierArrivalNotice: "Que notícia boa! 🧡 O entregador nos avisou que já está na sua porta.",
    courierArrivalConfirmed: "Prontinho! Avisamos o cliente do pedido #{pedido} que você chegou. Obrigado pelo cuidado 🧡",
    courierFrontDeskNotice: "Seu pedido chegou! 🧡 O entregador deixou ele na portaria. Bom apetite!",
    courierFrontDeskConfirmed: "Prontinho! Avisamos o cliente do pedido #{pedido} que o pedido ficou na portaria. Obrigado pelo cuidado 🧡",
    courierOrderNotFound: "Não encontramos o pedido #{pedido}, mas não se preocupe: alguém da nossa equipe já vem falar com você 🧡",
    courierOrderRetry: "Não encontramos o pedido #{pedido}. Pode conferir o número com calma e nos mandar de novo? 🧡",
    courierProblemRequest: "Encontramos o pedido #{pedido}. Pode nos contar com calma o que aconteceu?",
    courierProblemForwarded: "Obrigado por avisar! Já estamos encaminhando para alguém da nossa equipe 🧡",
    courierNotUnderstood: "Desculpe, não consigo te entender dessa forma 🧡 Pode responder apenas com um número? Se quiser falar com um atendente, é só responder 4.",
    courierOrderFound: "Encontramos o pedido #{pedido} 🧡 Como podemos te ajudar com ele?",
    ifoodHandoff: "Olá! 🧡 Já estamos chamando alguém da nossa equipe para cuidar de você.",
    ifoodPhoneRequest:
      "Enquanto isso, pode nos deixar seu telefone com DDD? É comum a conversa do iFood encerrar, e não queremos perder o contato com você.",
    ifoodObservationAsk: "Com todo o prazer! 🧡 Qual observação você gostaria de incluir no seu pedido? Pode escrever aqui, que levamos para a nossa equipe com carinho.",
    menuOrderSummary: "Preparamos o resumo do seu pedido com carinho, {nome}:",
    menuConfirmAsk: "Está tudo certinho para você? Responda 1 Confirmar · 2 Alterar · 3 Cancelar 🧡",
    menuPixSent: "Geramos o seu Pix, no valor de {total}. Ele vale até as {validade}. 🧡",
    menuPixCodeFollowUp: "Se for mais fácil, copie o código abaixo e cole no aplicativo do seu banco.",
    menuPaymentConfirmed: "Pagamento confirmado, muito obrigado! 🧡 Seu pedido #{pedido} já está sendo preparado com todo o cuidado e deve sair por volta das {hora}.",
    menuPixExpired: "O tempo do Pix acabou e não recebemos o pagamento, mas não tem problema. Quer que a gente gere um novo para você? 🧡",
    menuClosedScheduling: "No momento estamos fechadinhos, mas teremos o maior prazer em agendar o seu pedido para quando abrirmos ({retorno}). Quer que a gente agende? 🧡",
    menuOutOfArea: "Que pena, ainda não conseguimos entregar nesse endereço. 😔 Você pode retirar o pedido aqui na loja ou nos mandar outro endereço, será um prazer atender.",
    menuAudioFailed: "Não conseguimos ouvir bem o seu áudio. Poderia repetir ou escrever para nós, por favor? 🧡",
    menuItemSoldOut: "Que pena, o {item} acabou hoje. 😔 Podemos sugerir algo parecido de que você vai gostar?",
    menuLoginCode: "Oi! Que bom te ver por aqui 🧡 Seu código para entrar no cardápio de {loja} é {codigo}. Ele vale por 10 minutos. Se não foi você, pode ignorar esta mensagem.",
    menuAgentHandoff: "Vou chamar alguém da nossa equipe para cuidar do seu pedido com carinho por aqui. Só um instante 🧡",
    menuCartRecovery: "Oi, {nome}! Vi que seu pedido ficou guardadinho aqui. Quer que eu finalize com carinho para você? É só responder 🧡",
    menuRecoveryOffer: "Oi, {nome}! Preparamos um carinho para o seu próximo pedido: {presente}. Ele entra sozinho no cardápio quando você entrar com o seu número 🧡",
    menuChoiceHint: "Pode me responder com o número da opção, tá bom? 🧡",
    menuOrderConfirmed: "Que alegria, {nome}! Recebemos seu pedido #{pedido} 🧡 {quando} O pagamento é {pagamento}.",
  },
  direto: {
    greeting: "Olá, {nome}. Como podemos ajudar?",
    phoneRequest: "Informe seu telefone com DDD, por favor.",
    phoneReminder: "Lembrete: informe seu telefone com DDD.",
    phoneConfirmation: "Telefone cadastrado.",
    closedMessage: "Estamos fechados no momento. Voltamos {retorno} e respondemos assim que abrirmos.",
    handoff: "Um atendente vai falar com você.",
    noAgentsOnline: "Sem atendentes online agora. Sua conversa vai para o primeiro que chegar.",
    closedWhileWaiting: "Horário de atendimento encerrado. A equipe responde sua mensagem {retorno}.",
    orderNumberRequest: "Qual é o número do pedido? Está no aplicativo ou no comprovante.",
    orderFound: "Pedido #{pedido} ({status}):",
    orderFoundQuestion: "É este o seu pedido?",
    orderConfirmed: "Pedido confirmado.",
    orderFollowUp: "Enquanto o atendente não chega, descreva o problema ou a dúvida.",
    orderNotFound: "Pedido #{pedido} não encontrado entre os de hoje e de ontem. Um atendente vai te ajudar.",
    orderLinks: "Faça seu pedido por aqui:",
    surveyQuestion: "Avalie nosso atendimento de 1 a 5.",
    surveyThanks: "Obrigado pela avaliação.",
    reviewInvite: "Avalie o pedido #{pedido} no app do iFood. Sua avaliação nos ajuda.",
    inactivityClose: "Conversa encerrada por falta de interação. Mande uma mensagem se precisar de algo.",
    forecast: "Previsão de saída: por volta das {hora}.",
    forecastLate: "Desculpe a demora. Nova previsão de saída: por volta das {hora}.",
    queueOne: "1 pedido na sua frente.",
    queueMany: "{quantidade} pedidos na sua frente.",
    forecastProbablyOut: "Pelo tempo normal de preparo, o pedido já deve ter saído ou está saindo agora.",
    dispatched: "Seu pedido saiu para entrega às {hora} ({tempo}).",
    dispatchNotice: "Pedido #{pedido} saiu para entrega às {hora}.",
    deliveredNotice: "Pedido #{pedido} entregue. Bom apetite.",
    orderCanceled: "Olá, {nome}. Pedido #{pedido} cancelado. Dúvidas, responda aqui.",
    readyNotice: "Pedido #{pedido} pronto.",
    courierGreeting: "Olá, {nome}. Como podemos ajudar?",
    courierOrderNumberRequest: "Qual é o número do pedido?",
    courierArrivalNotice: "O entregador avisou que está na sua porta.",
    courierArrivalConfirmed: "Cliente do pedido #{pedido} avisado.",
    courierFrontDeskNotice: "O entregador deixou seu pedido na portaria.",
    courierFrontDeskConfirmed: "Cliente do pedido #{pedido} avisado da portaria.",
    courierOrderNotFound: "Pedido #{pedido} não encontrado. Um atendente vai falar com você.",
    courierOrderRetry: "Pedido #{pedido} não encontrado. Confira o número e envie de novo.",
    courierProblemRequest: "Pedido #{pedido} encontrado. O que aconteceu?",
    courierProblemForwarded: "Encaminhado a um atendente.",
    courierNotUnderstood: "Não entendi. Responda apenas com um número. Para falar com o atendente, responda 4.",
    courierOrderFound: "Pedido #{pedido} encontrado. Escolha uma opção:",
    ifoodHandoff: "Olá. Estamos chamando um atendente.",
    ifoodPhoneRequest: "Enquanto isso, informe seu telefone com DDD: a conversa do iFood costuma encerrar e ficamos sem contato.",
    ifoodObservationAsk: "Qual observação você quer incluir no pedido? Escreva aqui.",
    menuOrderSummary: "Resumo do pedido, {nome}:",
    menuConfirmAsk: "Confirma? 1 Confirmar · 2 Alterar · 3 Cancelar",
    menuPixSent: "Pix gerado. Valor: {total}. Validade: {validade}.",
    menuPixCodeFollowUp: "Ou copie o código abaixo.",
    menuPaymentConfirmed: "Pagamento confirmado. Pedido #{pedido}. Saída prevista: {hora}.",
    menuPixExpired: "O Pix venceu. Gerar um novo?",
    menuClosedScheduling: "Estamos fechados. Agendar o pedido para {retorno}?",
    menuOutOfArea: "Fora da área de entrega. Retirar na loja ou enviar outro endereço.",
    menuAudioFailed: "Áudio não compreendido. Repita ou escreva.",
    menuItemSoldOut: "{item} esgotado. Sugerir alternativa?",
    menuLoginCode: "Código de acesso ao cardápio de {loja}: {codigo}. Vale 10 minutos. Não pediu? Ignore.",
    menuAgentHandoff: "A equipe vai continuar seu pedido por aqui.",
    menuCartRecovery: "{nome}, seu pedido ficou em aberto. Responda para finalizar.",
    menuRecoveryOffer: "{nome}, seu próximo pedido tem {presente}. Entre no cardápio com o seu número.",
    menuChoiceHint: "Responda com o número.",
    menuOrderConfirmed: "Pedido #{pedido} recebido, {nome}. {quando} Pagamento {pagamento}.",
  },
};

/** A personalidade guardada em `tenant.settings` (sem escolha ou fora do formato: a padrão). */
export function personalityOf(settings: unknown): Personality {
  return z.looseObject({ personality: Personality.optional() }).safeParse(settings).data?.personality ?? DEFAULT_PERSONALITY;
}

/** Troca os marcadores ({pedido}, {hora}...) pelos valores; marcador sem valor fica como está. */
export function fillMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
