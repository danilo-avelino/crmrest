import type { MessageType } from "@dishdesk/database/enums";
import {
  automationMessagesOf,
  businessHoursOf,
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

/** Tom do restaurante: a personalidade do atendimento (Configurações → Mensagens automáticas), com exemplos dela. */
export function toneOf(settings: unknown): string {
  const info = PERSONALITY_INFO[personalityOf(settings)];
  const messages = automationMessagesOf(settings);
  const examples = [messages.handoff, messages.orderFollowUp, messages.phoneConfirmation, messages.surveyThanks];
  return [
    `Personalidade do atendimento: ${info.label}. ${info.description}`,
    "Exemplos de mensagens do restaurante neste tom:",
    ...examples.map((example) => `- "${example}"`),
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
      const author =
        message.direction === "INBOUND" ? "Cliente" : `Restaurante (${message.sentByUserId ? "atendente" : content.aiReply ? "IA" : "automação"})`;
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
  if (hours.enabled) {
    const week = hours.days.map((day, index) => `${WEEKDAY_LABELS[index]}: ${day ? `${day.open} às ${day.close}` : "fechado"}`);
    lines.push(`Horário de funcionamento: ${week.join("; ")}`);
    lines.push(
      isOpenAt(hours, now)
        ? "Está aberto agora."
        : `Está fechado agora. Volta a atender ${reopeningAt(hours, now)}. A equipe só responde quando o restaurante abrir: ao passar para a equipe, avise o cliente disso e diga quando o restaurante volta a atender.`,
    );
  } else {
    lines.push("Horário de funcionamento: não informado.");
  }
  lines.push(
    links.length
      ? `Links para fazer pedido: ${links.map((link) => `${link.label}: ${link.url}`).join("; ")}`
      : "Links para fazer pedido: nenhum cadastrado.",
  );
  return lines.join("\n");
}
