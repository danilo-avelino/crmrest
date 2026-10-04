import { randomUUID } from "node:crypto";
import type { MessageType } from "@comanda/database/enums";
import { NormalizedMessage, StatusUpdate } from "@comanda/shared";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { type ChannelConnector, type OutboundText, type SendTarget, sendFailure } from "./connector.js";
import type { ParsedWebhook } from "./whatsapp.connector.js";

// Webhook do Instagram (API com login do Instagram): só os campos que o Comanda usa.
const IgEvent = z.looseObject({
  sender: z.looseObject({ id: z.string() }),
  timestamp: z.number(),
  message: z
    .looseObject({
      mid: z.string(),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      attachments: z.array(z.looseObject({ type: z.string(), payload: z.looseObject({ url: z.string().optional() }).optional() })).optional(),
    })
    .optional(),
  read: z.looseObject({ mid: z.string() }).optional(),
});

const MEDIA_TYPES: Record<string, MessageType> = { image: "IMAGE", video: "VIDEO", audio: "AUDIO", file: "DOCUMENT" };
const ATTACHMENT_TEXT: Record<string, string> = {
  story_mention: "Mencionou o restaurante nos stories.",
  share: "Compartilhou uma publicação.",
  ig_reel: "Compartilhou um reel.",
  reel: "Compartilhou um reel.",
};

/** Converte os eventos de `entry.messaging` no formato interno (§6). */
export function parseInstagram(channelId: string, events: unknown[]): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [], rejected: 0 };
  for (const raw of events) {
    const event = IgEvent.safeParse(raw);
    if (!event.success) {
      result.rejected++;
      continue;
    }
    const { sender, timestamp, message, read } = event.data;

    if (read) {
      const update = StatusUpdate.safeParse({
        channelId,
        channelType: "INSTAGRAM",
        externalMessageId: read.mid,
        status: "READ",
        timestamp: new Date(timestamp),
      });
      if (update.success) result.statuses.push(update.data);
      continue;
    }
    // Eco: mensagem enviada pela própria conta (pelo Comanda ou pelo app). Não é do cliente.
    if (!message || message.is_echo) continue;

    const normalized = NormalizedMessage.safeParse({
      channelId,
      channelType: "INSTAGRAM",
      externalMessageId: message.mid,
      externalContactId: sender.id,
      direction: "INBOUND",
      timestamp: new Date(timestamp),
      ...messageBody(message),
    });
    if (normalized.success) result.messages.push(normalized.data);
    else result.rejected++;
  }
  return result;
}

function messageBody(message: NonNullable<z.infer<typeof IgEvent>["message"]>) {
  const attachment = message.attachments?.[0];
  if (!attachment) return { type: "TEXT" as const, text: message.text ?? "" };
  const mediaType = MEDIA_TYPES[attachment.type];
  if (mediaType && attachment.payload?.url) {
    return {
      type: mediaType,
      text: message.text,
      media: { mimeType: `${attachment.type === "file" ? "application" : attachment.type}/*`, url: attachment.payload.url },
    };
  }
  return { type: "TEXT" as const, text: ATTACHMENT_TEXT[attachment.type] ?? "Mensagem de um tipo que o Comanda ainda não exibe." };
}

/** Envio e perfil pela API do Instagram (graph.instagram.com). */
export class InstagramConnector implements ChannelConnector {
  readonly type = "INSTAGRAM" as const;

  constructor(private readonly env: Pick<Env, "INSTAGRAM_GRAPH_URL" | "CHANNELS_DRY_RUN">) {}

  async send(target: SendTarget, message: OutboundText): Promise<{ externalMessageId: string }> {
    if (this.env.CHANNELS_DRY_RUN) return { externalMessageId: `dry-run.${randomUUID()}` };
    const response = await fetch(`${this.env.INSTAGRAM_GRAPH_URL}/${target.externalChannelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: target.recipientId }, message: { text: message.text } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as { message_id?: string; error?: { message?: string } } | null;
    if (!response.ok) throw sendFailure(response.status, body?.error?.message ?? `HTTP ${response.status}`);
    if (!body?.message_id) throw new Error("Resposta do Instagram sem o id da mensagem");
    return { externalMessageId: body.message_id };
  }

  /** Token de longa duração renovado por mais 60 dias (a Meta só renova tokens com mais de 24 h). */
  async refreshToken(accessToken: string): Promise<string> {
    const url = new URL("/refresh_access_token", this.env.INSTAGRAM_GRAPH_URL); // endpoint sem versão
    url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: accessToken }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = (await response.json().catch(() => null)) as { access_token?: string; error?: { message?: string } } | null;
    if (!response.ok || !body?.access_token) throw new Error(`Instagram: ${body?.error?.message ?? `HTTP ${response.status}`}`);
    return body.access_token;
  }

  /** Nome e @ de quem escreveu (o webhook só traz o id). Sem permissão ou em simulação, devolve vazio. */
  async fetchProfile(igsid: string, accessToken: string): Promise<{ name?: string; username?: string }> {
    if (this.env.CHANNELS_DRY_RUN) return {};
    const response = await fetch(`${this.env.INSTAGRAM_GRAPH_URL}/${igsid}?fields=name,username`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return {};
    const body = (await response.json().catch(() => null)) as { name?: string; username?: string } | null;
    return { name: body?.name || undefined, username: body?.username || undefined };
  }
}
