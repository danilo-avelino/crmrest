import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CardapioWebService } from "../src/inbound/cardapio-web.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp, startMockGraph } from "./helpers.js";

/** API de parceiros falsa: polling, detalhes, cancelar e o histórico de pedidos. */
async function startMockCardapioWeb() {
  const state = {
    updated: [] as object[],
    orders: {} as Record<string, object>,
    canceled: [] as { id: string; body: string }[],
    refuseCancel: false,
    /** Pedidos do histórico, por início do período (AAAA-MM); sem a chave, a API recusa o período. */
    history: new Map<string, object[]>(),
    historyRequests: [] as string[],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://cardapio.web");
    const json = (status: number, body?: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.headers["x-api-key"] !== "chave-da-loja") return json(401);
      if (url.pathname === "/api/partner/v1/orders") return json(200, state.updated);
      if (url.pathname === "/api/partner/v1/orders/history") {
        state.historyRequests.push(url.search);
        const period = (url.searchParams.get("start_date") ?? "").slice(0, 7);
        const orders = state.history.get(period);
        if (!orders) return json(400, { code: 4000, message: "Período inválido." });
        return json(200, { orders, pagination: { current_page: 1, total_pages: 1, total_orders: orders.length } });
      }
      const cancel = url.pathname.match(/^\/api\/partner\/v1\/orders\/(\d+)\/cancel$/)?.[1];
      if (cancel && req.method === "POST") {
        if (state.refuseCancel) return json(400, { code: 4003, message: "Transição não permitida." });
        state.canceled.push({ id: cancel, body: Buffer.concat(chunks).toString() });
        return json(204);
      }
      const id = url.pathname.match(/^\/api\/partner\/v1\/orders\/(\d+)$/)?.[1];
      if (id) return state.orders[id] ? json(200, state.orders[id]) : json(404);
      return json(404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ADDRESS = { street: "Rua das Acácias", number: "120", neighborhood: "Vila Mariana", city: "São Paulo", state: "SP", complement: "Cond. Jardim Sul, Bloco B, apto 34" };

const cwOrder = (id: number, phone: string, name: string, extra: object = {}) => ({
  id,
  display_id: id,
  status: "confirmed",
  order_type: "delivery",
  sales_channel: "catalog",
  delivery_fee: 6,
  total: 51.8,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  customer: { id: Number(phone.slice(-6)), name, phone, ddi: "55" },
  delivery_address: ADDRESS,
  items: [{ name: "Pizza calabresa G", quantity: 1, total_price: 45.8 }],
  ...extra,
});

describe("prevenção de fraude", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let cardapioWeb: Awaited<ReturnType<typeof startMockCardapioWeb>>;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let service: CardapioWebService;
  let channelId: string;
  let token: string;

  const api = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const arrives = async (order: { id: number; status?: string }, status = order.status ?? "confirmed") => {
    cardapioWeb.state.orders[String(order.id)] = { ...order, status };
    cardapioWeb.state.updated = [{ id: order.id, status, sales_channel: "catalog", updated_at: new Date().toISOString() }];
    await service.poll();
    return admin.order.findFirstOrThrow({ where: { channelId, externalOrderId: String(order.id) } });
  };
  const events = async (conversationId: string) =>
    (await admin.message.findMany({ where: { conversationId, direction: "INTERNAL", type: "SYSTEM" }, orderBy: { createdAt: "asc" } }))
      .map((m) => m.content as { event?: string; text?: string })
      .filter((c) => c.event !== "order")
      .map((c) => c.text);
  const listed = async (orderId: string) => {
    const { body } = await api().get("/api/orders?period=7d").set(auth()).expect(200);
    return body.items.find((o: { id: string }) => o.id === orderId);
  };

  beforeAll(async () => {
    cardapioWeb = await startMockCardapioWeb();
    graph = await startMockGraph();
    app = await createTestApp({ CARDAPIO_WEB_API_URL: cardapioWeb.url, CHANNELS_DRY_RUN: "true", META_GRAPH_URL: graph.url });
    await app.get<Queue>(getQueueToken(QUEUES.cardapioWeb)).removeJobScheduler("cardapio-web-polling");
    service = app.get(CardapioWebService);
    fx = await createChannelFixture();
    channelId = (
      await admin.channel.create({
        data: {
          tenantId: fx.tenant.id,
          type: "CARDAPIO_WEB",
          name: "Cardápio Web",
          externalId: `loja-${fx.tenant.id}`,
          credentials: encrypt(JSON.stringify({ accessToken: "chave-da-loja" }), parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")),
          status: "CONNECTED",
        },
      })
    ).id;
    // O restaurante também é administrado por quem testa (importar histórico).
    await admin.tenantMember.update({ where: { tenantId_userId: { tenantId: fx.tenant.id, userId: fx.user.id } }, data: { role: "ADMIN" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    await admin.order.updateMany({ where: { tenantId: fx.tenant.id }, data: { alertDecidedById: null, fraudMarkedById: null } });
    await fx?.cleanup();
    await app?.close();
    await cardapioWeb?.close();
    await graph?.close();
  });

  it("primeiro pedido, sem histórico nem endereço marcado: sem alerta e sem conversa", async () => {
    const order = await arrives(cwOrder(1001, "11911110001", "Marcos Vieira"));
    expect(order.alertAt).toBeNull();
    expect(order.conversationId).toBeNull();
    expect(await listed(order.id)).toMatchObject({ alert: null, cancelable: true, customerCanceled: 0 });
  });

  it("cancelado fora do Dish Desk: guarda o motivo que a API informa", async () => {
    const order = await arrives(cwOrder(1001, "11911110001", "Marcos Vieira", { cancellation_reason: "Ninguém recebeu na entrega" }), "canceled");
    expect(order).toMatchObject({ status: "CANCELED", cancellationReason: "Ninguém recebeu na entrega" });
    expect(order.canceledAt).toBeInstanceOf(Date);
    expect(await listed(order.id)).toMatchObject({ alert: null, cancelable: false, cancellation: { reason: "Ninguém recebeu na entrega", fraud: null, outsideAt: order.canceledAt!.toISOString() } });
  });

  it("um cancelamento já basta: pedido sem conversa abre uma só da equipe, com o alerta", async () => {
    const order = await arrives(cwOrder(1002, "11911110001", "Marcos Vieira"));
    expect(order.alertAt).toBeInstanceOf(Date);
    const conversation = await admin.conversation.findUniqueOrThrow({ where: { id: order.conversationId! } });
    expect(conversation).toMatchObject({ teamOnly: true, status: "OPEN", unreadCount: 1, channelId });
    expect(await events(conversation.id)).toEqual(["Alerta de fraude exibido · 1 cancelamento no histórico"]);

    const { body } = await api().get(`/api/orders/current?conversationId=${conversation.id}`).set(auth()).expect(200);
    expect(body.current.cancelable).toBe(true);
    expect(body.current.alert).toMatchObject({
      customerName: "Marcos Vieira",
      addressMatches: [],
      decision: null,
      actionable: true,
      cancellations: { ordersCount: 2, canceledCount: 1, fraudCount: 0, rows: [{ displayCode: "1001", channelType: "CARDAPIO_WEB", reason: "Ninguém recebeu na entrega", imported: false, fraud: null }] },
    });

    // A lista da Inbox mostra o selo enquanto ninguém decidir; o cliente não está na conversa.
    const list = await api().get("/api/conversations").set(auth()).expect(200);
    expect(list.body.items.find((item: { id: string }) => item.id === conversation.id)).toMatchObject({ teamOnly: true, fraudAlert: true });
    await api().post(`/api/conversations/${conversation.id}/messages`).set(auth()).send({ text: "Oi" }).expect(422);
    await api().post(`/api/conversations/${conversation.id}/notes`).set(auth()).send({ text: "Olho nesse" }).expect(201);
  });

  it("manter o pedido: registra quem decidiu e não dá para decidir de novo", async () => {
    const order = await admin.order.findFirstOrThrow({ where: { channelId, externalOrderId: "1002" } });
    await api().post(`/api/orders/${order.id}/keep`).set(auth()).expect(204);
    await api().post(`/api/orders/${order.id}/keep`).set(auth()).expect(422);
    const { alert } = await listed(order.id);
    expect(alert.decision).toMatchObject({ kind: "KEPT", by: "Atendente Pipeline", fraud: false });
    expect((await events(order.conversationId!)).at(-1)).toBe("Pedido #1002 mantido por Atendente");
    const list = await api().get("/api/conversations").set(auth()).expect(200);
    expect(list.body.items.find((item: { id: string }) => item.id === order.conversationId)).toMatchObject({ fraudAlert: false });
  });

  it("cancelar pelo Cardápio Web: motivo em texto, marca de fraude, sem mensagem se o cliente não está em conversa", async () => {
    const placed = await arrives(cwOrder(1003, "11911110001", "Marcos Vieira"));
    const options = await api().get(`/api/orders/${placed.id}/cancellation-reasons`).set(auth()).expect(200);
    expect(options.body).toEqual({ reasons: [], reasonMode: "text", message: null, address: "Rua das Acácias, 120 · Cond. Jardim Sul, Bloco B, apto 34 · Vila Mariana" });

    cardapioWeb.state.refuseCancel = true;
    await api().post(`/api/orders/${placed.id}/cancel`).set(auth()).send({ reason: "Suspeita" }).expect(422);
    expect((await listed(placed.id)).status).toBe("CONFIRMED");
    cardapioWeb.state.refuseCancel = false;

    await api().post(`/api/orders/${placed.id}/cancel`).set(auth()).send({ reason: "Suspeita de golpe", markFraud: true }).expect(204);
    expect(cardapioWeb.state.canceled).toEqual([{ id: "1003", body: JSON.stringify({ cancellation_reason: "Suspeita de golpe" }) }]);
    const order = await admin.order.findUniqueOrThrow({ where: { id: placed.id } });
    expect(order).toMatchObject({ status: "CANCELED", cancellationReason: "Suspeita de golpe", alertDecision: "CANCELED" });
    expect(order.fraudAddressKey).toContain("rua das acacias|120|sao paulo|sp");
    expect(order.fraudAddressKey).toContain("apto=34");
    // A conversa da equipe aberta pelo pedido anterior do cliente é reaproveitada.
    const { conversationId } = await admin.order.findFirstOrThrow({ where: { channelId, externalOrderId: "1002" } });
    expect((await events(conversationId!)).slice(-2)).toEqual([
      "Pedido #1003 cancelado por Atendente · motivo: Suspeita de golpe",
      "Pedido #1003 marcado como fraude por Atendente",
    ]);
    expect((await listed(placed.id)).alert.decision).toMatchObject({ kind: "CANCELED", fraud: true });
    // Cancelado pela equipe: a lista não diz que foi fora do Dish Desk.
    expect((await listed(placed.id)).cancellation.outsideAt).toBeNull();
    // A polling seguinte não muda nada nem repete a linha do tempo.
    await arrives(cwOrder(1003, "11911110001", "Marcos Vieira"), "canceled");
    expect((await admin.order.findUniqueOrThrow({ where: { id: placed.id } })).cancellationReason).toBe("Suspeita de golpe");
  });

  it("cliente com conversa no WhatsApp: o alerta entra nela e a mensagem de cancelamento vai no tom do restaurante", async () => {
    const contact = await admin.contact.create({
      data: {
        tenantId: fx.tenant.id,
        name: "Carla Mendes",
        phone: "+5511911110002",
        phoneSource: "channel",
        phoneStatus: "ok",
        identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: "5511911110002" } },
      },
    });
    const conversation = await admin.conversation.create({
      data: { tenantId: fx.tenant.id, contactId: contact.id, channelId: fx.whatsapp.id, status: "OPEN", lastMessageAt: new Date() },
    });
    await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: { personality: "direto" } } });

    await arrives(cwOrder(1101, "11911110002", "Carla Mendes", { delivery_address: { ...ADDRESS, complement: "Casa 9" } }), "canceled");
    const order = await arrives(cwOrder(1102, "11911110002", "Carla Mendes", { delivery_address: { ...ADDRESS, complement: "Casa 9" } }));
    expect(order.conversationId).toBeNull();
    expect((await admin.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).teamOnly).toBe(false);
    expect(await events(conversation.id)).toEqual(["Alerta de fraude exibido · 1 cancelamento no histórico"]);

    const options = await api().get(`/api/orders/${order.id}/cancellation-reasons`).set(auth()).expect(200);
    expect(options.body.message).toEqual({ text: "Olá, Carla. Pedido #1102 cancelado. Dúvidas, responda aqui.", via: "WhatsApp", tone: "Direto" });

    // Cliente sem nome conhecido: a saudação sai sem o nome, nunca "Olá, ." nem "{nome}".
    const { contactId } = await admin.order.findUniqueOrThrow({ where: { id: order.id }, select: { contactId: true } });
    await admin.contact.update({ where: { id: contactId }, data: { name: null } });
    const unnamed = await api().get(`/api/orders/${order.id}/cancellation-reasons`).set(auth()).expect(200);
    expect(unnamed.body.message.text).toBe("Olá. Pedido #1102 cancelado. Dúvidas, responda aqui.");
    await admin.contact.update({ where: { id: contactId }, data: { name: "Carla Mendes" } });

    await api().post(`/api/orders/${order.id}/cancel`).set(auth()).send({}).expect(204);
    const sent = await admin.message.findMany({ where: { conversationId: conversation.id, direction: "OUTBOUND" } });
    expect(sent.map((m) => m.content)).toEqual([{ text: "Olá, Carla. Pedido #1102 cancelado. Dúvidas, responda aqui.", automation: "order_canceled" }]);
    await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: {} } });
  });

  it("endereço marcado: alerta no pedido de outro cliente, sem dados de quem foi marcado", async () => {
    const other = cwOrder(1201, "11911110003", "Rafael Lima", {
      // O mesmo endereço, escrito de outro jeito e em outros campos.
      delivery_address: { street: "R. das Acacias", number: "120", city: "SAO PAULO", state: "sp", neighborhood: "V. Mariana", complement: "Condominio Jardim Sul apto 34", address_block: "B" },
    });
    const order = await arrives(other);
    expect(order.alertAt).toBeInstanceOf(Date);
    expect(await events(order.conversationId!)).toEqual(["Alerta de fraude exibido · endereço marcado como fraude"]);

    const { alert } = await listed(order.id);
    expect(alert.cancellations.canceledCount).toBe(0);
    expect(alert.addressMatches).toEqual([{ placedAt: expect.any(String), reason: "Suspeita de golpe", markedBy: "Atendente Pipeline" }]);
    expect(JSON.stringify(alert.addressMatches)).not.toContain("Marcos");

    // Endereço parecido não conta.
    const neighbor = await arrives(cwOrder(1202, "11911110004", "Vizinho", { delivery_address: { ...ADDRESS, complement: "Cond. Jardim Sul, Bloco B, apto 35" } }));
    expect(neighbor.alertAt).toBeNull();
  });

  it("marcar um pedido já cancelado e remover a marca; pedido ativo não pode ser marcado", async () => {
    const canceled = await admin.order.findFirstOrThrow({ where: { channelId, externalOrderId: "1001" } });
    const active = await admin.order.findFirstOrThrow({ where: { channelId, externalOrderId: "1002" } });
    await api().post(`/api/orders/${active.id}/fraud`).set(auth()).expect(422);

    await api().post(`/api/orders/${canceled.id}/fraud`).set(auth()).expect(204);
    await api().post(`/api/orders/${canceled.id}/fraud`).set(auth()).expect(204);
    expect((await listed(canceled.id)).cancellation.fraud).toMatchObject({ by: "Atendente Pipeline" });

    await api().delete(`/api/orders/${canceled.id}/fraud`).set(auth()).expect(204);
    const unmarked = await admin.order.findUniqueOrThrow({ where: { id: canceled.id } });
    expect(unmarked).toMatchObject({ fraudMarkedAt: null, fraudMarkedById: null, fraudAddressKey: null });
  });

  it("cadastro do cliente: bloco de cancelamentos com os totais por origem", async () => {
    const order = await admin.order.findFirstOrThrow({ where: { channelId, externalOrderId: "1001" } });
    const { body } = await api().get(`/api/contacts/${order.contactId}`).set(auth()).expect(200);
    expect(body.cancellations).toMatchObject({ canceledCount: 2, fraudCount: 1, bySource: [{ channelType: "CARDAPIO_WEB", orders: 2 }] });
  });

  it("anonimizar o cliente apaga o endereço marcado e o motivo", async () => {
    const contact = await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Para Anonimizar" } });
    const order = await admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId: contact.id,
        channelId,
        externalOrderId: "anon-1",
        status: "CANCELED",
        subtotal: 10,
        deliveryFee: 0,
        total: 10,
        placedAt: new Date(),
        raw: {},
        cancellationReason: "Motivo com dado pessoal",
        fraudMarkedAt: new Date(),
        fraudAddressKey: "rua x|1|cidade|uf",
      },
    });
    await api().post(`/api/contacts/${contact.id}/anonymize`).set(auth()).expect(200);
    expect(await admin.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ fraudAddressKey: null, cancellationReason: null });
  });

  it("importar histórico: só os cancelados, para quando a API recusa o período e não mexe no último contato", async () => {
    // O teste chama cada etapa direto: a fila fica parada, sem o worker rodar a importação junto.
    await app.get<Queue>(getQueueToken(QUEUES.cardapioWeb)).pause();
    const contact = await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "Patrícia", phone: "+5511911110005", phoneSource: "channel", phoneStatus: "ok", lastSeenAt: new Date() },
    });
    const old = "2025-01-10T12:00:00.000Z";
    const historical = (id: number) => cwOrder(id, "11911110005", "Patrícia", { status: "canceled", created_at: old, updated_at: old, cancellation_reason: "Não veio retirar o pedido" });
    cardapioWeb.state.orders["1301"] = historical(1301);
    cardapioWeb.state.orders["1302"] = historical(1302);

    const started = await api().post(`/api/integrations/${fx.tenant.id}/${channelId}/order-history`).set(auth()).expect(200);
    expect(started.body.orderHistory).toMatchObject({ status: "running", imported: 0 });
    const until = started.body.orderHistory.to as string;
    const month = (back: number) => {
      const date = new Date(until);
      date.setUTCMonth(date.getUTCMonth() - back);
      return date.toISOString().slice(0, 7);
    };
    // Dois períodos com pedidos; o terceiro a API recusa, como quem só guarda um ano.
    cardapioWeb.state.history.set(month(6), [{ id: 1301, status: "canceled", sales_channel: "catalog", updated_at: old }]);
    cardapioWeb.state.history.set(month(12), [{ id: 1302, status: "canceled", sales_channel: "catalog", updated_at: old }]);

    const job = { tenantId: fx.tenant.id, channelId, until, imported: 0 };
    await service.importOrderHistory({ ...job, window: 0, page: 1 });
    await service.importOrderHistory({ ...job, window: 1, page: 1, imported: 1 });
    await service.importOrderHistory({ ...job, window: 2, page: 1, imported: 2 });

    expect(cardapioWeb.state.historyRequests.every((search) => search.includes("status%5B%5D=canceled"))).toBe(true);
    const channel = await admin.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.orderHistoryImport).toMatchObject({ status: "done", progress: 100, imported: 2 });

    const imported = await admin.order.findMany({ where: { channelId, externalOrderId: { in: ["1301", "1302"] } } });
    expect(imported.map((order) => order.contactId)).toEqual([contact.id, contact.id]);
    expect(imported.every((order) => order.importedAt !== null && order.status === "CANCELED" && order.alertAt === null)).toBe(true);
    const seen = await admin.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(Date.now() - seen.lastSeenAt!.getTime()).toBeLessThan(60_000);

    // O próximo pedido dela já abre com o alerta, com a origem importada na lista.
    const next = await arrives(cwOrder(1303, "11911110005", "Patrícia", { delivery_address: null }));
    const { alert } = await listed(next.id);
    expect(alert.cancellations.rows[0]).toMatchObject({ imported: true, reason: "Não veio retirar o pedido" });
  });

  it("importar histórico: erro na primeira consulta avisa", async () => {
    const until = new Date().toISOString();
    await admin.channel.update({
      where: { id: channelId },
      data: { orderHistoryImport: { status: "running", progress: 0, imported: 0, from: null, to: until, startedAt: until, updatedAt: until } },
    });
    cardapioWeb.state.history.clear();
    await service.importOrderHistory({ tenantId: fx.tenant.id, channelId, until, window: 0, page: 1, imported: 0 });
    expect((await admin.channel.findUniqueOrThrow({ where: { id: channelId } })).orderHistoryImport).toMatchObject({ status: "error" });
    const queue = app.get<Queue>(getQueueToken(QUEUES.cardapioWeb));
    await queue.drain(true);
    await queue.resume();
  });
});
