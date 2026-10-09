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
 * {pedido} (número do pedido), {status}, {hora} (19:45), {tempo} ("13 minutos atrás") e {quantidade}.
 * Uma mensagem automática nova entra aqui, com o texto de cada personalidade (regra do CLAUDE.md).
 */
export type AutomationMessages = {
  /** Saudação do menu; as opções 1, 2 e 3 entram no fim. {nome} */
  greeting: string;
  phoneRequest: string;
  phoneReminder: string;
  phoneConfirmation: string;
  /** Fora do horário, no lugar do menu. */
  closedMessage: string;
  /** O menu passou o atendimento à equipe. */
  handoff: string;
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
  inactivityClose: string;
  /** Previsão de saída do pedido. {hora} */
  forecast: string;
  /** Previsão de saída do pedido atrasado, com o pedido de desculpas. {hora} */
  forecastLate: string;
  queueOne: string;
  /** {quantidade} */
  queueMany: string;
  /** O pedido já saiu, na resposta ao cliente. {hora} {tempo} */
  dispatched: string;
  /** Aviso na hora em que o pedido sai. {pedido} {hora} */
  dispatchNotice: string;
  /** Aviso na hora em que o pedido é entregue. {pedido} */
  deliveredNotice: string;
};

export const PERSONALITY_MESSAGES: Record<Personality, AutomationMessages> = {
  cordial: {
    greeting: "Olá, {nome}! 👋 Em que podemos ajudar?",
    phoneRequest: "Para garantirmos seu atendimento caso a conversa caia, pode nos informar seu telefone com DDD?",
    phoneReminder: "Só lembrando: pode nos passar seu telefone com DDD? 😊",
    phoneConfirmation: "Obrigado! Já anotamos seu telefone.",
    closedMessage: "Olá! 👋 No momento estamos fechados. Assim que abrirmos, respondemos sua mensagem.",
    handoff: "Certo! Um atendente já vai falar com você.",
    orderNumberRequest: "Qual é o número do pedido? Ele aparece no aplicativo ou no comprovante.",
    orderFound: "Encontramos o pedido #{pedido} ({status}):",
    orderFoundQuestion: "É este o seu pedido?",
    orderConfirmed: "Pedido confirmado 👍",
    orderFollowUp: "Enquanto um atendente chega, já nos conte o problema ou a sua dúvida, assim agilizamos o atendimento.",
    orderNotFound: "Não encontramos o pedido #{pedido} entre os pedidos de hoje e de ontem. Um atendente já vai te ajudar.",
    orderLinks: "Você pode fazer seu pedido por aqui:",
    surveyQuestion: "Qual nota você dá para nosso atendimento? Digite de 1 a 5",
    surveyThanks: "Obrigado pela avaliação! 😊",
    inactivityClose:
      "Encerramos esta conversa por falta de interação. Se precisar de algo, é só mandar uma mensagem que retomamos de onde paramos.",
    forecast: "⏱️ Previsão de saída do restaurante: por volta das {hora}.",
    forecastLate:
      "Pedimos desculpas pela demora! 🙏 Seu pedido está levando mais tempo que o normal.\nNova previsão de saída do restaurante: por volta das {hora}.",
    queueOne: "Há 1 pedido na sua frente na cozinha.",
    queueMany: "Há {quantidade} pedidos na sua frente na cozinha.",
    dispatched: "🛵 Seu pedido já saiu para entrega às {hora} ({tempo}).",
    dispatchNotice: "🛵 Boa notícia! Seu pedido #{pedido} saiu para entrega às {hora}.",
    deliveredNotice: "✅ Seu pedido #{pedido} foi entregue! Bom apetite 😋",
  },
  formal: {
    greeting: "Olá, {nome}. Agradecemos o seu contato. Como podemos ajudar?",
    phoneRequest:
      "Para darmos continuidade ao seu atendimento caso a conversa seja interrompida, poderia, por gentileza, informar seu telefone com DDD?",
    phoneReminder: "Ainda não recebemos o seu telefone. Poderia, por gentileza, informá-lo com DDD?",
    phoneConfirmation: "Agradecemos. Seu telefone foi registrado com sucesso.",
    closedMessage: "Olá. No momento estamos fora do horário de atendimento. Sua mensagem será respondida assim que retomarmos as atividades.",
    handoff: "Perfeitamente. Um de nossos atendentes dará continuidade ao seu atendimento em instantes.",
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
    inactivityClose:
      "Esta conversa foi encerrada por ausência de interação. Caso precise de algo, basta enviar uma nova mensagem e retomaremos o atendimento.",
    forecast: "Previsão de saída do restaurante: por volta das {hora}.",
    forecastLate:
      "Pedimos sinceras desculpas pela demora. Seu pedido está levando mais tempo que o habitual.\nNova previsão de saída do restaurante: por volta das {hora}.",
    queueOne: "Há 1 pedido à frente do seu na cozinha.",
    queueMany: "Há {quantidade} pedidos à frente do seu na cozinha.",
    dispatched: "Seu pedido saiu para entrega às {hora} ({tempo}).",
    dispatchNotice: "Informamos que o seu pedido #{pedido} saiu para entrega às {hora}.",
    deliveredNotice: "Seu pedido #{pedido} foi entregue. Agradecemos a preferência e desejamos uma ótima refeição.",
  },
  jovial: {
    greeting: "Oiê, {nome}! 🤩 Que bom te ver por aqui! Como podemos te ajudar hoje?",
    phoneRequest: "Rapidinho: pode mandar seu telefone com DDD? 📱 Assim, se a conversa cair, a gente te encontra!",
    phoneReminder: "Ei, não esquece da gente! 😄 Manda seu telefone com DDD?",
    phoneConfirmation: "Oba, telefone anotado! 🙌 Valeu!",
    closedMessage: "Oiê! 🌙 A gente tá fechadinho agora, mas assim que abrir te respondemos, combinado? 😉",
    handoff: "Show! 🙌 Já já um atendente vem falar com você!",
    orderNumberRequest: "Bora achar seu pedido! 🔎 Qual é o número dele? Tá no app ou no comprovante.",
    orderFound: "Achamos! 🎉 Pedido #{pedido} ({status}):",
    orderFoundQuestion: "É esse aqui o seu?",
    orderConfirmed: "Pedido confirmado! 🙌",
    orderFollowUp: "Enquanto um atendente chega, já conta pra gente o que rolou ou qual é a dúvida, assim tudo anda mais rápido! 🚀",
    orderNotFound: "Ihh, não achamos o pedido #{pedido} entre os de hoje e de ontem 😕 Mas relaxa: um atendente já vem te ajudar!",
    orderLinks: "Bora pedir? 😋 É só escolher por onde:",
    surveyQuestion: "Conta pra gente: que nota você dá pro nosso atendimento? ⭐ Manda um número de 1 a 5!",
    surveyThanks: "Valeu demais pela nota! 💛",
    inactivityClose:
      "Parece que você saiu um pouquinho, então vamos encerrar por aqui 😉 Precisou de algo, é só chamar que a gente continua de onde parou!",
    forecast: "⏱️ Seu pedido deve sair daqui por volta das {hora}!",
    forecastLate: "Poxa, desculpa a demora! 🙏 Seu pedido tá levando um pouquinho mais que o normal.\nNova previsão de saída: por volta das {hora}!",
    queueOne: "Tem só 1 pedido na sua frente na cozinha! 🍳",
    queueMany: "Tem {quantidade} pedidos na sua frente na cozinha! 🍳",
    dispatched: "🛵 Seu pedido já tá a caminho! Saiu às {hora} ({tempo}).",
    dispatchNotice: "🛵 Oba! Seu pedido #{pedido} saiu para entrega às {hora}! Já já chega aí!",
    deliveredNotice: "🎉 Pedido #{pedido} entregue! Bom apetite! 😋",
  },
  descontraido: {
    greeting: "E aí, {nome}! Tudo certo? 😎 No que a gente pode te ajudar?",
    phoneRequest: "Passa seu telefone com DDD pra gente? Aí, se a conversa cair, a gente não te perde de vista 😉",
    phoneReminder: "Opa, só lembrando: manda aquele telefone com DDD? 😉",
    phoneConfirmation: "Fechou, telefone anotado! 👊",
    closedMessage: "Opa! Agora a gente tá fechado 😴 Mas relaxa: assim que abrir, a gente te responde.",
    handoff: "Fechou! Já tem gente da equipe vindo falar com você 👊",
    orderNumberRequest: "Qual o número do pedido? Dá pra ver no app ou no comprovante.",
    orderFound: "Achamos aqui! Pedido #{pedido} ({status}):",
    orderFoundQuestion: "É esse mesmo?",
    orderConfirmed: "Fechou, pedido confirmado 👍",
    orderFollowUp: "Enquanto alguém da equipe chega, já manda aí o que aconteceu ou qual é a dúvida, que adianta o lado 😉",
    orderNotFound: "Xi, não achamos o pedido #{pedido} entre os de hoje e de ontem. Mas sossega: alguém da equipe já vem te ajudar.",
    orderLinks: "Pra pedir é só ir por aqui:",
    surveyQuestion: "E aí, o que achou do atendimento? Manda uma nota de 1 a 5 👇",
    surveyThanks: "Valeu pela nota! 🤙",
    inactivityClose: "Como a conversa deu uma parada, vamos fechar por aqui. Precisando, é só chamar que a gente continua de onde parou 🤙",
    forecast: "⏱️ Seu pedido sai daqui por volta das {hora}.",
    forecastLate: "Foi mal pela demora! 🙏 Seu pedido tá levando mais tempo que o normal.\nNova previsão de saída: por volta das {hora}.",
    queueOne: "Tem 1 pedido na sua frente na cozinha.",
    queueMany: "Tem {quantidade} pedidos na sua frente na cozinha.",
    dispatched: "🛵 Seu pedido já saiu, foi às {hora} ({tempo}).",
    dispatchNotice: "🛵 Opa! Seu pedido #{pedido} saiu pra entrega às {hora}.",
    deliveredNotice: "✅ Pedido #{pedido} entregue! Bom apetite 🤙",
  },
  acolhedor: {
    greeting: "Olá, {nome}! 🧡 Que alegria receber sua mensagem. Como podemos cuidar de você hoje?",
    phoneRequest: "Para não perdermos o contato caso a conversa caia, pode nos deixar seu telefone com DDD? 🧡",
    phoneReminder: "Passando para lembrar com carinho: pode nos deixar seu telefone com DDD? 🧡",
    phoneConfirmation: "Muito obrigado! Seu telefone já está guardadinho com a gente.",
    closedMessage: "Olá! 🧡 Agora estamos fechados, descansando para te receber da melhor forma. Assim que abrirmos, respondemos sua mensagem com todo carinho.",
    handoff: "Pode deixar! Alguém da nossa equipe já vem conversar com você 🧡",
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
    inactivityClose:
      "Como não tivemos mais notícias, vamos encerrar esta conversa por enquanto. Sempre que precisar, é só mandar uma mensagem que retomamos de onde paramos 🧡",
    forecast: "⏱️ Seu pedido está sendo preparado com carinho e deve sair do restaurante por volta das {hora}.",
    forecastLate:
      "Pedimos desculpas de coração pela demora 🙏 Seu pedido está levando mais tempo que o normal.\nNova previsão de saída do restaurante: por volta das {hora}.",
    queueOne: "Há 1 pedido na sua frente na cozinha.",
    queueMany: "Há {quantidade} pedidos na sua frente na cozinha.",
    dispatched: "🛵 Seu pedido já está a caminho! Saiu às {hora} ({tempo}).",
    dispatchNotice: "🛵 Que notícia boa! Seu pedido #{pedido} saiu para entrega às {hora}.",
    deliveredNotice: "✅ Seu pedido #{pedido} foi entregue! Esperamos que você aproveite cada pedacinho 🧡",
  },
  direto: {
    greeting: "Olá, {nome}. Como podemos ajudar?",
    phoneRequest: "Informe seu telefone com DDD, por favor.",
    phoneReminder: "Lembrete: informe seu telefone com DDD.",
    phoneConfirmation: "Telefone cadastrado.",
    closedMessage: "Estamos fechados no momento. Respondemos assim que abrirmos.",
    handoff: "Um atendente vai falar com você.",
    orderNumberRequest: "Qual é o número do pedido? Está no aplicativo ou no comprovante.",
    orderFound: "Pedido #{pedido} ({status}):",
    orderFoundQuestion: "É este o seu pedido?",
    orderConfirmed: "Pedido confirmado.",
    orderFollowUp: "Enquanto o atendente não chega, descreva o problema ou a dúvida.",
    orderNotFound: "Pedido #{pedido} não encontrado entre os de hoje e de ontem. Um atendente vai te ajudar.",
    orderLinks: "Faça seu pedido por aqui:",
    surveyQuestion: "Avalie nosso atendimento de 1 a 5.",
    surveyThanks: "Obrigado pela avaliação.",
    inactivityClose: "Conversa encerrada por falta de interação. Mande uma mensagem se precisar de algo.",
    forecast: "Previsão de saída: por volta das {hora}.",
    forecastLate: "Desculpe a demora. Nova previsão de saída: por volta das {hora}.",
    queueOne: "1 pedido na sua frente.",
    queueMany: "{quantidade} pedidos na sua frente.",
    dispatched: "Seu pedido saiu para entrega às {hora} ({tempo}).",
    dispatchNotice: "Pedido #{pedido} saiu para entrega às {hora}.",
    deliveredNotice: "Pedido #{pedido} entregue. Bom apetite.",
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
