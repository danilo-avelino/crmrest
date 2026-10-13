import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IFOOD_CHAT_WAIT_MS, OutboundProcessor } from "../src/outbound/outbound.processor.js";
import { type OutboundJob, QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createAuthFixture, createChannelFixture, createTestApp } from "./helpers.js";

const CLOCK = new Intl.DateTimeFormat("pt-BR", { timeStyle: "medium", timeZone: "America/Sao_Paulo" });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
/** Mensagem como o widget mostra: só a hora. */
const shown = (direction: "INBOUND" | "OUTBOUND", text: string, at: Date) => ({ direction, text, time: CLOCK.format(at) });

describe("Chat do iFood na Inbox (trava IFOOD_CHAT_BRIDGE ligada)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let other: Awaited<ReturnType<typeof createAuthFixture>>;
  let token: string;
  let order: { id: string; contactId: string };
  const post = (path: string, body?: object, bearer = token) =>
    request(app.getHttpServer()).post(`/api${path}`).set("Authorization", `Bearer ${bearer}`).send(body);
  const timeline = (conversationId: string) =>
    admin.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" }, select: { id: true, direction: true, status: true, content: true } });
  const conversation = () => admin.conversation.findFirstOrThrow({ where: { tenantId: fx.tenant.id, channelId: fx.ifood.id } });

  beforeAll(async () => {
    [app, fx, other] = await Promise.all([
      createTestApp({ IFOOD_WIDGET_ID: "widget-teste", IFOOD_CHAT_BRIDGE: "true" }),
      createChannelFixture(),
      createAuthFixture(),
    ]);
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const contact = await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "Carlos Mendes", identities: { create: { tenantId: fx.tenant.id, channelType: "IFOOD", externalId: "cliente-carlos" } } },
    });
    order = await admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId: contact.id,
        channelId: fx.ifood.id,
        externalOrderId: randomUUID(),
        displayCode: "6530",
        status: "CONFIRMED",
        subtotal: 40,
        deliveryFee: 5,
        total: 45,
        placedAt: minutesAgo(20),
        raw: {},
      },
      select: { id: true, contactId: true },
    });
  });

  afterAll(async () => {
    // As respostas ficam um minuto na fila à espera de um painel: saem daqui para não segurar os testes seguintes.
    for (const job of await app.get<Queue>(getQueueToken(QUEUES.outbound)).getDelayed()) await job.remove();
    await fx?.cleanup();
    await other?.cleanup();
    await app?.close();
  });

  it("o widget informa que o chat vai para a Inbox", async () => {
    const { body } = await request(app.getHttpServer()).get("/api/ifood-widget").set("Authorization", `Bearer ${token}`).expect(200);
    expect(body).toEqual({ widgetId: "widget-teste", merchantIds: [fx.ifood.externalId], chat: true });
  });

  it("conversa lida do widget: abre a conversa do cliente com o pedido e as mensagens, sem repetir na leitura seguinte", async () => {
    const automatic = shown("OUTBOUND", "Recebemos o seu pedido!", minutesAgo(19));
    const question = shown("INBOUND", "Oi, pode mandar sem cebola?", minutesAgo(10));
    await post("/ifood-chat/sync", { orderCode: "6530", messages: [automatic, question] }).expect(204);

    const chat = await conversation();
    expect(chat).toMatchObject({ contactId: order.contactId, status: "OPEN", unreadCount: 1 });
    expect((await timeline(chat.id)).map((m) => [m.direction, m.status, m.content])).toEqual([
      ["INTERNAL", null, { event: "conversation_opened", text: "Conversa aberta via iFood" }],
      ["INTERNAL", null, { event: "order", orderId: order.id }],
      ["OUTBOUND", "SENT", { text: "Recebemos o seu pedido!" }],
      ["INBOUND", "DELIVERED", { text: "Oi, pode mandar sem cebola?" }],
    ]);
    expect((await admin.order.findUniqueOrThrow({ where: { id: order.id } })).conversationId).toBe(chat.id);

    // A mesma conversa de novo, com uma mensagem nova no fim.
    const second = shown("INBOUND", "E sem picles", minutesAgo(9));
    await post("/ifood-chat/sync", { orderCode: "6530", messages: [automatic, question, second] }).expect(204);
    expect(await timeline(chat.id)).toHaveLength(5);
    expect(await conversation()).toMatchObject({ id: chat.id, unreadCount: 2 });
  });

  it("pedido que ainda não chegou pelo polling, ou de outro restaurante: nada é gravado", async () => {
    await post("/ifood-chat/sync", { orderCode: "9999", messages: [shown("INBOUND", "Olá", new Date())] }).expect(204);
    const outsider = await accessTokenFor(app, other.user.email, other.a.id);
    await post("/ifood-chat/sync", { orderCode: "6530", messages: [shown("INBOUND", "Invasor", new Date())] }, outsider).expect(204);
    expect(await admin.message.count({ where: { tenantId: fx.tenant.id, content: { path: ["text"], equals: "Invasor" } } })).toBe(0);
    expect(await admin.conversation.count({ where: { tenantId: fx.tenant.id, channelId: fx.ifood.id } })).toBe(1);
  });

  it("resposta pela Inbox: fica pendente, um painel só a pega, e a conversa lida do widget confirma sem duplicar", async () => {
    const chat = await conversation();
    const { body: sent } = await post(`/conversations/${chat.id}/messages`, { text: "Pode sim, sem cebola e sem picles." }).expect(201);
    expect(sent).toMatchObject({ direction: "OUTBOUND", status: "PENDING" });

    const { body: claimed } = await post("/ifood-chat/outbox/claim").expect(200);
    expect(claimed).toEqual([{ messageId: sent.id, conversationId: chat.id, orderCode: "6530", text: "Pode sim, sem cebola e sem picles." }]);
    expect((await post("/ifood-chat/outbox/claim").expect(200)).body).toEqual([]); // outro painel não leva a mesma

    await post(`/ifood-chat/outbox/${sent.id}`, { status: "SENT" }).expect(204);
    expect(await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({ status: "SENT" });

    // O widget passa a mostrar a resposta: ela já está na conversa.
    await post("/ifood-chat/sync", { orderCode: "6530", messages: [shown("OUTBOUND", "Pode sim, sem cebola e sem picles.", new Date())] }).expect(204);
    const replies = (await timeline(chat.id)).filter((m) => (m.content as { text?: string }).text === "Pode sim, sem cebola e sem picles.");
    expect(replies).toHaveLength(1);
    const confirmed = await admin.message.findUniqueOrThrow({ where: { id: sent.id } });
    expect(confirmed.externalMessageId).toMatch(/^ifood-chat:/);
    expect(await conversation()).toMatchObject({ unreadCount: 0 }); // responder leu a conversa
  });

  it("nenhum painel com a extensão: a resposta falha depois da espera e pode ser reenviada", async () => {
    const chat = await conversation();
    const { body: sent } = await post(`/conversations/${chat.id}/messages`, { text: "Saiu para entrega!" }).expect(201);
    const job = { data: { tenantId: fx.tenant.id, messageId: sent.id }, timestamp: Date.now() - IFOOD_CHAT_WAIT_MS - 1, attemptsMade: 0, opts: {} };
    await app.get(OutboundProcessor).process(job as Job<OutboundJob>);
    expect(await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
      status: "FAILED",
      statusError: "Nenhum painel com a extensão do iFood aberta enviou a mensagem.",
    });

    await post(`/conversations/${chat.id}/messages/${sent.id}/retry`).expect(200);
    const { body: claimed } = await post("/ifood-chat/outbox/claim").expect(200);
    expect(claimed.map((item: { messageId: string }) => item.messageId)).toEqual([sent.id]);
    await post(`/ifood-chat/outbox/${sent.id}`, { status: "FAILED", error: "O chat deste pedido não está mais aberto no iFood." }).expect(204);
    expect(await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
      status: "FAILED",
      statusError: "O chat deste pedido não está mais aberto no iFood.",
    });
  });
});
