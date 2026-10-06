import { blindIndex, encrypt, parseEncryptionKey } from "@comanda/database";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp, PASSWORD } from "./helpers.js";

const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("API da Inbox", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let colleague: { id: string };
  let outsider: { id: string };
  let maria: { id: string };
  let mariaChat: { id: string };
  let joaoChat: { id: string };
  let bChat: { id: string };
  let order: { id: string };
  let tenantToken: string;
  let masterToken: string;

  beforeAll(async () => {
    [app, fx] = await Promise.all([createTestApp(), createAuthFixture()]);
    const { a, b, c } = fx;
    const passwordHash = await hash(PASSWORD);
    colleague = await admin.user.create({
      data: { name: "Colega A", email: `colega-${a.id}@teste.local`, passwordHash, memberships: { create: { tenantId: a.id, role: "AGENT" } } },
      select: { id: true },
    });
    outsider = await admin.user.create({
      data: { name: "De Fora", email: `fora-${c.id}@teste.local`, passwordHash, memberships: { create: { tenantId: c.id, role: "AGENT" } } },
      select: { id: true },
    });
    const channel = (tenantId: string, type: "WHATSAPP" | "IFOOD") =>
      admin.channel.create({
        data: { tenantId, type, name: type, externalId: `${type}-${tenantId}`, credentials: new Uint8Array(), status: "CONNECTED" },
      });
    const [waA, ifoodA, waB] = await Promise.all([channel(a.id, "WHATSAPP"), channel(a.id, "IFOOD"), channel(b.id, "WHATSAPP")]);

    maria = await admin.contact.create({
      data: {
        tenantId: a.id,
        name: "Maria Oliveira",
        phone: "+5511976543210",
        cpfEncrypted: encrypt("12345678909", key),
        cpfHash: blindIndex("12345678909", key),
        identities: { create: { tenantId: a.id, channelType: "WHATSAPP", externalId: "5511976543210" } },
      },
    });
    mariaChat = await admin.conversation.create({
      data: { tenantId: a.id, contactId: maria.id, channelId: waA.id, status: "OPEN", unreadCount: 2, lastMessageAt: minutesAgo(1) },
    });
    order = await admin.order.create({
      data: {
        tenantId: a.id,
        contactId: maria.id,
        channelId: ifoodA.id,
        conversationId: mariaChat.id,
        externalOrderId: `o-${a.id}`,
        displayCode: "485329",
        status: "DISPATCHED",
        subtotal: "62.40",
        deliveryFee: "5.00",
        total: "67.40",
        placedAt: minutesAgo(30),
        raw: {},
        items: { create: { tenantId: a.id, name: "Lasanha Bolonhesa G", quantity: 1, unitPrice: "54.90" } },
      },
    });
    await admin.message.createMany({
      data: [
        { tenantId: a.id, conversationId: mariaChat.id, channelId: waA.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "Meu pedido não chegou" }, createdAt: minutesAgo(5) },
        { tenantId: a.id, conversationId: mariaChat.id, channelId: waA.id, direction: "INTERNAL", type: "SYSTEM", content: { event: "order", orderId: order.id }, createdAt: minutesAgo(4) },
        { tenantId: a.id, conversationId: mariaChat.id, channelId: waA.id, direction: "INTERNAL", type: "NOTE", content: { text: "nota que não aparece na prévia" }, createdAt: minutesAgo(1) },
      ],
    });

    const joao = await admin.contact.create({ data: { tenantId: a.id, name: "João Silva", phone: "+5511987654321" } });
    joaoChat = await admin.conversation.create({
      data: { tenantId: a.id, contactId: joao.id, channelId: waA.id, status: "PENDING", lastMessageAt: minutesAgo(10) },
    });
    const kenji = await admin.contact.create({ data: { tenantId: b.id, name: "Kenji Tanaka" } });
    bChat = await admin.conversation.create({
      data: { tenantId: b.id, contactId: kenji.id, channelId: waB.id, status: "OPEN", lastMessageAt: minutesAgo(3) },
    });
    await admin.quickReply.create({ data: { tenantId: a.id, shortcut: "atraso", content: "Já estou verificando." } });

    [tenantToken, masterToken] = await Promise.all([
      accessTokenFor(app, fx.user.email, a.id),
      accessTokenFor(app, fx.user.email, "master"),
    ]);
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [colleague?.id, outsider?.id].filter(Boolean) } } });
    await fx?.cleanup();
    await app?.close();
  });

  const get = (path: string, token = tenantToken) =>
    request(app.getHttpServer()).get(`/api${path}`).set("Authorization", `Bearer ${token}`);
  const send = (method: "post" | "patch", path: string, body: object = {}, token = tenantToken) =>
    request(app.getHttpServer())[method](`/api${path}`).set("Authorization", `Bearer ${token}`).send(body);

  it("lista só as conversas do restaurante, da mais recente para a mais antiga", async () => {
    const { body } = await get("/conversations").expect(200);
    expect(body.items.map((c: { id: string }) => c.id)).toEqual([mariaChat.id, joaoChat.id]);
    expect(body.items[0]).toMatchObject({
      tenant: { id: fx.a.id },
      unreadCount: 2,
      contact: { name: "Maria Oliveira" },
      channel: { type: "WHATSAPP" },
      orderCode: "485329",
      lastMessage: { preview: "Pedido do iFood" }, // a nota interna não entra na prévia
    });
  });

  it("no painel master lista os dois restaurantes e filtra por um deles", async () => {
    const all = await get("/conversations", masterToken).expect(200);
    expect(all.body.items.map((c: { id: string }) => c.id)).toEqual([mariaChat.id, bChat.id, joaoChat.id]);
    const onlyB = await get(`/conversations?tenantId=${fx.b.id}`, masterToken).expect(200);
    expect(onlyB.body.items.map((c: { id: string }) => c.id)).toEqual([bChat.id]);
    await get(`/conversations?tenantId=${fx.c.id}`, masterToken).expect(403);
  });

  it("filtra por status e conta por status", async () => {
    const pending = await get("/conversations?status=PENDING").expect(200);
    expect(pending.body.items.map((c: { id: string }) => c.id)).toEqual([joaoChat.id]);
    expect((await get("/conversations/counts").expect(200)).body).toEqual({ OPEN: 1, PENDING: 1, RESOLVED: 0, awaitingAgent: 0 });
  });

  it("busca por nome, telefone e CPF", async () => {
    const ids = async (search: string) =>
      (await get(`/conversations?search=${encodeURIComponent(search)}`).expect(200)).body.items.map((c: { id: string }) => c.id);
    expect(await ids("maria")).toEqual([mariaChat.id]);
    expect(await ids("(11) 98765")).toEqual([joaoChat.id]);
    expect(await ids("123.456.789-09")).toEqual([mariaChat.id]);
  });

  it("devolve as mensagens em ordem com os pedidos referenciados", async () => {
    const { body } = await get(`/conversations/${mariaChat.id}/messages`).expect(200);
    expect(body.messages.map((m: { type: string }) => m.type)).toEqual(["TEXT", "SYSTEM", "NOTE"]);
    expect(body.orders[order.id]).toMatchObject({
      channelType: "IFOOD",
      displayCode: "485329",
      total: "67.40",
      items: [{ name: "Lasanha Bolonhesa G", quantity: 1, unitPrice: "54.90" }],
    });
    await get(`/conversations/${bChat.id}/messages`).expect(404); // outro restaurante
  });

  it("nota interna fica na conversa e nunca vira envio", async () => {
    const { body } = await send("post", `/conversations/${mariaChat.id}/notes`, { text: "Ligar para o motoboy" }).expect(201);
    expect(body).toMatchObject({ type: "NOTE", direction: "INTERNAL", status: null, sentBy: { id: fx.user.id } });
  });

  it("reenvia uma mensagem que falhou, respeitando a janela de 24h", async () => {
    const chat = await admin.conversation.findUniqueOrThrow({ where: { id: mariaChat.id } });
    const failed = await admin.message.create({
      data: {
        tenantId: chat.tenantId,
        conversationId: chat.id,
        channelId: chat.channelId,
        direction: "OUTBOUND",
        type: "TEXT",
        status: "FAILED",
        statusError: "Falha temporária do canal",
        content: { text: "Seu pedido saiu para entrega" },
      },
    });
    const retry = () => send("post", `/conversations/${chat.id}/messages/${failed.id}/retry`);

    await admin.conversation.update({ where: { id: chat.id }, data: { windowExpiresAt: minutesAgo(1) } });
    expect((await retry().expect(422)).body.message).toBe("A janela de 24h para resposta livre terminou.");

    await admin.conversation.update({ where: { id: chat.id }, data: { windowExpiresAt: new Date(Date.now() + 3_600_000) } });
    const { body } = await retry().expect(200);
    expect(body).toMatchObject({ id: failed.id, status: "PENDING", statusError: null });
    await retry().expect(422); // já não está mais como falha
    await send("post", `/conversations/${bChat.id}/messages/${failed.id}/retry`).expect(404); // outro restaurante
  });

  it("marcar como lida zera as não lidas", async () => {
    await send("post", `/conversations/${mariaChat.id}/read`).expect(204);
    expect((await get(`/conversations/${mariaChat.id}`).expect(200)).body.unreadCount).toBe(0);
  });

  it("atribui só a quem atende no restaurante e resolve a conversa", async () => {
    const assigned = await send("patch", `/conversations/${mariaChat.id}`, { assignedUserId: colleague.id }).expect(200);
    expect(assigned.body.assignedUser).toEqual({ id: colleague.id, name: "Colega A" });
    const refused = await send("patch", `/conversations/${mariaChat.id}`, { assignedUserId: outsider.id }).expect(400);
    expect(refused.body.message).toBe("Esta pessoa não atende neste restaurante.");
    const resolved = await send("patch", `/conversations/${mariaChat.id}`, { status: "RESOLVED" }).expect(200);
    expect(resolved.body.status).toBe("RESOLVED");
    // A primeira aba da Inbox (ativas) traz abertas e pendentes; a resolvida fica só na aba dela.
    const active = await get("/conversations?status=ACTIVE").expect(200);
    expect(active.body.items.map((c: { id: string }) => c.id)).toEqual([joaoChat.id]);
    const done = await get("/conversations?status=RESOLVED").expect(200);
    expect(done.body.items.map((c: { id: string }) => c.id)).toEqual([mariaChat.id]);
  });

  it("lista membros do restaurante e respostas rápidas", async () => {
    const members = await get("/members").expect(200);
    expect(members.body.map((m: { name: string }) => m.name)).toEqual(["Atendente Teste", "Colega A"]);
    const replies = await get("/quick-replies").expect(200);
    expect(replies.body).toEqual([expect.objectContaining({ shortcut: "atraso", content: "Já estou verificando." })]);
  });

  it("painel do cliente: CPF mascarado, edição pelo atendente e CPF completo com auditoria", async () => {
    const detail = await get(`/contacts/${maria.id}`).expect(200);
    expect(detail.body).toMatchObject({
      cpfMasked: "***.456.789-**",
      metrics: { ordersCount: 1, ordersTotal: "67.4" },
      recentOrders: [{ displayCode: "485329", status: "DISPATCHED" }],
    });

    const updated = await send("patch", `/contacts/${maria.id}`, {
      phone: "+5511912345678",
      tags: ["VIP", "VIP", "sem glúten"],
    }).expect(200);
    expect(updated.body).toMatchObject({ phone: "+5511912345678", phoneSource: "agent", tags: ["VIP", "sem glúten"] });
    await send("patch", `/contacts/${maria.id}`, { cpf: "12345678900" }).expect(400);

    const revealed = await send("post", `/contacts/${maria.id}/cpf`).expect(200);
    expect(revealed.body).toEqual({ cpf: "12345678909" });
    const audit = await admin.auditLog.findFirst({ where: { entityId: maria.id, action: "contact.cpf_viewed" } });
    expect(audit).toMatchObject({ userId: fx.user.id, tenantId: fx.a.id });
  });
});
