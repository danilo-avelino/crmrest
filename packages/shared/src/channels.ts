import type { ChannelType } from "@dishdesk/database/enums";

export type ChannelCapabilities = {
  /** O atendente pode responder pelo Dish Desk. */
  send: boolean;
  /** Resposta livre só até 24h depois da última mensagem do cliente (§5.1). */
  window24h: boolean;
  /** A origem informa o telefone real do cliente (senão, entra a coleta de telefone, §5.3). */
  providesPhone: boolean;
};

export const CHANNEL_CAPABILITIES: Record<ChannelType, ChannelCapabilities> = {
  WHATSAPP: { send: true, window24h: true, providesPhone: true },
  INSTAGRAM: { send: true, window24h: true, providesPhone: false },
  MESSENGER: { send: false, window24h: true, providesPhone: false },
  // O iFood não oferece chat por integração: a conversa mostra só os pedidos.
  IFOOD: { send: false, window24h: false, providesPhone: false },
  WEBCHAT: { send: false, window24h: false, providesPhone: false },
  // Cardápio Web: só pedidos (o cliente conversa pelo WhatsApp), que trazem o telefone.
  CARDAPIO_WEB: { send: false, window24h: false, providesPhone: true },
};

export const CHANNEL_LABEL: Record<ChannelType, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
  IFOOD: "iFood",
  WEBCHAT: "chat do site",
  CARDAPIO_WEB: "Cardápio Web",
};
