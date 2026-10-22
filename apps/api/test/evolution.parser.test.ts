import { describe, expect, it } from "vitest";
import { contactIdFromJid, evolutionConnection, parseEvolution, splitEvolutionPayload } from "../src/connectors/evolution.connector.js";

const CHANNEL_ID = "01a10330-b8c8-750e-95d2-fcb1c581d8de";
const messageTimestamp = 1791052800; // 2026-10-03T18:40:00Z

const upsert = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  key: { id: "3EB0TEXT1", remoteJid: "5511987654321@s.whatsapp.net", fromMe: false },
  pushName: "João Silva",
  messageType: "conversation",
  messageTimestamp,
  message,
  ...extra,
});

describe("webhook da Evolution", () => {
  it("lê texto com o nome e o telefone do perfil", () => {
    const { messages } = parseEvolution(CHANNEL_ID, "messages.upsert", upsert({ conversation: "Vocês têm opção sem glúten?" }));
    expect(messages).toEqual([
      {
        channelId: CHANNEL_ID,
        channelType: "WHATSAPP",
        externalMessageId: "3EB0TEXT1",
        externalContactId: "5511987654321",
        direction: "INBOUND",
        type: "TEXT",
        text: "Vocês têm opção sem glúten?",
        contactProfile: { name: "João Silva", phone: "+5511987654321" },
        timestamp: new Date("2026-10-03T18:40:00.000Z"),
      },
    ]);
  });

  it("número escondido (@lid): usa o número que a Evolution informa ou, sem ele, o jid como identidade", () => {
    const withAlt = upsert({ conversation: "Oi" }, { key: { id: "A1", remoteJid: "123456789@lid", remoteJidAlt: "558699731647@s.whatsapp.net", fromMe: false } });
    expect(parseEvolution(CHANNEL_ID, "messages.upsert", withAlt).messages[0]).toMatchObject({
      externalContactId: "558699731647",
      contactProfile: { phone: "+5586999731647" },
    });
    const hidden = upsert({ conversation: "Oi" }, { key: { id: "A2", remoteJid: "123456789@lid", fromMe: false } });
    const [message] = parseEvolution(CHANNEL_ID, "messages.upsert", hidden).messages;
    expect(message).toMatchObject({ externalContactId: "123456789@lid" });
    expect(message!.contactProfile?.phone).toBeUndefined();
  });

  it("lê mídia com legenda e localização", () => {
    const image = upsert({ imageMessage: { mimetype: "image/jpeg", caption: "Olha isso" } }, { messageType: "imageMessage" });
    expect(parseEvolution(CHANNEL_ID, "messages.upsert", image).messages[0]).toMatchObject({
      type: "IMAGE",
      text: "Olha isso",
      media: { mimeType: "image/jpeg", externalMediaId: "3EB0TEXT1" },
    });
    const location = upsert(
      { locationMessage: { degreesLatitude: -5.08, degreesLongitude: -42.8, name: "Casa" } },
      { messageType: "locationMessage" },
    );
    expect(parseEvolution(CHANNEL_ID, "messages.upsert", location).messages[0]).toMatchObject({
      type: "LOCATION",
      metadata: { location: { latitude: -5.08, longitude: -42.8, name: "Casa" } },
    });
  });

  it("ignora mensagens do próprio restaurante, de grupos e reações", () => {
    const parse = (data: unknown) => parseEvolution(CHANNEL_ID, "messages.upsert", data);
    expect(parse(upsert({ conversation: "Oi" }, { key: { id: "M1", remoteJid: "5511987654321@s.whatsapp.net", fromMe: true } })).messages).toEqual([]);
    expect(parse(upsert({ conversation: "Oi" }, { key: { id: "M2", remoteJid: "1203630@g.us", fromMe: false } })).messages).toEqual([]);
    expect(parse(upsert({ reactionMessage: { text: "👍" } }, { messageType: "reactionMessage" })).messages).toEqual([]);
  });

  it("tipo desconhecido vira um aviso legível", () => {
    const { messages } = parseEvolution(CHANNEL_ID, "messages.upsert", upsert({ contactMessage: {} }, { messageType: "contactMessage" }));
    expect(messages[0]).toMatchObject({ type: "TEXT", metadata: { unsupportedType: "contactMessage" } });
  });

  it("status das mensagens enviadas: entregue, lida e ouvida", () => {
    const status = (value: string, fromMe = true) =>
      parseEvolution(CHANNEL_ID, "messages.update", { keyId: "3EB0OUT1", remoteJid: "5511987654321@s.whatsapp.net", fromMe, status: value }).statuses;
    expect(status("DELIVERY_ACK")).toMatchObject([{ externalMessageId: "3EB0OUT1", status: "DELIVERED" }]);
    expect(status("READ")[0]!.status).toBe("READ");
    expect(status("PLAYED")[0]!.status).toBe("READ");
    expect(status("READ", false)).toEqual([]); // o restaurante leu a mensagem do cliente: não é status de envio
  });

  it("separa a instância e o número do envelope; conexão aberta ou encerrada", () => {
    expect(splitEvolutionPayload({ event: "messages.upsert", instance: "inst", sender: "5586999990000@s.whatsapp.net", data: {} })).toEqual({
      instance: "inst",
      externalId: "5586999990000",
      event: "messages.upsert",
      data: {},
    });
    expect(splitEvolutionPayload({ event: "qrcode.updated", instance: "inst", data: {} })?.externalId).toBeNull();
    expect(splitEvolutionPayload("lixo")).toBeNull();
    expect(evolutionConnection("connection.update", { state: "open" })).toBe("open");
    expect(evolutionConnection("connection.update", { state: "close", statusReason: 401 })).toBe("close");
    expect(evolutionConnection("connection.update", { state: "connecting" })).toBeNull();
    expect(contactIdFromJid("5586999990000:12@s.whatsapp.net")).toBe("5586999990000");
  });
});
