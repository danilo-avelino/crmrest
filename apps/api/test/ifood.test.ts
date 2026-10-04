import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { blindIndex, parseEncryptionKey } from "@comanda/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IfoodService } from "../src/inbound/ifood.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { admin, createChannelFixture, createTestApp } from "./helpers.js";

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
  const event = (id: string, fullCode: string, orderId: string, merchantId = fx.ifood.externalId) => ({
    id,
    code: fullCode.slice(0, 3),
    fullCode,
    orderId,
    merchantId,
    createdAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    ifood = await startMockIfood();
    app = await createTestApp({ IFOOD_CLIENT_ID: "cliente", IFOOD_CLIENT_SECRET: "segredo", IFOOD_API_URL: ifood.url });
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

  it("pedido novo: cliente com CPF da nota e endereço, pedido e card na conversa", async () => {
    ifood.state.orders["pedido-1"] = ifoodOrder("pedido-1", "4852");
    ifood.state.events.push(event("ev-1", "PLACED", "pedido-1"));
    await service.poll();

    expect(ifood.state.tokenRequests[0]).toContain("grantType=client_credentials");
    expect(ifood.state.pollingMerchants.at(-1)).toContain(fx.ifood.externalId);
    expect(ifood.state.acked).toContain("ev-1");

    const order = await admin.order.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, externalOrderId: "pedido-1" },
      include: { items: true, contact: { include: { addresses: true, identities: true } }, conversation: { include: { messages: { orderBy: { createdAt: "asc" } } } } },
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
    expect(order.conversation).toMatchObject({ status: "OPEN", unreadCount: 1, channelId: fx.ifood.id });
    expect(order.conversation!.messages.map((m) => m.content)).toEqual([
      { event: "conversation_opened", text: "Conversa aberta via iFood" },
      { event: "order", orderId: order.id },
    ]);
  });

  it("eventos de status avançam o pedido", async () => {
    ifood.state.events.push(event("ev-2", "CONFIRMED", "pedido-1"), event("ev-3", "DISPATCHED", "pedido-1"));
    await service.poll();
    const order = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-1" } });
    expect(order.status).toBe("DISPATCHED");
    expect(order.dispatchedAt).toBeInstanceOf(Date);
    expect(ifood.state.acked).toEqual(expect.arrayContaining(["ev-2", "ev-3"]));
  });

  it("novo pedido do mesmo cliente volta para a mesma conversa, sem duplicar endereço", async () => {
    ifood.state.orders["pedido-2"] = ifoodOrder("pedido-2", "4901");
    ifood.state.events.push(event("ev-4", "PLACED", "pedido-2"));
    await service.poll();
    const orders = await admin.order.findMany({ where: { tenantId: fx.tenant.id }, include: { contact: { include: { addresses: true } } } });
    expect(new Set(orders.map((o) => o.conversationId)).size).toBe(1);
    expect(orders[0]!.contact.addresses).toHaveLength(1);
    const conversation = await admin.conversation.findUniqueOrThrow({ where: { id: orders[0]!.conversationId! } });
    expect(conversation.unreadCount).toBe(2);
  });

  it("confirma eventos de lojas desconhecidas e não confirma os que falharam", async () => {
    ifood.state.events.push(event("ev-5", "PLACED", "pedido-de-outra-loja", "loja-desconhecida"), event("ev-6", "PLACED", "pedido-sumido"));
    await service.poll();
    expect(ifood.state.acked).toContain("ev-5");
    expect(ifood.state.acked).not.toContain("ev-6"); // detalhes indisponíveis: volta no próximo polling
  });
});
