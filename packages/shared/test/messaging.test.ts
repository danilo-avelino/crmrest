import { describe, expect, it } from "vitest";
import { NormalizedMessage, StatusUpdate } from "../src/index.js";

const message = {
  channelId: "01a10330-b8c8-750e-95d2-fcb1c581d8de",
  channelType: "WHATSAPP",
  externalMessageId: "wamid.HBgNNTUxMTk3NjU0MzIxMBUCABIYFjNFQjA",
  externalContactId: "5511976543210",
  direction: "INBOUND",
  type: "TEXT",
  text: "Meu pedido ainda não chegou",
  contactProfile: { name: "Maria Oliveira", phone: "+5511976543210" },
  timestamp: new Date("2026-10-03T19:07:00.000Z"),
} satisfies NormalizedMessage;

describe("NormalizedMessage", () => {
  it("sobrevive à ida e volta pela fila (JSON), com a data reconstruída", () => {
    const fromQueue = NormalizedMessage.parse(JSON.parse(JSON.stringify(message)));
    expect(fromQueue).toEqual(message);
    expect(fromQueue.timestamp).toBeInstanceOf(Date);
  });

  it("rejeita dados de contato fora do formato normalizado", () => {
    for (const contactProfile of [
      { phone: "(11) 97654-3210" }, // telefone sem E.164
      { cpf: "123.456.789-09" }, // CPF com máscara
      { email: "maria" },
    ]) {
      expect(NormalizedMessage.safeParse({ ...message, contactProfile }).success, JSON.stringify(contactProfile)).toBe(
        false,
      );
    }
  });

  it("aceita só os valores de enum do banco", () => {
    expect(NormalizedMessage.safeParse({ ...message, channelType: "whatsapp" }).success).toBe(false);
  });
});

describe("StatusUpdate", () => {
  it("não aceita PENDING vindo do canal", () => {
    const update = {
      channelId: message.channelId,
      channelType: "WHATSAPP",
      externalMessageId: message.externalMessageId,
      status: "READ",
      timestamp: message.timestamp,
    } satisfies StatusUpdate;
    expect(StatusUpdate.safeParse(update).success).toBe(true);
    expect(StatusUpdate.safeParse({ ...update, status: "PENDING" }).success).toBe(false);
  });
});
