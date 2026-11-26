import type { MessageType } from "@dishdesk/database/enums";
import {
  activeClosureAt,
  automationMessagesOf,
  businessHoursOf,
  closureLabel,
  dayHoursLabel,
  isOpenAt,
  type MessageContent,
  orderLinksOf,
  PERSONALITY_INFO,
  personalityOf,
  reopeningAt,
  WEEKDAY_LABELS,
} from "@dishdesk/shared";

/** Regras que valem para tudo o que a IA escreve ao cliente. */
export const WRITING_RULES = [
  "Escreva em português do Brasil, como numa conversa de WhatsApp: mensagens curtas, sem markdown, sem listas longas.",
  "Nunca peça CPF, senha, dados de cartão ou de pagamento.",
].join("\n");

/**
 * Para soar como uma pessoa, e não como robô, nas respostas que a própria IA escreve (padrões do skill humanizer, do
 * "Signs of AI writing" da Wikipedia). A revisão não usa: lá o conteúdo é do atendente e não pode mudar.
 */
export const REPLY_STYLE = [
  "Escreva como alguém da equipe digitando no WhatsApp, não como um robô:",
  '- A primeira frase já responde o que o cliente perguntou. Não repita o que ele disse ("Entendi que você quer saber...") nem anuncie a resposta ("Vamos lá!", "Claro! Vou te ajudar com isso").',
  "- Cada frase traz algo que o cliente ainda não sabe. Não explique de novo o que já está na conversa e não feche a mensagem repetindo o que você acabou de dizer.",
  '- Sem frases prontas de assistente: "Ótima pergunta", "Fico feliz em ajudar", "Espero ter ajudado", "Estou à disposição para qualquer dúvida", "Agradecemos o seu contato". Não termine toda mensagem com "Posso ajudar em algo mais?".',
  '- Sem contraste de efeito ("não é só X, é Y"), sem listar três coisas só para soar completo e sem exagero de propaganda ("irresistível", "experiência única").',
  "- Sem travessão (—): use vírgula, ponto ou dois-pontos.",
  "- Não comece duas respostas seguidas do mesmo jeito.",
].join("\n");

/** Tom do restaurante: a personalidade do atendimento (Configurações → Personalidade), com exemplos dela. */
export function toneOf(settings: unknown): string {
  const info = PERSONALITY_INFO[personalityOf(settings)];
  const messages = automationMessagesOf(settings);
  const examples = [messages.handoff, messages.orderFollowUp, messages.phoneConfirmation, messages.surveyThanks];
  return [
    `Personalidade do atendimento: ${info.label}. ${info.description}`,
    "Exemplos de mensagens automáticas do restaurante neste tom:",
    ...examples.map((example) => `- "${example}"`),
    // São textos de automação: copiados, deixam a IA com cara de robô.
    "Os exemplos mostram só o tom (o jeito de tratar o cliente, a formalidade, os emojis). Não copie as frases nem o formato deles.",
  ].join("\n");
}

const MEDIA_LABEL: Partial<Record<MessageType, string>> = {
  IMAGE: "[imagem]",
  AUDIO: "[áudio]",
  VIDEO: "[vídeo]",
  DOCUMENT: "[documento]",
  LOCATION: "[localização]",
  STICKER: "[figurinha]",
};

type TranscriptMessage = { direction: string; type: MessageType; content: unknown; sentByUserId: string | null; createdAt: Date };

const BRASILIA_CLOCK = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

/**
 * A conversa com o cliente, uma linha por mensagem, dizendo quem escreveu (eventos e notas internas ficam de fora).
 * `withTime`: cada linha começa com o horário (a avaliação considera a demora).
 */
export function transcript(messages: TranscriptMessage[], { withTime = false } = {}): string {
  return messages
    .flatMap((message) => {
      const content = message.content as MessageContent;
      const text = content.text ?? MEDIA_LABEL[message.type];
      if (!text || (message.direction !== "INBOUND" && message.direction !== "OUTBOUND")) return [];
      // Pelo celular da loja (fromPhone) também é uma pessoa da equipe. Sem marca nenhuma, a mensagem saiu pelo portal do
      // canal (o Gestor do iFood): é da loja, digitada ou automática dela. Como "automação", a IA não via que a equipe
      // já estava na conversa e respondia por cima dela.
      const sender = message.sentByUserId || content.fromPhone ? "atendente" : content.aiReply ? "IA" : content.automation ? "automação" : "loja";
      const author = message.direction === "INBOUND" ? "Cliente" : `Restaurante (${sender})`;
      return [`${withTime ? `[${BRASILIA_CLOCK.format(message.createdAt)}] ` : ""}${author}: ${text}`];
    })
    .join("\n");
}

const BRASILIA_NOW = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  weekday: "long",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Horário de funcionamento, se está aberto agora e os links para fazer pedido. */
export function restaurantFacts(name: string, settings: unknown, now: Date): string {
  const hours = businessHoursOf(settings);
  const links = orderLinksOf(settings);
  const lines = [`Restaurante: ${name}`, `Agora: ${BRASILIA_NOW.format(now)} (horário de Brasília)`];
  // Pausa da loja (feriado, falta de energia): vale mais que o horário da semana. 23/11/2026: sem energia das 18h às
  // 20h56, a IA disse "estamos abertos" a nove clientes que viam a loja fechada no iFood e no site.
  const closure = activeClosureAt(hours, now);
  if (hours.enabled) {
    const week = hours.days.map((day, index) => `${WEEKDAY_LABELS[index]}: ${dayHoursLabel(day)}`);
    lines.push(`Horário de funcionamento: ${week.join("; ")}`);
  } else {
    lines.push("Horário de funcionamento: não informado.");
  }
  if (closure) {
    const reopening = reopeningAt(hours, now);
    const back = reopening === "em breve" ? "Ainda não há previsão de volta: diga isso, sem inventar horário." : `Volta a atender ${reopening}.`;
    lines.push(
      `Está fechado agora: o atendimento da loja está pausado (motivo: ${closure.reason}). ${back} Diga ao cliente que a loja está fechada e o motivo; não diga que está aberto nem mande pedir pelos links até a volta.`,
    );
  } else if (hours.enabled) {
    const reopening = reopeningAt(hours, now);
    // Antes de abrir (ou no intervalo), "hoje estamos fechados" soa como se não fosse abrir no dia.
    const today = reopening.startsWith("hoje") ? ' Ele ainda abre hoje: ao falar disso, diga a que horas abre ("abrimos às..."), e não que hoje está fechado.' : "";
    lines.push(isOpenAt(hours, now) ? "Está aberto agora." : `Está fechado agora. Volta a atender ${reopening}.${today}`);
  }
  // Pausas que ainda vão começar (feriado na semana): o cliente pode perguntar se abre no dia.
  const upcoming = hours.closures.filter((item) => Date.parse(item.from) > now.getTime() && Date.parse(item.from) - now.getTime() < 14 * 24 * 60 * 60_000);
  if (upcoming.length) {
    lines.push(`Pausas programadas (fechado nesses períodos): ${upcoming.map((item) => `${closureLabel(item)} (${item.reason})`).join("; ")}`);
  }
  lines.push(
    links.length
      ? `Links para fazer pedido: ${links.map((link) => `${link.label}: ${link.url}`).join("; ")}`
      : "Links para fazer pedido: nenhum cadastrado.",
  );
  return lines.join("\n");
}
