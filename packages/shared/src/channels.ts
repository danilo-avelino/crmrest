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
  // WhatsApp conectado por QR Code (Evolution API): sem a janela de 24h nem templates, que são regras da API oficial.
  WHATSAPP: { send: true, window24h: false, providesPhone: true },
  INSTAGRAM: { send: true, window24h: true, providesPhone: false },
  MESSENGER: { send: false, window24h: true, providesPhone: false },
  // O iFood não oferece chat por integração: a conversa mostra só os pedidos.
  IFOOD: { send: false, window24h: false, providesPhone: false },
  WEBCHAT: { send: false, window24h: false, providesPhone: false },
  // Cardápio Web: só pedidos (o cliente conversa pelo WhatsApp), que trazem o telefone.
  CARDAPIO_WEB: { send: false, window24h: false, providesPhone: true },
  // Neemo (Linx Delivery App): como o Cardápio Web, só pedidos, que trazem o telefone.
  NEEMO: { send: false, window24h: false, providesPhone: true },
};

export const CHANNEL_LABEL: Record<ChannelType, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
  IFOOD: "iFood",
  WEBCHAT: "chat do site",
  CARDAPIO_WEB: "Cardápio Web",
  NEEMO: "Neemo",
};

/** De onde veio um pedido: um canal integrado ou o cardápio próprio (source MENU sem conversa, que não tem canal). */
export type OrderOrigin = ChannelType | "MENU";

export const ORDER_ORIGIN_LABEL: Record<OrderOrigin, string> = { ...CHANNEL_LABEL, MENU: "Cardápio Dish Desk" };

/** Origem pelo canal do pedido: sem canal, é o cardápio próprio. */
export function orderOriginOf(channel: { type: ChannelType } | null | undefined): OrderOrigin {
  return channel?.type ?? "MENU";
}

/** Artigo do nome de cada canal, para as frases: "o iFood", "a Neemo". */
export const CHANNEL_ARTICLE: Record<ChannelType, "o" | "a"> = {
  WHATSAPP: "o",
  INSTAGRAM: "o",
  MESSENGER: "o",
  IFOOD: "o",
  WEBCHAT: "o",
  CARDAPIO_WEB: "o",
  NEEMO: "a",
};

export const ORDER_ORIGIN_ARTICLE: Record<OrderOrigin, "o" | "a"> = { ...CHANNEL_ARTICLE, MENU: "o" };
