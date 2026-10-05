import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { io } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  accessTokenFor,
  admin,
  createChannelFixture,
  createTestApp,
  drainQueues,
  metaPayload,
  postMetaWebhook,
  startMockGraph,
} from "./helpers.js";

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

describe("pipeline do WhatsApp", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let token: string;

  beforeAll(async () => {
    graph = await startMockGraph();
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", META_GRAPH_URL: graph.url });
    await app.listen(0); // o teste de realtime conecta via Socket.IO
    fx = await createChannelFixture();
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await graph?.close();
  });

  const textFrom = (waId: string, id: string, body: string, name = "Cliente Teste") =>
    metaPayload(fx.whatsapp.externalId, {
      contacts: [{ profile: { name }, wa_id: waId }],
      messages: [{ from: waId, id, timestamp: nowSeconds(), type: "text", text: { body } }],
    });

  it("verificação do webhook devolve o challenge só com o token certo", async () => {
    const query = { "hub.mode": "subscribe", "hub.challenge": "1158201444" };
    await request(app.getHttpServer())
      .get("/api/webhooks/meta")
      .query({ ...query, "hub.verify_token": process.env.META_WEBHOOK_VERIFY_TOKEN })
      .expect(200, "1158201444");
    await request(app.getHttpServer()).get("/api/webhooks/meta").query({ ...query, "hub.verify_token": "errado" }).expect(403);
  });

  it("recusa webhook sem assinatura válida", async () => {
    await request(app.getHttpServer()).post("/api/webhooks/meta").send(textFrom("5511900000000", "wamid.X", "oi")).expect(401);
    await request(app.getHttpServer())
      .post("/api/webhooks/meta")
      .set("X-Hub-Signature-256", "sha256=00")
      .send(textFrom("5511900000000", "wamid.X", "oi"))
      .expect(401);
  });

  it("mensagem recebida cria contato, conversa e mensagem; o webhook repetido não duplica", async () => {
    const payload = textFrom("5511911110001", "wamid.IN1", "Vocês têm opção sem glúten?", "João Silva");
    await postMetaWebhook(app, payload).expect(200, "EVENT_RECEIVED");
    await postMetaWebhook(app, payload).expect(200);
    await drainQueues(app);

    const messages = await admin.message.findMany({ where: { tenantId: fx.tenant.id, externalMessageId: "wamid.IN1" } });
    expect(messages).toHaveLength(1);
    const conversation = await admin.conversation.findUniqueOrThrow({
      where: { id: messages[0]!.conversationId },
      include: { contact: { include: { identities: true } }, messages: { orderBy: { createdAt: "asc" } } },
    });
    expect(conversation).toMatchObject({ status: "OPEN", unreadCount: 1, channelId: fx.whatsapp.id });
    expect(conversation.windowExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(conversation.contact).toMatchObject({ name: "João Silva", phone: "+5511911110001", phoneSource: "channel" });
    expect(conversation.contact.identities.map((i) => [i.channelType, i.externalId])).toEqual([["WHATSAPP", "5511911110001"]]);
    expect(conversation.messages.map((m) => [m.type, (m.content as { text?: string }).text])).toEqual([
      ["SYSTEM", "Conversa aberta via WhatsApp"],
      ["TEXT", "Vocês têm opção sem glúten?"],
      ["TEXT", expect.stringMatching(/^Olá, João! 👋 Em que podemos ajudar\?/)], // menu de atendimento
    ]);
  });

  it("nova mensagem do mesmo cliente cai na mesma conversa", async () => {
    await postMetaWebhook(app, textFrom("5511911110001", "wamid.IN2", "Alô?")).expect(200);
    await drainQueues(app);
    const conversations = await admin.conversation.findMany({
      where: { tenantId: fx.tenant.id, contact: { phone: "+5511911110001" } },
    });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.unreadCount).toBe(2);
  });

  it("SAIR registra o opt-out de campanhas e avisa na conversa", async () => {
    await postMetaWebhook(app, textFrom("5511911110009", "wamid.OPTOUT", "Sair.")).expect(200);
    await drainQueues(app);
    const contact = await admin.contact.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, phone: "+5511911110009" },
      include: { consents: true, conversations: { include: { messages: { orderBy: { createdAt: "asc" } } } } },
    });
    expect(contact.consents).toEqual([expect.objectContaining({ purpose: "marketing_whatsapp", granted: false })]);
    expect(contact.conversations[0]!.messages.at(-1)!.content).toMatchObject({ event: "opt_out" });
  });

  it("cliente que já existe com o mesmo telefone ganha a identidade do WhatsApp, sem duplicar", async () => {
    const existing = await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "Maria (cadastro manual)", phone: "+5511911110002", phoneSource: "agent" },
    });
    await postMetaWebhook(app, textFrom("5511911110002", "wamid.IN3", "Oi!", "Maria Perfil")).expect(200);
    await drainQueues(app);
    const contact = await admin.contact.findUniqueOrThrow({ where: { id: existing.id }, include: { identities: true } });
    expect(contact.name).toBe("Maria (cadastro manual)"); // o nome digitado pelo atendente prevalece
    expect(contact.identities).toHaveLength(1);
    expect(await admin.contact.count({ where: { tenantId: fx.tenant.id, phone: "+5511911110002" } })).toBe(1);
  });

  it("celular antigo sem o 9: o contato fica com o 9 e a resposta sai para esse número", async () => {
    await postMetaWebhook(app, textFrom("551191110003", "wamid.IN9", "Oi!", "Cliente Antigo")).expect(200);
    await drainQueues(app);
    const contact = await admin.contact.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, phone: "+5511991110003" },
      include: { identities: true, conversations: true },
    });
    expect(contact.identities[0]!.externalId).toBe("551191110003"); // o wa_id continua identificando o cliente

    await request(app.getHttpServer())
      .post(`/api/conversations/${contact.conversations[0]!.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Olá!" })
      .expect(201);
    await drainQueues(app);
    expect(graph.requests.at(-1)!.body).toMatchObject({ to: "5511991110003" });
  });

  it("resposta do atendente sai pela Graph API e o status só avança com os webhooks", async () => {
    const conversation = await admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, contact: { phone: "+5511911110001" } },
    });
    const { body: sent } = await request(app.getHttpServer())
      .post(`/api/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Temos sim! Lasanha sem glúten." })
      .expect(201);
    expect(sent).toMatchObject({ status: "PENDING", direction: "OUTBOUND", sentBy: { id: fx.user.id } });
    await drainQueues(app);

    const message = await admin.message.findUniqueOrThrow({ where: { id: sent.id } });
    expect(message.status).toBe("SENT");
    expect(graph.requests.at(-1)).toEqual({
      method: "POST",
      path: `/${fx.whatsapp.externalId}/messages`,
      authorization: "Bearer token-de-teste",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "5511911110001",
        type: "text",
        text: { body: "Temos sim! Lasanha sem glúten.", preview_url: false },
      },
    });
    expect((await admin.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).unreadCount).toBe(0);

    const status = (value: string) =>
      metaPayload(fx.whatsapp.externalId, {
        statuses: [{ id: message.externalMessageId, status: value, timestamp: nowSeconds(), recipient_id: "5511911110001" }],
      });
    await postMetaWebhook(app, status("read")).expect(200);
    await postMetaWebhook(app, status("delivered")).expect(200); // chega atrasado: não pode regredir
    await drainQueues(app);
    expect((await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("READ");
  });

  it("erro 4xx da Meta marca a mensagem como FAILED sem novas tentativas", async () => {
    const conversation = await admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, contact: { phone: "+5511911110001" } },
    });
    const before = graph.requests.length;
    graph.reply(() => ({ status: 400, body: { error: { message: "(#131030) Recipient phone number not in allowed list" } } }));
    try {
      const { body: sent } = await request(app.getHttpServer())
        .post(`/api/conversations/${conversation.id}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ text: "Vai falhar" })
        .expect(201);
      await drainQueues(app);
      expect(await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
        status: "FAILED",
        statusError: "(#131030) Recipient phone number not in allowed list",
      });
      expect(graph.requests.length - before).toBe(1);
    } finally {
      graph.resetReply();
    }
  });

  it("token recusado pela Meta marca o canal para reconectar; o reenvio que passa o devolve a conectado", async () => {
    const conversation = await admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, contact: { phone: "+5511911110001" } },
    });
    const channels = async () =>
      (await request(app.getHttpServer()).get("/api/channels").set("Authorization", `Bearer ${token}`).expect(200)).body as {
        id: string;
        status: string;
      }[];
    graph.reply(() => ({ status: 401, body: { error: { message: "Error validating access token", code: 190 } } }));
    let failedId = "";
    try {
      const { body: sent } = await request(app.getHttpServer())
        .post(`/api/conversations/${conversation.id}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ text: "Token vencido" })
        .expect(201);
      failedId = sent.id;
      await drainQueues(app);
      expect(await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({ status: "FAILED" });
      expect((await channels()).find((c) => c.id === fx.whatsapp.id)).toMatchObject({ status: "ERROR" });
      expect(JSON.stringify(await channels())).not.toContain("credentials");
    } finally {
      graph.resetReply();
    }

    // Admin reconectou (aqui, a Meta volta a aceitar): o "Tentar novamente" envia e o canal volta a conectado.
    await request(app.getHttpServer())
      .post(`/api/conversations/${conversation.id}/messages/${failedId}/retry`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await drainQueues(app);
    expect(await admin.message.findUniqueOrThrow({ where: { id: failedId } })).toMatchObject({ status: "SENT" });
    expect((await channels()).find((c) => c.id === fx.whatsapp.id)).toMatchObject({ status: "CONNECTED" });
  });

  it("não envia fora da janela de 24h nem em canal sem envio (iFood)", async () => {
    const contact = await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Sem janela" } });
    const closed = await admin.conversation.create({
      data: {
        tenantId: fx.tenant.id,
        contactId: contact.id,
        channelId: fx.whatsapp.id,
        status: "OPEN",
        windowExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const ifood = await admin.conversation.create({
      data: { tenantId: fx.tenant.id, contactId: contact.id, channelId: fx.ifood.id, status: "OPEN" },
    });
    const send = (id: string) =>
      request(app.getHttpServer())
        .post(`/api/conversations/${id}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ text: "Oi" });
    expect((await send(closed.id).expect(422)).body.message).toBe("A janela de 24h para resposta livre terminou.");
    expect((await send(ifood.id).expect(422)).body.message).toBe("Este canal não permite responder pelo Comanda.");
  });

  it("com a janela fechada, só sai template aprovado, com as variáveis", async () => {
    const contact = await admin.contact.create({
      data: {
        tenantId: fx.tenant.id,
        name: "Maria Template",
        identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: "5511933332222" } },
      },
    });
    const closed = await admin.conversation.create({
      data: { tenantId: fx.tenant.id, contactId: contact.id, channelId: fx.whatsapp.id, status: "OPEN", windowExpiresAt: new Date(Date.now() - 1) },
    });
    graph.reply((req) =>
      req.method === "GET" && req.path.startsWith("/waba-teste/message_templates")
        ? {
            status: 200,
            body: {
              data: [
                {
                  name: "retomar_atendimento",
                  language: "pt_BR",
                  category: "UTILITY",
                  status: "APPROVED",
                  components: [{ type: "BODY", text: "Olá, {{1}}! Podemos continuar seu atendimento?" }],
                },
              ],
            },
          }
        : { status: 200, body: { messages: [{ id: "wamid.TEMPLATE" }] } },
    );
    try {
      const api = (method: "get" | "post", path: string) =>
        request(app.getHttpServer())[method](`/api/conversations/${closed.id}${path}`).set("Authorization", `Bearer ${token}`);

      await api("post", "/messages").send({ text: "texto livre" }).expect(422);
      const templates = await api("get", "/templates").expect(200);
      expect(templates.body).toEqual([
        { name: "retomar_atendimento", language: "pt_BR", category: "UTILITY", body: "Olá, {{1}}! Podemos continuar seu atendimento?", variables: 1 },
      ]);

      const missing = await api("post", "/templates").send({ name: "retomar_atendimento", language: "pt_BR", variables: [] }).expect(400);
      expect(missing.body.message).toBe("Este template precisa de 1 variável(is).");

      const { body: sent } = await api("post", "/templates")
        .send({ name: "retomar_atendimento", language: "pt_BR", variables: ["Maria"] })
        .expect(201);
      expect(sent.content).toMatchObject({ text: "Olá, Maria! Podemos continuar seu atendimento?", template: { name: "retomar_atendimento" } });
      await drainQueues(app);

      expect((await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("SENT");
      expect(graph.requests.at(-1)!.body).toEqual({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "5511933332222",
        type: "template",
        template: {
          name: "retomar_atendimento",
          language: { code: "pt_BR" },
          components: [{ type: "body", parameters: [{ type: "text", text: "Maria" }] }],
        },
      });
    } finally {
      graph.resetReply();
    }
  });

  it("painel conectado recebe o aviso em tempo real", async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const socket = io(`http://127.0.0.1:${port}`, { auth: { token }, transports: ["websocket"] });
    const events: unknown[] = [];
    socket.on("inbox.changed", (event: unknown) => events.push(event));
    try {
      await vi.waitFor(() => expect(socket.connected).toBe(true), { timeout: 5_000 });
      await postMetaWebhook(app, textFrom("5511911110001", "wamid.IN4", "Chegou?")).expect(200);
      await vi.waitFor(() => expect(events).toContainEqual({ tenantId: fx.tenant.id, conversationId: expect.any(String) }), {
        timeout: 10_000,
      });
    } finally {
      socket.disconnect();
    }
  });

  it("socket sem token válido é desconectado", async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const socket = io(`http://127.0.0.1:${port}`, { auth: { token: "invalido" }, transports: ["websocket"] });
    try {
      await vi.waitFor(() => expect(socket.disconnected && !socket.active).toBe(true), { timeout: 5_000 });
    } finally {
      socket.disconnect();
    }
  });
});
