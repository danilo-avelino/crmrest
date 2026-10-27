import { randomInt } from "node:crypto";
import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorsService } from "../src/connectors/connectors.service.js";
import { EvolutionConnector } from "../src/connectors/evolution.connector.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp, drainQueues, startMockGraph } from "./helpers.js";

const WEBHOOK_TOKEN = "token-do-webhook-da-evolution";
const API_KEY = "chave-global-da-evolution";
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** Número de celular aleatório: o banco é o mesmo do dev e um número só pode estar em um restaurante. */
const randomNumber = () => `55869${String(randomInt(10_000_000, 99_999_999))}`;

describe("WhatsApp por QR Code (Evolution API)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let evolution: Awaited<ReturnType<typeof startMockGraph>>;
  let token: string;
  let channelId: string;
  const number = randomNumber();
  const instance = `instancia-${number}`;
  let sentCount = 0;

  // Resposta padrão da Evolution: o envio devolve o id da mensagem; o resto, um corpo vazio.
  const defaultReply = (req: { method: string; path: string }) =>
    req.path.startsWith("/message/sendText/")
      ? { status: 201, body: { key: { id: `3EB0SENT${++sentCount}`, fromMe: true }, status: "PENDING" } }
      : { status: 200, body: {} };

  beforeAll(async () => {
    evolution = await startMockGraph();
    evolution.reply(defaultReply);
    app = await createTestApp({
      CHANNELS_DRY_RUN: "false",
      EVOLUTION_API_URL: evolution.url,
      EVOLUTION_API_KEY: API_KEY,
      EVOLUTION_WEBHOOK_URL: "http://api.interna/api/webhooks/evolution",
      EVOLUTION_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    });
    fx = await createAuthFixture();
    token = await accessTokenFor(app, fx.user.email, fx.b.id);
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
    const accessToken = app.get(ConnectorsService).evolution.instanceToken(instance);
    const channel = await admin.channel.create({
      data: {
        tenantId: fx.b.id,
        type: "WHATSAPP",
        name: "WhatsApp QR",
        externalId: number,
        credentials: encrypt(JSON.stringify({ accessToken, instance }), key),
        status: "CONNECTED",
      },
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await evolution?.close();
  });

  const webhook = (payload: unknown, secret: string | null = WEBHOOK_TOKEN) => {
    const call = request(app.getHttpServer()).post("/api/webhooks/evolution");
    return (secret === null ? call : call.set("x-dishdesk-token", secret)).send(payload as object);
  };
  const envelope = (event: string, data: unknown, from = instance) => ({ event, instance: from, sender: `${number}@s.whatsapp.net`, data });
  const textFrom = (customer: string, id: string, text: string, from = instance) =>
    envelope(
      "messages.upsert",
      {
        key: { id, remoteJid: `${customer}@s.whatsapp.net`, fromMe: false },
        pushName: "Cliente QR",
        messageType: "conversation",
        messageTimestamp: nowSeconds(),
        message: { conversation: text },
      },
      from,
    );
  const api = () => request(app.getHttpServer());

  it("recusa webhook sem o token da Evolution", async () => {
    await webhook(textFrom("5511922220000", "3EB0X", "oi"), null).expect(401);
    await webhook(textFrom("5511922220000", "3EB0X", "oi"), "errado").expect(401);
  });

  it("mensagem recebida vira conversa; evento de outra instância do mesmo número é ignorado", async () => {
    await webhook(textFrom("5511922220001", "3EB0IN1", "Tem mesa para hoje?")).expect(200, "EVENT_RECEIVED");
    await webhook(textFrom("5511922220002", "3EB0OLD", "instância antiga", "instancia-antiga")).expect(200);
    await drainQueues(app);

    const conversation = await admin.conversation.findFirstOrThrow({
      where: { channelId },
      include: { contact: { include: { identities: true } }, messages: true },
    });
    expect(conversation.windowExpiresAt).toBeNull();
    expect(conversation.contact).toMatchObject({ name: "Cliente QR", phone: "+5511922220001" });
    expect(conversation.contact.identities.map((i) => [i.channelType, i.externalId])).toEqual([["WHATSAPP", "5511922220001"]]);
    expect(conversation.messages.some((m) => m.externalMessageId === "3EB0IN1")).toBe(true);
    expect(await admin.message.count({ where: { channelId, externalMessageId: "3EB0OLD" } })).toBe(0);
  });

  it("resposta sai pela instância, com o token dela, e o status avança com os webhooks", async () => {
    const conversation = await admin.conversation.findFirstOrThrow({ where: { channelId, contact: { phone: "+5511922220001" } } });
    const { body: sent } = await api()
      .post(`/api/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Temos sim, às 20h." })
      .expect(201);
    await drainQueues(app);

    const message = await admin.message.findUniqueOrThrow({ where: { id: sent.id } });
    expect(message.status).toBe("SENT");
    expect(evolution.requests.at(-1)).toEqual({
      method: "POST",
      path: `/message/sendText/${instance}`,
      apikey: new EvolutionConnector({ EVOLUTION_API_KEY: API_KEY, CHANNELS_DRY_RUN: false }).instanceToken(instance),
      body: { number: "5511922220001", text: "Temos sim, às 20h." },
    });

    const status = (value: string) =>
      envelope("messages.update", { keyId: message.externalMessageId, remoteJid: "5511922220001@s.whatsapp.net", fromMe: true, status: value });
    await webhook(status("READ")).expect(200);
    await webhook(status("DELIVERY_ACK")).expect(200); // chega atrasado: não pode regredir
    await drainQueues(app);
    expect((await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("READ");
  });

  it("número que não tem WhatsApp: a mensagem falha na hora, com o motivo", async () => {
    const conversation = await admin.conversation.findFirstOrThrow({ where: { channelId, contact: { phone: "+5511922220001" } } });
    evolution.reply((req) =>
      req.path.startsWith("/message/sendText/")
        ? { status: 400, body: { status: 400, error: "Bad Request", response: { message: [{ exists: false, jid: "x", number: "x" }] } } }
        : defaultReply(req),
    );
    try {
      const { body: sent } = await api()
        .post(`/api/conversations/${conversation.id}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ text: "Oi" })
        .expect(201);
      await drainQueues(app);
      expect(await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
        status: "FAILED",
        statusError: "Evolution: o número não tem WhatsApp.",
      });
    } finally {
      evolution.reply(defaultReply);
    }
  });

  it("desconectado no celular: o canal fica com erro; conectado de novo, volta", async () => {
    await webhook(envelope("connection.update", { instance, state: "close", statusReason: 401 })).expect(200);
    await drainQueues(app);
    expect((await admin.channel.findUniqueOrThrow({ where: { id: channelId } })).status).toBe("ERROR");
    await webhook(envelope("connection.update", { instance, state: "open", statusReason: 200 })).expect(200);
    await drainQueues(app);
    expect((await admin.channel.findUniqueOrThrow({ where: { id: channelId } })).status).toBe("CONNECTED");
  });

  it("foto recebida: a API busca o arquivo na Evolution pelo id da mensagem", async () => {
    await webhook(
      envelope("messages.upsert", {
        key: { id: "3EB0FOTO", remoteJid: "5511922220001@s.whatsapp.net", fromMe: false },
        pushName: "Cliente QR",
        messageType: "imageMessage",
        messageTimestamp: nowSeconds(),
        message: { imageMessage: { mimetype: "image/jpeg" } },
      }),
    ).expect(200);
    await drainQueues(app);
    const photo = await admin.message.findFirstOrThrow({ where: { channelId, externalMessageId: "3EB0FOTO" } });
    evolution.reply((req) =>
      req.path === `/chat/getBase64FromMediaMessage/${instance}`
        ? { status: 201, body: { base64: Buffer.from("bytes-da-foto").toString("base64"), mimetype: "image/jpeg" } }
        : defaultReply(req),
    );
    try {
      const response = await api()
        .get(`/api/conversations/${photo.conversationId}/messages/${photo.id}/media`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(response.headers["content-type"]).toBe("image/jpeg");
      expect((response.body as Buffer).toString()).toBe("bytes-da-foto");
      expect(evolution.requests.at(-1)!.body).toEqual({ message: { key: { id: "3EB0FOTO" } } });
    } finally {
      evolution.reply(defaultReply);
    }
  });

  it("QR Code: cria a instância com o webhook, troca o QR e, com o número conectado, vira a integração", async () => {
    const owner = randomNumber();
    let state = "connecting";
    evolution.reply((req) => {
      if (req.path === "/instance/create") return { status: 201, body: { instance: {}, hash: "x", qrcode: { base64: "data:image/png;base64,QR1" } } };
      if (req.path.startsWith("/instance/connectionState/")) return { status: 200, body: { instance: { state } } };
      if (req.path.startsWith("/instance/connect/")) return { status: 200, body: { base64: "data:image/png;base64,QR2", count: 2 } };
      if (req.path.startsWith("/instance/fetchInstances")) return { status: 200, body: [{ ownerJid: `${owner}@s.whatsapp.net`, profileName: "Lanches QR" }] };
      return defaultReply(req);
    });
    try {
      const { body: started } = await api().post(`/api/integrations/${fx.b.id}/whatsapp/qr`).set("Authorization", `Bearer ${token}`).expect(201);
      expect(started).toMatchObject({ status: "waiting", qr: "data:image/png;base64,QR1" });
      const session = started.session as string;
      expect(session.startsWith(`${fx.b.id}-`)).toBe(true);
      const created = evolution.requests.find((r) => r.path === "/instance/create")!;
      const connector = new EvolutionConnector({ EVOLUTION_API_KEY: API_KEY, CHANNELS_DRY_RUN: false });
      expect(created).toMatchObject({
        method: "POST",
        apikey: API_KEY,
        body: {
          instanceName: session,
          token: connector.instanceToken(session),
          integration: "WHATSAPP-BAILEYS",
          webhook: {
            url: "http://api.interna/api/webhooks/evolution",
            headers: { "x-dishdesk-token": WEBHOOK_TOKEN },
            events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"],
          },
        },
      });

      const poll = () => api().get(`/api/integrations/${fx.b.id}/whatsapp/qr/${session}`).set("Authorization", `Bearer ${token}`);
      expect((await poll().expect(200)).body).toEqual({ status: "waiting", session, qr: "data:image/png;base64,QR2" });

      state = "open";
      const { body: done } = await poll().expect(200);
      expect(done).toMatchObject({ status: "connected", session, integration: { type: "WHATSAPP", externalId: owner, status: "CONNECTED" } });
      expect(done.integration.name).toMatch(/^Lanches QR \(\(86\) 9/);
      const channel = await admin.channel.findUniqueOrThrow({ where: { id: done.integration.id } });
      expect(app.get(ConnectorsService).secrets(channel.credentials)).toMatchObject({ instance: session, accessToken: connector.instanceToken(session) });

      // Fechar o modal depois de conectar não apaga a instância do número conectado.
      const before = evolution.requests.length;
      await api().delete(`/api/integrations/${fx.b.id}/whatsapp/qr/${session}`).set("Authorization", `Bearer ${token}`).expect(204);
      expect(evolution.requests.slice(before).some((r) => r.method === "DELETE")).toBe(false);

      // Desconectar apaga a instância: o aparelho sai do celular do restaurante.
      await api().post(`/api/integrations/${fx.b.id}/${channel.id}/disconnect`).set("Authorization", `Bearer ${token}`).expect(201);
      expect(evolution.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/instance/delete/${session}` });
    } finally {
      evolution.reply(defaultReply);
    }
  });

  it("QR Code de um número que está em outro restaurante: o número vem para cá e a instância de lá é apagada", async () => {
    const owner = randomNumber();
    const theirs = await admin.channel.create({
      data: {
        tenantId: fx.a.id,
        type: "WHATSAPP",
        name: "WhatsApp de lá",
        externalId: owner,
        credentials: encrypt(JSON.stringify({ accessToken: "token-antigo", instance: "instancia-de-la" }), parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")),
        status: "CONNECTED",
      },
    });
    evolution.reply((req) => {
      if (req.path === "/instance/create") return { status: 201, body: { instance: {}, hash: "x", qrcode: { base64: "data:image/png;base64,QR1" } } };
      if (req.path.startsWith("/instance/connectionState/")) return { status: 200, body: { instance: { state: "open" } } };
      if (req.path.startsWith("/instance/fetchInstances")) return { status: 200, body: [{ ownerJid: `${owner}@s.whatsapp.net`, profileName: "Lanches QR" }] };
      return defaultReply(req);
    });
    try {
      const { body: started } = await api().post(`/api/integrations/${fx.b.id}/whatsapp/qr`).set("Authorization", `Bearer ${token}`).expect(201);
      const { body: done } = await api().get(`/api/integrations/${fx.b.id}/whatsapp/qr/${started.session}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(done).toMatchObject({ status: "connected", integration: { externalId: owner, status: "CONNECTED" } });
      expect(await admin.channel.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({
        tenantId: fx.a.id,
        externalId: `${owner}#${theirs.id}`,
        status: "DISCONNECTED",
      });
      expect(evolution.requests.some((r) => r.method === "DELETE" && r.path === "/instance/delete/instancia-de-la")).toBe(true);
    } finally {
      evolution.reply(defaultReply);
    }
  });

  it("QR Code: fechar sem conectar apaga a tentativa; tentativa de outro restaurante não é encontrada", async () => {
    const { body: started } = await api().post(`/api/integrations/${fx.b.id}/whatsapp/qr`).set("Authorization", `Bearer ${token}`).expect(201);
    await api().delete(`/api/integrations/${fx.b.id}/whatsapp/qr/${started.session}`).set("Authorization", `Bearer ${token}`).expect(204);
    expect(evolution.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/instance/delete/${started.session}` });

    const foreign = `${fx.a.id}-0123456789ab`;
    await api().get(`/api/integrations/${fx.b.id}/whatsapp/qr/${foreign}`).set("Authorization", `Bearer ${token}`).expect(404);
    await api().get(`/api/integrations/${fx.b.id}/whatsapp/qr/invalida`).set("Authorization", `Bearer ${token}`).expect(400);
  });
});
