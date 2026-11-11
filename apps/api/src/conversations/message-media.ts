import type { ChannelType } from "@dishdesk/database/enums";
import type { MessageContent } from "@dishdesk/shared";
import type { ConnectorsService } from "../connectors/connectors.service.js";

type Media = NonNullable<MessageContent["media"]>;

/**
 * Arquivo (imagem, áudio...) de uma mensagem recebida. O Dish Desk não guarda mídia: busca na plataforma a cada pedido,
 * pelo id (WhatsApp) ou pelo endereço (Instagram) que veio no webhook. Só funciona enquanto a plataforma guardar o arquivo.
 */
export async function downloadMedia(
  connectors: ConnectorsService,
  channel: { type: ChannelType; credentials: Uint8Array },
  media: Media,
): Promise<{ body: ReadableStream; mimeType: string }> {
  let file: Response;
  if (media.url) file = await fetch(media.url, { signal: AbortSignal.timeout(60_000) });
  else if (media.externalMediaId && channel.type === "WHATSAPP") {
    const { accessToken, instance } = connectors.secrets(channel.credentials);
    // WhatsApp por QR Code: a Evolution baixa o arquivo pelo id da mensagem.
    file = instance
      ? await connectors.evolution.fetchMedia(instance, accessToken, media.externalMediaId)
      : await connectors.whatsapp.fetchMedia(media.externalMediaId, accessToken);
  } else throw new Error("mídia sem origem");
  if (!file.ok || !file.body) throw new Error(`HTTP ${file.status}`);
  // O Instagram não informa o tipo no webhook ("image/*"): vale o que o arquivo diz.
  const mimeType = media.mimeType.includes("*") ? (file.headers.get("content-type") ?? "application/octet-stream") : media.mimeType;
  return { body: file.body, mimeType };
}
