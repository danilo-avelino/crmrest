import { describe, expect, it } from "vitest";
import { splitMetaPayload, verifyMetaSignature } from "../src/connectors/meta.js";
import { parseWhatsApp } from "../src/connectors/whatsapp.connector.js";
import { metaPayload, signMeta } from "./helpers.js";

const CHANNEL_ID = "01a10330-b8c8-750e-95d2-fcb1c581d8de";
const timestamp = "1791052800"; // 2026-10-03T18:40:00Z
const from = "5511987654321";

describe("webhook do WhatsApp", () => {
  it("lê texto com o nome e o telefone do perfil", () => {
    const { messages } = parseWhatsApp(CHANNEL_ID, {
      contacts: [{ profile: { name: "João Silva" }, wa_id: from }],
      messages: [{ from, id: "wamid.TEXT1", timestamp, type: "text", text: { body: "Vocês têm opção sem glúten?" } }],
    });
    expect(messages).toEqual([
      {
        channelId: CHANNEL_ID,
        channelType: "WHATSAPP",
        externalMessageId: "wamid.TEXT1",
        externalContactId: from,
        direction: "INBOUND",
        type: "TEXT",
        text: "Vocês têm opção sem glúten?",
        contactProfile: { name: "João Silva", phone: "+5511987654321" },
        timestamp: new Date("2026-10-03T18:40:00.000Z"),
      },
    ]);
  });

  it("celular brasileiro sem o 9: o telefone ganha o 9 e o wa_id continua sendo a identidade", () => {
    const { messages } = parseWhatsApp(CHANNEL_ID, {
      messages: [{ from: "558699731647", id: "wamid.OLD1", timestamp, type: "text", text: { body: "Oi" } }],
    });
    expect(messages[0]).toMatchObject({ externalContactId: "558699731647", contactProfile: { phone: "+5586999731647" } });
  });

  it("lê mídia com legenda e localização", () => {
    const { messages } = parseWhatsApp(CHANNEL_ID, {
      messages: [
        { from, id: "wamid.IMG1", timestamp, type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "Veio assim" } },
        { from, id: "wamid.LOC1", timestamp, type: "location", location: { latitude: -23.55, longitude: -46.63, name: "Casa" } },
      ],
    });
    expect(messages[0]).toMatchObject({ type: "IMAGE", text: "Veio assim", media: { mimeType: "image/jpeg", externalMediaId: "MEDIA1" } });
    expect(messages[1]).toMatchObject({ type: "LOCATION", metadata: { location: { latitude: -23.55, longitude: -46.63, name: "Casa" } } });
  });

  it("ignora reações e avisa quando o tipo não é suportado", () => {
    const { messages } = parseWhatsApp(CHANNEL_ID, {
      messages: [
        { from, id: "wamid.R1", timestamp, type: "reaction", reaction: { message_id: "wamid.X", emoji: "👍" } },
        { from, id: "wamid.U1", timestamp, type: "unsupported" },
      ],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "TEXT", metadata: { unsupportedType: "unsupported" } });
  });

  it("converte status de entrega e falha, ignorando os desconhecidos", () => {
    const { statuses } = parseWhatsApp(CHANNEL_ID, {
      statuses: [
        { id: "wamid.OUT1", status: "delivered", timestamp, recipient_id: from },
        {
          id: "wamid.OUT2",
          status: "failed",
          timestamp,
          errors: [{ code: 131047, title: "Re-engagement message", message: "More than 24 hours have passed" }],
        },
        { id: "wamid.OUT3", status: "deleted", timestamp },
      ],
    });
    expect(statuses.map((s) => [s.externalMessageId, s.status, s.error])).toEqual([
      ["wamid.OUT1", "DELIVERED", undefined],
      ["wamid.OUT2", "FAILED", "More than 24 hours have passed"],
    ]);
  });

  it("separa um webhook da Meta por número e valida a assinatura", () => {
    const payload = metaPayload("PNID-1", { messages: [] });
    expect(splitMetaPayload(payload)).toEqual([{ channelType: "WHATSAPP", externalId: "PNID-1", value: expect.any(Object) }]);
    expect(splitMetaPayload({ object: "page", entry: [] })).toEqual([]);

    const raw = Buffer.from(JSON.stringify(payload));
    expect(verifyMetaSignature(raw, signMeta(raw.toString()), process.env.META_APP_SECRET ?? "")).toBe(true);
    expect(verifyMetaSignature(raw, "sha256=00", process.env.META_APP_SECRET ?? "")).toBe(false);
    expect(verifyMetaSignature(raw, undefined, process.env.META_APP_SECRET ?? "")).toBe(false);
  });
});
