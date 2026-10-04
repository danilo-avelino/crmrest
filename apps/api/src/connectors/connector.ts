import type { ChannelType } from "@comanda/database/enums";

export type OutboundText = { type: "TEXT"; text: string };
export type OutboundTemplate = { name: string; language: string; variables: string[] };

/** Para onde enviar: a conta do restaurante no canal e o cliente nele. */
export type SendTarget = { externalChannelId: string; recipientId: string; accessToken: string };

/** Contrato de um canal (§6). Adicionar um canal = escrever um conector, sem tocar no núcleo. */
export interface ChannelConnector {
  readonly type: ChannelType;
  send(target: SendTarget, message: OutboundText): Promise<{ externalMessageId: string }>;
  /** Só canais com templates (WhatsApp). */
  sendTemplate?(target: SendTarget, template: OutboundTemplate): Promise<{ externalMessageId: string }>;
}

/** Falha que não adianta repetir (ex.: 4xx da plataforma): a mensagem vira FAILED na hora. */
export class PermanentSendError extends Error {}

/** Converte a resposta de erro de uma API de canal em erro permanente (4xx) ou temporário. */
export function sendFailure(status: number, reason: string): Error {
  const permanent = status >= 400 && status < 500 && status !== 429;
  return permanent ? new PermanentSendError(reason) : new Error(reason);
}
