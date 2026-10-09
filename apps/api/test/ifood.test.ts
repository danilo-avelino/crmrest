import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { blindIndex, parseEncryptionKey } from "@dishdesk/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IfoodService } from "../src/inbound/ifood.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp } from "./helpers.js";

/** Merchant API falsa: token, polling (eventos na fila), detalhes do pedido e confirmação. */
async function startMockIfood() {
  const state = {
    events: [] as object[],
    orders: {} as Record<string, object>,
    acked: [] as string[],
    pollingMerchants: [] as string[],
    tokenRequests: [] as string[],
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const url = req.url ?? "";
    const json = (status: number, body?: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));

    if (url === "/authentication/v1.0/oauth/token") {
      state.tokenRequests.push(raw);
      return json(200, { accessToken: "token-ifood", type: "bearer", expiresIn: 21600 });
    }
    if (req.headers.authorization !== "Bearer token-ifood") return json(401);
    if (url === "/order/v1.0/events:polling") {
      state.pollingMerchants.push(String(req.headers["x-polling-merchants"]));
      const events = state.events.splice(0);
      return events.length ? json(200, events) : json(204);
    }
    if (url === "/order/v1.0/events/acknowledgment") {
      state.acked.push(...(JSON.parse(raw) as { id: string }[]).map((e) => e.id));
      return json(202);
    }
    const order = url.match(/^\/order\/v1\.0\/orders\/(.+)$/)?.[1];
    if (order) return state.orders[order] ? json(200, state.orders[order]) : json(404);
    return json(404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ifoodOrder = (id: string, displayId: string, customerId = "cliente-carlos") => ({
  id,
  displayId,
  createdAt: new Date().toISOString(),
  orderType: "DELIVERY",
  customer: { id: customerId, name: "Carlos Mendes", documentNumber: "123.456.789-09", phone: { number: "0800 000 0000", localizer: "12345678" } },
  items: [{ name: "Pizza Margherita G", quantity: 2, unitPrice: 44.9, totalPrice: 89.8 }],
  total: { subTotal: 89.8, deliveryFee: 5, orderAmount: 94.8 },
  delivery: {
    deliveryAddress: {
      streetName: "Rua dos Pinheiros",
      streetNumber: "120",
      neighborhood: "Pinheiros",
      city: "São Paulo",
      state: "SP",
      postalCode: "05422000",
    },
  },
});

describe("iFood (pedidos por polling)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let ifood: Awaited<ReturnType<typeof startMockIfood>>;
  let service: IfoodService;
  const event = (id: string, fullCode: string, orderId: string, merchantId = fx.ifood.externalId, at = new Date(), metadata?: object) => ({
    id,
    code: fullCode.slice(0, 3),
    fullCode,
    orderId,
    merchantId,
    createdAt: at.toISOString(),
    ...(metadata && { metadata }),
  });

  beforeAll(async () => {
    ifood = await startMockIfood();
    app = await createTestApp({ IFOOD_CLIENT_ID: "cliente", IFOOD_CLIENT_SECRET: "segredo", IFOOD_API_URL: ifood.url, IFOOD_WIDGET_ID: "widget-teste" });
    // O teste chama o polling direto: sem o agendamento a cada 30s.
    await app.get<Queue>(getQueueToken(QUEUES.ifood)).removeJobScheduler("ifood-polling");
    service = app.get(IfoodService);
    fx = await createChannelFixture();
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await ifood?.close();
  });

  it("pedido novo: cliente com CPF da nota e endereço e o pedido, sem abrir conversa (o iFood não deixa responder)", async () => {
    ifood.state.orders["pedido-1"] = ifoodOrder("pedido-1", "4852");
    ifood.state.events.push(event("ev-1", "PLACED", "pedido-1"));
    await service.poll();

    expect(ifood.state.tokenRequests[0]).toContain("grantType=client_credentials");
    expect(ifood.state.pollingMerchants.at(-1)).toContain(fx.ifood.externalId);
    expect(ifood.state.acked).toContain("ev-1");

    const order = await admin.order.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, externalOrderId: "pedido-1" },
      include: { items: true, contact: { include: { addresses: true, identities: true } } },
    });
    expect(order).toMatchObject({ displayCode: "4852", status: "PLACED" });
    expect(order.total.toString()).toBe("94.8");
    expect(order.items.map((i) => [i.name, i.quantity, i.unitPrice.toString()])).toEqual([["Pizza Margherita G", 2, "44.9"]]);
    expect(order.contact).toMatchObject({
      name: "Carlos Mendes",
      phone: null, // o iFood não informa o telefone real
      cpfHash: blindIndex("12345678909", parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")),
    });
    expect(order.contact.addresses).toEqual([expect.objectContaining({ street: "Rua dos Pinheiros", number: "120", district: "Pinheiros" })]);
    expect(order.contact.identities.map((i) => [i.channelType, i.externalId])).toEqual([["IFOOD", "cliente-carlos"]]);
    expect(order.conversationId).toBeNull();
    expect(await admin.conversation.count({ where: { tenantId: fx.tenant.id, channelId: fx.ifood.id } })).toBe(0);
  });

  it("eventos de status avançam o pedido", async () => {
    ifood.state.events.push(event("ev-2", "CONFIRMED", "pedido-1"), event("ev-3", "DISPATCHED", "pedido-1"));
    await service.poll();
    const order = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-1" } });
    expect(order.status).toBe("DISPATCHED");
    expect(order.dispatchedAt).toBeInstanceOf(Date);
    expect(ifood.state.acked).toEqual(expect.arrayContaining(["ev-2", "ev-3"]));
  });

  it("novo pedido do mesmo cliente entra no mesmo cadastro, sem duplicar endereço", async () => {
    ifood.state.orders["pedido-2"] = ifoodOrder("pedido-2", "4901");
    ifood.state.events.push(event("ev-4", "PLACED", "pedido-2"));
    await service.poll();
    const orders = await admin.order.findMany({ where: { tenantId: fx.tenant.id }, include: { contact: { include: { addresses: true } } } });
    expect(new Set(orders.map((o) => o.contactId)).size).toBe(1);
    expect(orders[0]!.contact.addresses).toHaveLength(1);
  });

  it("loja com id fora do formato do iFood fica de fora do polling (sem derrubar as outras)", async () => {
    const invalid = await admin.channel.create({
      data: { tenantId: fx.tenant.id, type: "IFOOD", name: "iFood exemplo", externalId: "loja-de-exemplo", credentials: Buffer.from("{}"), status: "CONNECTED" },
    });
    try {
      await service.poll();
      expect(ifood.state.pollingMerchants.at(-1)).toContain(fx.ifood.externalId);
      expect(ifood.state.pollingMerchants.at(-1)).not.toContain("loja-de-exemplo");
    } finally {
      await admin.channel.delete({ where: { id: invalid.id } });
    }
  });

  it("confirma eventos de lojas desconhecidas e não confirma os que falharam", async () => {
    ifood.state.events.push(event("ev-5", "PLACED", "pedido-de-outra-loja", "loja-desconhecida"), event("ev-6", "PLACED", "pedido-sumido"));
    await service.poll();
    expect(ifood.state.acked).toContain("ev-5");
    expect(ifood.state.acked).not.toContain("ev-6"); // detalhes indisponíveis: volta no próximo polling
  });

  it("linha do tempo: guarda cada evento com o horário; pronto, coleta pelo entregador e conclusão", async () => {
    ifood.state.orders["pedido-3"] = ifoodOrder("pedido-3", "5010");
    const minute = 60_000;
    const placed = Date.now() - 40 * minute;
    const at = (minutes: number) => new Date(placed + minutes * minute);
    ifood.state.events.push(
      event("ev-30", "PLACED", "pedido-3", undefined, at(0)),
      event("ev-31", "CONFIRMED", "pedido-3", undefined, at(1)),
      event("ev-32", "READY_TO_PICKUP", "pedido-3", undefined, at(19)),
    );
    await service.poll();
    const ready = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-3" } });
    expect(ready.status).toBe("READY");

    ifood.state.events.push(
      event("ev-33", "COLLECTED", "pedido-3", undefined, at(24), { workerName: "Fulano da Silva" }),
      event("ev-34", "CONCLUDED", "pedido-3", undefined, at(90)),
      event("ev-32", "READY_TO_PICKUP", "pedido-3", undefined, at(19)), // reenviado: não duplica
    );
    await service.poll();
    const timeline = await admin.order.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, externalOrderId: "pedido-3" },
      include: { events: { orderBy: { occurredAt: "asc" } } },
    });
    expect(timeline.events.map((e) => [e.code, e.occurredAt.getTime()])).toEqual([
      ["PLACED", at(0).getTime()],
      ["CONFIRMED", at(1).getTime()],
      ["READY_TO_PICKUP", at(19).getTime()],
      ["COLLECTED", at(24).getTime()],
      ["CONCLUDED", at(90).getTime()],
    ]);
    expect(timeline.events[3]!.metadata).toEqual({ workerName: "Fulano da Silva" });
    // A coleta é a saída do restaurante; a conclusão (horas depois) não vira horário de entrega.
    expect(timeline).toMatchObject({ status: "DELIVERED", dispatchedAt: at(24), deliveredAt: null });
  });

  it("pedido alterado pelo cliente (ORDER_PATCHED): itens e total atualizados", async () => {
    ifood.state.orders["pedido-3"] = {
      ...ifoodOrder("pedido-3", "5010"),
      items: [{ name: "Pizza Margherita G", quantity: 1, unitPrice: 44.9, totalPrice: 44.9 }],
      total: { subTotal: 44.9, deliveryFee: 5, orderAmount: 49.9 },
    };
    ifood.state.events.push(event("ev-35", "ORDER_PATCHED", "pedido-3"));
    await service.poll();
    const order = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-3" }, include: { items: true } });
    expect(order.total.toString()).toBe("49.9");
    expect(order.items.map((i) => [i.name, i.quantity])).toEqual([["Pizza Margherita G", 1]]);
    expect(ifood.state.acked).toContain("ev-35");
  });

  it("aba Pedidos: lista os pedidos com a linha do tempo e o tempo de preparo (confirmado → pronto)", async () => {
    const token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const { body } = await request(app.getHttpServer()).get("/api/orders?period=7d").set("Authorization", `Bearer ${token}`).expect(200);
    expect(body).toMatchObject({ total: 3, page: 1 });
    const order = body.items.find((o: { displayCode: string }) => o.displayCode === "5010");
    expect(order).toMatchObject({
      channelType: "IFOOD",
      status: "DELIVERED",
      total: "49.90",
      contact: { name: "Carlos Mendes" },
      preparationSeconds: 18 * 60, // confirmado 1 min depois do pedido, pronto aos 19
    });
    expect(order.events.map((e: { code: string }) => e.code)).toEqual(["PLACED", "CONFIRMED", "READY_TO_PICKUP", "COLLECTED", "ORDER_PATCHED", "CONCLUDED"]);

    const filtered = await request(app.getHttpServer())
      .get("/api/orders?period=7d&status=DISPATCHED")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(filtered.body.items.map((o: { displayCode: string }) => o.displayCode)).toEqual(["4852"]);
  });

  it("widget do iFood: id do widget e as lojas iFood do restaurante", async () => {
    const token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const { body } = await request(app.getHttpServer()).get("/api/ifood-widget").set("Authorization", `Bearer ${token}`).expect(200);
    expect(body).toEqual({ widgetId: "widget-teste", merchantIds: [fx.ifood.externalId] });
  });

  it("saiu para entrega com o cliente conversando pelo WhatsApp: avisa na conversa, uma vez só", async () => {
    const { contactId } = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-2" } });
    const conversation = await admin.conversation.create({
      data: {
        tenantId: fx.tenant.id,
        contactId,
        channelId: fx.whatsapp.id,
        status: "OPEN",
        lastMessageAt: new Date(),
        windowExpiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    // Entregador do iFood: "coletado" depois de "saiu para entrega" não repete o aviso.
    ifood.state.events.push(event("ev-aviso-1", "CONFIRMED", "pedido-2"), event("ev-aviso-2", "DISPATCHED", "pedido-2"), event("ev-aviso-3", "COLLECTED", "pedido-2"));
    await service.poll();
    const messages = await admin.message.findMany({ where: { conversationId: conversation.id } });
    expect(messages.map((m) => m.content)).toEqual([
      { automation: "order_dispatched", text: expect.stringMatching(/^🛵 Boa notícia! Seu pedido #4901 saiu para entrega às \d{2}:\d{2}\.$/) },
    ]);
    expect(messages[0]!.direction).toBe("OUTBOUND");

    // Entregue: avisa; o CONCLUDED que vem depois não repete.
    ifood.state.events.push(event("ev-aviso-4", "DELIVERED", "pedido-2"), event("ev-aviso-5", "CONCLUDED", "pedido-2"));
    await service.poll();
    const after = await admin.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
    expect(after.map((m) => m.content)).toEqual([
      expect.objectContaining({ automation: "order_dispatched" }),
      { automation: "order_delivered", text: "✅ Seu pedido #4901 foi entregue! Bom apetite 😋" },
    ]);
  });

  it("entregue só pelo CONCLUDED (que chega horas depois): não avisa", async () => {
    ifood.state.orders["pedido-4"] = ifoodOrder("pedido-4", "6020");
    ifood.state.events.push(event("ev-aviso-6", "PLACED", "pedido-4"));
    await service.poll();
    const { contactId } = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-4" } });
    const conversation = await admin.conversation.findFirstOrThrow({ where: { tenantId: fx.tenant.id, contactId, channelId: fx.whatsapp.id } });
    ifood.state.events.push(event("ev-aviso-7", "CONCLUDED", "pedido-4"));
    await service.poll();
    expect((await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-4" } })).status).toBe("DELIVERED");
    const texts = (await admin.message.findMany({ where: { conversationId: conversation.id } })).map((m) => (m.content as { text?: string }).text);
    expect(texts.some((text) => text?.includes("#6020"))).toBe(false);
  });
});
