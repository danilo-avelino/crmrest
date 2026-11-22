import type { ChannelType } from "@dishdesk/database/enums";

export type OutboundText = { type: "TEXT"; text: string };
export type OutboundTemplate = { name: string; language: string; variables: string[] };
/** Arquivo encaminhado de outra conversa (o conteúdo em base64). */
export type OutboundMedia = { kind: "IMAGE" | "VIDEO" | "DOCUMENT" | "AUDIO"; mimeType: string; base64: string; caption?: string; fileName?: string };

/** Opção fechada de uma pergunta com botões ou lista (o id volta na resposta do cliente). */
export type InteractiveOption = { id: string; title: string };
/** Pergunta com opções fechadas: botões (até 3) ou lista (até 10), só na API oficial do WhatsApp. */
export type OutboundInteractive = { body: string; options: InteractiveOption[] };

/** Limites da WhatsApp Cloud API: botões 3 de até 20 caracteres, lista 10 de até 24, corpo de até 1024. */
export function interactiveLayout(message: OutboundInteractive): "buttons" | "list" | null {
  const { body, options } = message;
  if (!body || body.length > 1024 || options.length < 1) return null;
  const longest = Math.max(...options.map((option) => option.title.length));
  if (options.length <= 3 && longest <= 20) return "buttons";
  return options.length <= 10 && longest <= 24 ? "list" : null;
}

/** Para onde enviar: a conta do restaurante no canal e o cliente nele. */
export type SendTarget = { externalChannelId: string; recipientId: string; accessToken: string };

/** Contrato de um canal (§6). Adicionar um canal = escrever um conector, sem tocar no núcleo. */
export interface ChannelConnector {
  readonly type: ChannelType;
  /** O que o canal sabe enviar além de texto; sem isto, vale só o texto (o agente do cardápio numera as opções). */
  readonly capabilities?: { interactive: boolean };
  send(target: SendTarget, message: OutboundText): Promise<{ externalMessageId: string }>;
  /** Só canais com templates (WhatsApp). */
  sendTemplate?(target: SendTarget, template: OutboundTemplate): Promise<{ externalMessageId: string }>;
  /** Só canais que recebem arquivos enviados pelo Dish Desk (WhatsApp por QR Code). */
  sendMedia?(target: SendTarget, media: OutboundMedia): Promise<{ externalMessageId: string }>;
  /** Só canais com botões e listas (WhatsApp Cloud API, `capabilities.interactive`). Confira `interactiveLayout` antes. */
  sendInteractive?(target: SendTarget, message: OutboundInteractive): Promise<{ externalMessageId: string }>;
}

/** Falha que não adianta repetir (ex.: 4xx da plataforma): a mensagem vira FAILED na hora. */
export class PermanentSendError extends Error {}

/** A plataforma recusou a credencial do canal (token expirado ou revogado): o canal precisa ser reconectado. */
export class ChannelAuthError extends PermanentSendError {}

/** Erro 190 da Graph API: token de acesso inválido ou expirado. */
const META_INVALID_TOKEN = 190;

/** Converte a resposta de erro de uma API de canal em erro de credencial, permanente (4xx) ou temporário. */
export function sendFailure(status: number, reason: string, code?: number): Error {
  if (status === 401 || code === META_INVALID_TOKEN) return new ChannelAuthError(reason);
  const permanent = status >= 400 && status < 500 && status !== 429;
  return permanent ? new PermanentSendError(reason) : new Error(reason);
}
