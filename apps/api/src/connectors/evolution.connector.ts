import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { MessageType } from "@dishdesk/database/enums";
import { NormalizedMessage, phoneFromWhatsAppId, StatusUpdate } from "@dishdesk/shared";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { type ChannelConnector, type OutboundText, type SendTarget, sendFailure } from "./connector.js";
import type { ParsedWebhook } from "./whatsapp.connector.js";

/** Eventos que a Evolution entrega à API: mensagens recebidas, status das enviadas e a conexão do número. */
const EVENTS = ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"];

/** Cabeçalho com o token que a Evolution manda em todo webhook (EVOLUTION_WEBHOOK_TOKEN). */
export const EVOLUTION_TOKEN_HEADER = "x-dishdesk-token";

// Webhook da Evolution API 2.3: só os campos que o Dish Desk usa.
const Envelope = z.looseObject({ event: z.string(), instance: z.string(), sender: z.string().nullish(), data: z.unknown() });
const EvoMedia = z.looseObject({ mimetype: z.string(), caption: z.string().optional(), fileName: z.string().optional() });
const EvoMessage = z.looseObject({
  key: z.looseObject({ id: z.string(), remoteJid: z.string(), fromMe: z.boolean(), remoteJidAlt: z.string().nullish() }),
  pushName: z.string().nullish(),
  messageType: z.string(),
  messageTimestamp: z.coerce.number(),
  message: z
    .looseObject({
      conversation: z.string().optional(),
      imageMessage: EvoMedia.optional(),
      videoMessage: EvoMedia.optional(),
      audioMessage: EvoMedia.optional(),
      documentMessage: EvoMedia.optional(),
      stickerMessage: EvoMedia.optional(),
      locationMessage: z
        .looseObject({ degreesLatitude: z.number(), degreesLongitude: z.number(), name: z.string().optional(), address: z.string().optional() })
        .optional(),
      buttonsResponseMessage: z.looseObject({ selectedDisplayText: z.string() }).optional(),
      templateButtonReplyMessage: z.looseObject({ selectedDisplayText: z.string() }).optional(),
      listResponseMessage: z.looseObject({ title: z.string() }).optional(),
    })
    .nullish(),
});
const EvoStatus = z.looseObject({ keyId: z.string(), fromMe: z.boolean(), status: z.string() });
const EvoConnection = z.looseObject({ state: z.string() });

const MEDIA_TYPES = {
  imageMessage: "IMAGE",
  videoMessage: "VIDEO",
  audioMessage: "AUDIO",
  documentMessage: "DOCUMENT",
  stickerMessage: "STICKER",
} as const;
const STATUS = { SERVER_ACK: "SENT", DELIVERY_ACK: "DELIVERED", READ: "READ", PLAYED: "READ", ERROR: "FAILED" } as const;
// Tipos que não viram mensagem na conversa (reações, edições e apagamentos, chaves de criptografia...).
const IGNORED_TYPES = new Set(["reactionMessage", "protocolMessage", "editedMessage", "senderKeyDistributionMessage", "pollUpdateMessage"]);

/** Um webhook da Evolution: a instância, o número dela (sem ele, ainda não conectou) e o evento. */
export type EvolutionBatch = { instance: string; externalId: string | null; event: string; data: unknown };

export function splitEvolutionPayload(payload: unknown): EvolutionBatch | null {
  const parsed = Envelope.safeParse(payload);
  if (!parsed.success) return null;
  const { instance, sender, event, data } = parsed.data;
  return { instance, externalId: sender ? contactIdFromJid(sender) : null, event, data };
}

/**
 * Jid do WhatsApp → identidade: o número, no mesmo formato do wa_id da API oficial (o cliente que já falou com o
 * restaurante continua o mesmo), ou, quando o WhatsApp esconde o número, o jid @lid inteiro. Grupos e status: null.
 */
export function contactIdFromJid(jid: string): string | null {
  const [user = "", server] = jid.split("@");
  if (server === "s.whatsapp.net") return user.split(":")[0] || null; // "5586...:12@s.whatsapp.net": o sufixo é o aparelho
  if (server === "lid") return jid;
  return null;
}

/** Converte um evento de mensagem (recebida ou status de uma enviada) da Evolution no formato interno (§6). */
export function parseEvolution(channelId: string, event: string, data: unknown): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [], rejected: 0 };
  if (event === "messages.upsert") {
    const parsed = EvoMessage.safeParse(data);
    if (!parsed.success) return { ...result, rejected: 1 };
    const { key, message } = parsed.data;
    // Mensagens que o próprio restaurante mandou (pelo celular ou pelo Dish Desk) não entram como recebidas.
    if (key.fromMe || IGNORED_TYPES.has(parsed.data.messageType) || !message) return result;
    const jid = key.remoteJid.endsWith("@lid") && key.remoteJidAlt ? key.remoteJidAlt : key.remoteJid;
    const contactId = contactIdFromJid(jid);
    if (!contactId) return result; // grupo, status ou canal
    const phone = contactId.includes("@") ? undefined : phoneFromWhatsAppId(contactId);
    const normalized = NormalizedMessage.safeParse({
      channelId,
      channelType: "WHATSAPP",
      externalMessageId: key.id,
      externalContactId: contactId,
      direction: "INBOUND",
      timestamp: new Date(parsed.data.messageTimestamp * 1000),
      contactProfile: {
        name: parsed.data.pushName || undefined,
        phone: phone && z.e164().safeParse(phone).success ? phone : undefined,
      },
      ...messageBody(parsed.data.messageType, message, key.id),
    });
    if (normalized.success) result.messages.push(normalized.data);
    else result.rejected++;
  } else if (event === "messages.update") {
    const parsed = EvoStatus.safeParse(data);
    if (!parsed.success) return { ...result, rejected: 1 };
    const mapped = STATUS[parsed.data.status as keyof typeof STATUS];
    if (!parsed.data.fromMe || !mapped) return result;
    const update = StatusUpdate.safeParse({
      channelId,
      channelType: "WHATSAPP",
      externalMessageId: parsed.data.keyId,
      status: mapped,
      timestamp: new Date(),
    });
    if (update.success) result.statuses.push(update.data);
    else result.rejected++;
  }
  return result;
}

/** connection.update: "open" (número conectado) ou "close" (desconectado no celular ou recusado). Outros eventos: null. */
export function evolutionConnection(event: string, data: unknown): "open" | "close" | null {
  if (event !== "connection.update") return null;
  const state = EvoConnection.safeParse(data).data?.state;
  if (state === "open") return "open";
  // A Evolution só avisa o "close" quando desiste de reconectar (ex.: o aparelho foi desconectado no celular).
  return state === "close" || state === "refused" ? "close" : null;
}

function messageBody(
  messageType: string,
  message: NonNullable<z.infer<typeof EvoMessage>["message"]>,
  keyId: string,
): { type: MessageType; text?: string; media?: object; metadata?: object } {
  if (messageType === "conversation" && message.conversation !== undefined) return { type: "TEXT", text: message.conversation };
  const mediaType = MEDIA_TYPES[messageType as keyof typeof MEDIA_TYPES];
  const media = mediaType ? message[messageType as keyof typeof MEDIA_TYPES] : undefined;
  if (mediaType && media) {
    return {
      type: mediaType,
      text: media.caption,
      // O arquivo fica na Evolution: é buscado pelo id da mensagem (fetchMedia).
      media: { mimeType: media.mimetype, externalMediaId: keyId },
      metadata: media.fileName ? { filename: media.fileName } : undefined,
    };
  }
  const location = message.locationMessage;
  if (messageType === "locationMessage" && location) {
    return {
      type: "LOCATION",
      metadata: { location: { latitude: location.degreesLatitude, longitude: location.degreesLongitude, name: location.name, address: location.address } },
    };
  }
  const reply =
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    message.listResponseMessage?.title;
  if (reply) return { type: "TEXT", text: reply };
  return { type: "TEXT", text: "Mensagem de um tipo que o Dish Desk ainda não exibe.", metadata: { unsupportedType: messageType } };
}

/** Confere o token do webhook (EVOLUTION_WEBHOOK_TOKEN) em tempo constante. */
export function verifyEvolutionToken(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

/** Situação de uma tentativa de conexão: o número já conectou, ou o QR Code a escanear (null enquanto não existe). */
export type EvolutionConnection = { state: "open"; ownerId: string; name: string | null } | { state: "waiting"; qr: string | null };

/**
 * WhatsApp por QR Code (Evolution API, que fala com o WhatsApp Web). Cada número é uma instância na Evolution; o canal
 * guarda o nome dela e o token de acesso. Envio: POST /message/sendText/{instância}.
 */
export class EvolutionConnector implements ChannelConnector {
  readonly type = "WHATSAPP" as const;

  constructor(
    private readonly env: Pick<
      Env,
      "EVOLUTION_API_URL" | "EVOLUTION_API_KEY" | "EVOLUTION_WEBHOOK_URL" | "EVOLUTION_WEBHOOK_TOKEN" | "CHANNELS_DRY_RUN"
    >,
  ) {}

  get configured(): boolean {
    const { EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_WEBHOOK_URL, EVOLUTION_WEBHOOK_TOKEN } = this.env;
    return Boolean(EVOLUTION_API_URL && EVOLUTION_API_KEY && EVOLUTION_WEBHOOK_URL && EVOLUTION_WEBHOOK_TOKEN);
  }

  /** Token de acesso de uma instância: derivado do nome, para a API não guardar nada entre criar a instância e o número conectar. */
  instanceToken(instance: string): string {
    return createHmac("sha256", this.env.EVOLUTION_API_KEY ?? "").update(`instance:${instance}`).digest("hex");
  }

  async send(target: SendTarget, message: OutboundText): Promise<{ externalMessageId: string }> {
    if (this.env.CHANNELS_DRY_RUN) return { externalMessageId: `dry-run.${randomUUID()}` };
    const response = await fetch(`${this.env.EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(target.externalChannelId)}`, {
      method: "POST",
      headers: { apikey: target.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ number: target.recipientId, text: message.text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as { key?: { id?: string } } | null;
    if (!response.ok) throw sendFailure(response.status, `Evolution: ${errorOf(body) ?? `HTTP ${response.status}`}`);
    const externalMessageId = body?.key?.id;
    if (!externalMessageId) throw new Error("Resposta da Evolution sem o id da mensagem");
    return { externalMessageId };
  }

  /** Cria a instância, já com o webhook apontando para a API; devolve o primeiro QR Code, se a Evolution já o gerou. */
  async createInstance(instance: string): Promise<string | null> {
    const body = (await this.request("/instance/create", this.env.EVOLUTION_API_KEY ?? "", {
      method: "POST",
      body: {
        instanceName: instance,
        token: this.instanceToken(instance),
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
        groupsIgnore: true,
        webhook: {
          url: this.env.EVOLUTION_WEBHOOK_URL,
          byEvents: false,
          base64: false,
          headers: { [EVOLUTION_TOKEN_HEADER]: this.env.EVOLUTION_WEBHOOK_TOKEN },
          events: EVENTS,
        },
      },
    })) as { qrcode?: { base64?: string } } | null;
    return body?.qrcode?.base64 || null;
  }

  /** O número conectou? Se não, o QR Code atual; com o QR vencido, a Evolution gera outro. */
  async connection(instance: string): Promise<EvolutionConnection> {
    const token = this.instanceToken(instance);
    const status = (await this.request(`/instance/connectionState/${encodeURIComponent(instance)}`, token)) as {
      instance?: { state?: string };
    } | null;
    if (status?.instance?.state === "open") {
      const instances = (await this.request(`/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`, token)) as
        | { ownerJid?: string; profileName?: string | null }[]
        | null;
      const info = instances?.[0];
      const ownerId = info?.ownerJid ? contactIdFromJid(info.ownerJid) : null;
      if (!ownerId) throw new Error("Evolution: a instância conectou, mas não informou o número.");
      return { state: "open", ownerId, name: info?.profileName || null };
    }
    const qr = (await this.request(`/instance/connect/${encodeURIComponent(instance)}`, token)) as { base64?: string } | null;
    return { state: "waiting", qr: qr?.base64 || null };
  }

  /** Desconecta o número (o aparelho some de "Aparelhos conectados" no celular) e apaga a instância. */
  async deleteInstance(instance: string): Promise<void> {
    await this.request(`/instance/delete/${encodeURIComponent(instance)}`, this.instanceToken(instance), { method: "DELETE" });
  }

  /** Arquivo de uma mensagem recebida, que a Evolution baixa do WhatsApp pelo id da mensagem. */
  async fetchMedia(instance: string, accessToken: string, messageId: string): Promise<Response> {
    if (this.env.CHANNELS_DRY_RUN) throw new Error("Mídia indisponível na simulação.");
    const body = (await this.request(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, accessToken, {
      method: "POST",
      body: { message: { key: { id: messageId } } },
    })) as { base64?: string; mimetype?: string } | null;
    if (!body?.base64) throw new Error("Evolution: a resposta não trouxe o arquivo.");
    return new Response(Buffer.from(body.base64, "base64"), { headers: { "Content-Type": body.mimetype ?? "application/octet-stream" } });
  }

  private async request(path: string, apikey: string, init: { method?: string; body?: object } = {}): Promise<unknown> {
    const response = await fetch(`${this.env.EVOLUTION_API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: { apikey, ...(init.body && { "Content-Type": "application/json" }) },
      body: init.body && JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Evolution: ${errorOf(body) ?? `HTTP ${response.status}`}`);
    return body;
  }
}

/** Mensagem de erro da Evolution ({ response: { message: [...] } }); um número sem WhatsApp vira uma frase. */
function errorOf(body: unknown): string | undefined {
  const message = (body as { response?: { message?: unknown } } | null)?.response?.message;
  const items = Array.isArray(message) ? message : message === undefined ? [] : [message];
  if (items.some((item) => (item as { exists?: boolean } | null)?.exists === false)) return "o número não tem WhatsApp.";
  const text = items.filter((item): item is string => typeof item === "string").join("; ");
  return text || undefined;
}
