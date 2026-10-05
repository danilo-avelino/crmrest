import { randomUUID } from "node:crypto";
import type { MessageType } from "@comanda/database/enums";
import { NormalizedMessage, phoneFromWhatsAppId, StatusUpdate, type WhatsAppTemplate } from "@comanda/shared";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { type ChannelConnector, type OutboundTemplate, type OutboundText, type SendTarget, sendFailure } from "./connector.js";

// Webhook da WhatsApp Cloud API: só os campos que o Comanda usa.
const WaMedia = z.looseObject({
  id: z.string(),
  mime_type: z.string(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});
const WaMessage = z.looseObject({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  image: WaMedia.optional(),
  video: WaMedia.optional(),
  audio: WaMedia.optional(),
  document: WaMedia.optional(),
  sticker: WaMedia.optional(),
  location: z
    .looseObject({ latitude: z.number(), longitude: z.number(), name: z.string().optional(), address: z.string().optional() })
    .optional(),
  button: z.looseObject({ text: z.string() }).optional(),
  interactive: z
    .looseObject({
      button_reply: z.looseObject({ title: z.string() }).optional(),
      list_reply: z.looseObject({ title: z.string() }).optional(),
    })
    .optional(),
});
const WaValue = z.looseObject({
  contacts: z.array(z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string() }).optional() })).optional(),
  messages: z.array(WaMessage).optional(),
  statuses: z
    .array(
      z.looseObject({
        id: z.string(),
        status: z.string(),
        timestamp: z.string(),
        errors: z.array(z.looseObject({ title: z.string().optional(), message: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});

const MEDIA_TYPES = { image: "IMAGE", video: "VIDEO", audio: "AUDIO", document: "DOCUMENT", sticker: "STICKER" } as const;
const STATUS = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" } as const;
// Tipos que não viram mensagem na conversa (reações, avisos de troca de número...).
const IGNORED_TYPES = new Set(["reaction", "system", "ephemeral"]);

export type ParsedWebhook = { messages: NormalizedMessage[]; statuses: StatusUpdate[]; rejected: number };

/** Converte o `value` de um webhook do WhatsApp no formato interno (§6). */
export function parseWhatsApp(channelId: string, value: unknown): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [], rejected: 0 };
  const parsed = WaValue.safeParse(value);
  if (!parsed.success) return { ...result, rejected: 1 };
  const names = new Map(parsed.data.contacts?.map((c) => [c.wa_id, c.profile?.name]));

  for (const message of parsed.data.messages ?? []) {
    if (IGNORED_TYPES.has(message.type)) continue;
    const phone = phoneFromWhatsAppId(message.from);
    const normalized = NormalizedMessage.safeParse({
      channelId,
      channelType: "WHATSAPP",
      externalMessageId: message.id,
      externalContactId: message.from,
      direction: "INBOUND",
      timestamp: new Date(Number(message.timestamp) * 1000),
      contactProfile: {
        name: names.get(message.from),
        phone: z.e164().safeParse(phone).success ? phone : undefined,
      },
      ...messageBody(message),
    });
    if (normalized.success) result.messages.push(normalized.data);
    else result.rejected++;
  }

  for (const status of parsed.data.statuses ?? []) {
    const mapped = STATUS[status.status as keyof typeof STATUS];
    if (!mapped) continue;
    const update = StatusUpdate.safeParse({
      channelId,
      channelType: "WHATSAPP",
      externalMessageId: status.id,
      status: mapped,
      error: status.errors?.[0]?.message ?? status.errors?.[0]?.title,
      timestamp: new Date(Number(status.timestamp) * 1000),
    });
    if (update.success) result.statuses.push(update.data);
    else result.rejected++;
  }
  return result;
}

function messageBody(message: z.infer<typeof WaMessage>): { type: MessageType; text?: string; media?: object; metadata?: object } {
  if (message.type === "text" && message.text) return { type: "TEXT", text: message.text.body };
  const mediaType = MEDIA_TYPES[message.type as keyof typeof MEDIA_TYPES];
  const media = mediaType ? message[message.type as keyof typeof MEDIA_TYPES] : undefined;
  if (mediaType && media) {
    return {
      type: mediaType,
      text: media.caption,
      media: { mimeType: media.mime_type, externalMediaId: media.id },
      metadata: media.filename ? { filename: media.filename } : undefined,
    };
  }
  if (message.type === "location" && message.location) return { type: "LOCATION", metadata: { location: message.location } };
  if (message.type === "button" && message.button) return { type: "TEXT", text: message.button.text };
  const reply = message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
  if (message.type === "interactive" && reply) return { type: "TEXT", text: reply };
  return { type: "TEXT", text: "Mensagem de um tipo que o Comanda ainda não exibe.", metadata: { unsupportedType: message.type } };
}

/** Resposta da Graph API; um erro vira uma mensagem que o admin entende (ex.: token expirado). */
export async function graph(request: Promise<Response>): Promise<unknown> {
  const response = await request;
  // O login do Instagram (api.instagram.com) responde erros como { error_message }.
  const body = (await response.json().catch(() => null)) as { error?: { message?: string }; error_message?: string } | null;
  if (!response.ok) throw new Error(`Meta: ${body?.error?.message ?? body?.error_message ?? `HTTP ${response.status}`}`);
  return body;
}

// Modo de simulação: templates de exemplo para usar a Inbox sem uma conta da Meta.
const SAMPLE_TEMPLATES: WhatsAppTemplate[] = [
  {
    name: "retomar_atendimento",
    language: "pt_BR",
    category: "UTILITY",
    body: "Olá, {{1}}! Aqui é do restaurante. Podemos continuar seu atendimento por aqui?",
    variables: 1,
  },
  {
    name: "pedido_a_caminho",
    language: "pt_BR",
    category: "UTILITY",
    body: "Oi, {{1}}! Seu pedido {{2}} já saiu para entrega. 🛵",
    variables: 2,
  },
];

const TemplatesResponse = z.object({
  data: z.array(
    z.looseObject({
      name: z.string(),
      language: z.string(),
      category: z.string(),
      components: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).default([]),
    }),
  ),
});

/** Envio pela WhatsApp Cloud API (§6): POST /{phone_number_id}/messages. */
export class WhatsAppConnector implements ChannelConnector {
  readonly type = "WHATSAPP" as const;

  constructor(private readonly env: Pick<Env, "META_GRAPH_URL" | "CHANNELS_DRY_RUN" | "META_APP_ID" | "META_APP_SECRET">) {}

  send(target: SendTarget, message: OutboundText): Promise<{ externalMessageId: string }> {
    return this.post(target, { type: "text", text: { body: message.text, preview_url: false } });
  }

  sendTemplate(target: SendTarget, template: OutboundTemplate): Promise<{ externalMessageId: string }> {
    return this.post(target, {
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        components: template.variables.length
          ? [{ type: "body", parameters: template.variables.map((text) => ({ type: "text", text })) }]
          : [],
      },
    });
  }

  /**
   * Confere o número e o token e inscreve a conta (WABA) nos webhooks do app: é o que faz as mensagens chegarem.
   * Devolve o nome verificado e o número para exibição.
   */
  async connectNumber(phoneNumberId: string, wabaId: string, accessToken: string): Promise<{ name: string }> {
    if (this.env.CHANNELS_DRY_RUN) return { name: `WhatsApp ${phoneNumberId}` };
    const headers = { Authorization: `Bearer ${accessToken}` };
    const number = await graph(
      fetch(`${this.env.META_GRAPH_URL}/${phoneNumberId}?fields=display_phone_number,verified_name`, { headers, signal: AbortSignal.timeout(15_000) }),
    );
    const { display_phone_number: phone, verified_name: verifiedName } = number as { display_phone_number?: string; verified_name?: string };
    await graph(fetch(`${this.env.META_GRAPH_URL}/${wabaId}/subscribed_apps`, { method: "POST", headers, signal: AbortSignal.timeout(15_000) }));
    return { name: [verifiedName, phone && `(${phone})`].filter(Boolean).join(" ") || `WhatsApp ${phoneNumberId}` };
  }

  /** Cadastro incorporado: troca o código da janela da Meta pelo token da empresa, que não expira. */
  async exchangeSignupCode(code: string): Promise<string> {
    if (this.env.CHANNELS_DRY_RUN) return `dry-run-token-${code.slice(0, 8)}`;
    const { META_APP_ID: appId, META_APP_SECRET: appSecret } = this.env;
    if (!appId || !appSecret) throw new Error("o cadastro do WhatsApp não está configurado neste servidor");
    const url = new URL(`${this.env.META_GRAPH_URL}/oauth/access_token`);
    url.search = new URLSearchParams({ client_id: appId, client_secret: appSecret, code }).toString();
    const body = (await graph(fetch(url, { signal: AbortSignal.timeout(15_000) }))) as { access_token?: string };
    if (!body.access_token) throw new Error("Meta: a resposta não trouxe o token.");
    return body.access_token;
  }

  /** A conta (WABA) que a empresa liberou na janela da Meta, lida nas permissões do token. */
  async findSignupWaba(accessToken: string): Promise<string> {
    if (this.env.CHANNELS_DRY_RUN) return "0000000000";
    const url = new URL(`${this.env.META_GRAPH_URL}/debug_token`);
    url.search = new URLSearchParams({ input_token: accessToken, access_token: `${this.env.META_APP_ID}|${this.env.META_APP_SECRET}` }).toString();
    const body = (await graph(fetch(url, { signal: AbortSignal.timeout(15_000) }))) as {
      data?: { granular_scopes?: { scope?: string; target_ids?: string[] }[] };
    };
    const waba = body.data?.granular_scopes?.find((s) => s.scope === "whatsapp_business_management")?.target_ids?.[0];
    if (!waba) throw new Error("a Meta não informou a conta do WhatsApp escolhida");
    return waba;
  }

  /** O número da conta (WABA): na Coexistência a janela da Meta pode não dizer qual foi conectado. */
  async findPhoneNumber(wabaId: string, accessToken: string): Promise<string> {
    if (this.env.CHANNELS_DRY_RUN) return wabaId;
    const body = (await graph(
      fetch(`${this.env.META_GRAPH_URL}/${wabaId}/phone_numbers?fields=id`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      }),
    )) as { data?: { id?: string }[] };
    const id = body.data?.[0]?.id;
    if (!id) throw new Error("a conta escolhida não tem número de WhatsApp");
    return id;
  }

  /** Registra um número novo na Cloud API; o PIN vira a confirmação em duas etapas do número. */
  async registerNumber(phoneNumberId: string, pin: string, accessToken: string): Promise<void> {
    if (this.env.CHANNELS_DRY_RUN) return;
    await graph(
      fetch(`${this.env.META_GRAPH_URL}/${phoneNumberId}/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
        signal: AbortSignal.timeout(15_000),
      }),
    );
  }

  /** Templates aprovados da conta (WABA), com o corpo e quantas variáveis ele tem. */
  async listTemplates(wabaId: string | undefined, accessToken: string): Promise<WhatsAppTemplate[]> {
    if (this.env.CHANNELS_DRY_RUN) return SAMPLE_TEMPLATES;
    if (!wabaId) throw new Error("Canal sem o ID da conta do WhatsApp (WABA).");
    const response = await fetch(
      `${this.env.META_GRAPH_URL}/${wabaId}/message_templates?status=APPROVED&fields=name,language,category,components&limit=100`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(`Templates indisponíveis (HTTP ${response.status})`);
    return TemplatesResponse.parse(await response.json()).data.map((template) => {
      const body = template.components.find((component) => component.type === "BODY")?.text ?? "";
      return {
        name: template.name,
        language: template.language,
        category: template.category,
        body,
        variables: new Set(body.match(/\{\{\d+\}\}/g) ?? []).size,
      };
    });
  }

  private async post(target: SendTarget, payload: object): Promise<{ externalMessageId: string }> {
    if (this.env.CHANNELS_DRY_RUN) return { externalMessageId: `dry-run.${randomUUID()}` };

    const response = await fetch(`${this.env.META_GRAPH_URL}/${target.externalChannelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.accessToken}`, "Content-Type": "application/json" },
      // Para o número com o 9: a Meta entrega no mesmo wa_id, e a lista de destinatários do número de teste só aceita esse formato.
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phoneFromWhatsAppId(target.recipientId).slice(1),
        ...payload,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as {
      messages?: { id?: string }[];
      error?: { message?: string; code?: number };
    } | null;
    if (!response.ok) throw sendFailure(response.status, body?.error?.message ?? `HTTP ${response.status}`, body?.error?.code);
    const externalMessageId = body?.messages?.[0]?.id;
    if (!externalMessageId) throw new Error("Resposta da Meta sem o id da mensagem");
    return { externalMessageId };
  }
}
