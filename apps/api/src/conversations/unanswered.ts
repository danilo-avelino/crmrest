import type { TenantTx } from "@dishdesk/database";
import type { ChannelType, MessageType } from "@dishdesk/database/enums";
import { BOT_TAG, type MessageContent, STAFF_TAG } from "@dishdesk/shared";
import { channelSends, isAcknowledgment, RATING_ANSWER } from "../automations/automation.js";
import type { Env } from "../config/env.js";

/** Mensagens recentes olhadas para achar as do cliente depois da última resposta. */
const LOOKBACK = 50;

const MEDIA_LABEL: Partial<Record<MessageType, string>> = {
  AUDIO: "[áudio]",
  IMAGE: "[foto]",
  VIDEO: "[vídeo]",
  DOCUMENT: "[arquivo]",
  LOCATION: "[localização]",
};

/** Mensagem do cliente que não pede resposta: só agradece ou se despede, figurinha, nota da pesquisa, tipo não exibido. */
function closesConversation(type: MessageType, content: MessageContent): boolean {
  if (type === "STICKER" || content.unsupported) return true;
  if (type !== "TEXT") return false;
  return isAcknowledgment(content.text) || RATING_ANSWER.test(content.text ?? "");
}

/**
 * A última mensagem do cliente (ou do entregador) que ficou sem nenhuma resposta depois dela: nem da equipe, nem da IA,
 * nem de automação. Resolver a conversa assim é má conduta (logs de 22–24/11/2026: "Alguém pode falar comigo, por
 * favor??" resolvida sem resposta). Não vale para encerramento ("ok", "obrigado", 👍, figurinha), para funcionário e bot,
 * para a conversa só da equipe nem para canal que não responde pelo Dish Desk. null = nada sem resposta.
 */
export async function unansweredMessage(
  tx: TenantTx,
  conversation: { id: string; contactId: string; teamOnly: boolean; channel: { type: ChannelType } },
  env: Pick<Env, "IFOOD_CHAT_BRIDGE">,
): Promise<string | null> {
  if (conversation.teamOnly || !channelSends(conversation.channel.type, env)) return null;
  const { tags } = await tx.contact.findUniqueOrThrow({ where: { id: conversation.contactId }, select: { tags: true } });
  if (tags.includes(STAFF_TAG) || tags.includes(BOT_TAG)) return null;
  // Pela ordem de entrada (id): a mensagem atrasada do WhatsApp chega com uma hora anterior.
  const recent = await tx.message.findMany({
    where: { conversationId: conversation.id, direction: { in: ["INBOUND", "OUTBOUND"] } },
    orderBy: { id: "desc" },
    take: LOOKBACK,
    select: { direction: true, type: true, content: true },
  });
  for (const message of recent) {
    if (message.direction === "OUTBOUND") return null;
    const content = message.content as MessageContent;
    if (!closesConversation(message.type, content)) return content.text?.trim() || MEDIA_LABEL[message.type] || "[mensagem]";
  }
  return null;
}
