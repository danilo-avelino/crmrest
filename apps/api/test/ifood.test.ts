import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { blindIndex, decrypt, encrypt, parseEncryptionKey } from "@dishdesk/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV } from "../src/config/env.js";
import { IfoodAuthService } from "../src/connectors/ifood-auth.service.js";
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
    actions: [] as string[],
    reasons: [] as { cancelCodeId: string; description: string }[],
    reasonsAsDocumented: false,
    cancellations: [] as object[],
    disputes: [] as object[],
    rejectActions: false,
    forbidden: new Set<string>(),
    forbidAll: false,
    oldestValidToken: 0,
    // Aplicativo distribuído: código de autorização → lojas autorizadas (quem responde por várias autoriza todas);
    // token → as lojas que ele enxerga, também na claim merchant_scope.
    authorizationCodes: new Map<string, string[]>(),
    tokenMerchants: new Map<number, string[]>(),
    revokedRefreshTokens: new Set<string>(),
    grantExpiresIn: 21600,
    // Aplicativo sem o módulo Merchant (como o do Dish Desk): a lista de lojas do acesso é recusada.
    noMerchantModule: false,
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const url = req.url ?? "";
    const json = (status: number, body?: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));

    if (url === "/authentication/v1.0/oauth/userCode") {
      return json(200, {
        userCode: "ABCD-EFGH",
        authorizationCodeVerifier: "verificador-do-codigo",
        verificationUrl: "https://portal.ifood.com.br/apps/code",
        verificationUrlComplete: "https://portal.ifood.com.br/apps/code?c=ABCD-EFGH",
        expiresIn: 600,
      });
    }
    if (url === "/authentication/v1.0/oauth/token") {
      state.tokenRequests.push(raw);
      const form = new URLSearchParams(raw);
      const issued = state.tokenRequests.length;
      if (form.get("grantType") === "client_credentials") {
        return json(200, { accessToken: `token-ifood-${issued}`, type: "bearer", expiresIn: 21600 });
      }
      // Distribuído: o código (com o verificador do userCode) ou o refreshToken viram o acesso de uma loja.
      const refresh = form.get("refreshToken") ?? "";
      const stores =
        form.get("grantType") === "authorization_code"
          ? form.get("authorizationCodeVerifier") === "verificador-do-codigo" && state.authorizationCodes.get(form.get("authorizationCode") ?? "")
          : !state.revokedRefreshTokens.has(refresh) && state.tokenMerchants.get(Number(/^refresh-(\d+)$/.exec(refresh)?.[1]));
      if (!stores) return json(401, { error: { code: "Unauthorized" } });
      state.tokenMerchants.set(issued, stores);
      const claims = Buffer.from(JSON.stringify({ merchant_scoped: true, merchant_scope: stores.flatMap((id) => [`${id}:order`, `${id}:events`]) }));
      const accessToken = `token-ifood-${issued}.${claims.toString("base64url")}.assinatura`;
      return json(200, { accessToken, refreshToken: `refresh-${issued}`, type: "bearer", expiresIn: state.grantExpiresIn });
    }
    const token = Number(/^Bearer token-ifood-(\d+)(?:\.|$)/.exec(req.headers.authorization ?? "")?.[1]);
    if (!token) return json(401);
    if (url === "/merchant/v1.0/merchants") {
      if (state.noMerchantModule) return json(403);
      // Token de lojas (distribuído): só elas.
      return json(200, (state.tokenMerchants.get(token) ?? []).map((id) => ({ id, name: "Loja do iFood", corporateName: "Loja LTDA" })));
    }
    if (url === "/order/v1.0/events:polling") {
      const merchants = String(req.headers["x-polling-merchants"]).split(",");
      state.pollingMerchants.push(merchants.join(","));
      // Como o iFood: id fora do formato = 400; uma loja que não autoriza o aplicativo = 403 para a consulta inteira.
      if (merchants.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) return json(400);
      // O token só vale para as lojas que autorizavam o aplicativo quando ele foi emitido.
      if (state.forbidAll || token < state.oldestValidToken || merchants.some((id) => state.forbidden.has(id))) return json(403);
      // Token de lojas (distribuído): só os pedidos delas.
      const only = state.tokenMerchants.get(token);
      if (only && merchants.some((id) => !only.includes(id))) return json(403);
      const events = state.events.splice(0);
      return events.length ? json(200, events) : json(204);
    }
    if (url === "/order/v1.0/events/acknowledgment") {
      state.acked.push(...(JSON.parse(raw) as { id: string }[]).map((e) => e.id));
      return json(202);
    }
    const action = url.match(/^\/order\/v1\.0\/orders\/([^/]+)\/(confirm|readyToPickup|dispatch|cancellationReasons|requestCancellation)$/);
    if (action) {
      const [, orderId, step] = action;
      if (step === "cancellationReasons") {
        if (!state.reasons.length) return json(204);
        // A documentação nova descreve outro formato para a mesma lista.
        return json(200, state.reasonsAsDocumented ? { reasons: state.reasons.map((r) => ({ code: r.cancelCodeId, description: r.description })) } : state.reasons);
      }
      if (state.rejectActions) return json(409, { error: { code: "Conflict" } });
      if (step === "requestCancellation") state.cancellations.push({ orderId, ...(JSON.parse(raw) as object) });
      else state.actions.push(`${orderId}/${step}`);
      return json(202);
    }
    const dispute = url.match(/^\/order\/v1\.0\/disputes\/([^/]+)\/(accept|reject)$/);
    if (dispute) {
      state.disputes.push({ id: dispute[1], answer: dispute[2], ...(JSON.parse(raw) as object) });
      return json(201, { status: dispute[2] === "accept" ? "ACCEPTED" : "REJECTED" });
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
    app = await createTestApp({
      IFOOD_CLIENT_ID: "cliente",
      IFOOD_CLIENT_SECRET: "segredo",
      IFOOD_API_URL: ifood.url,
      IFOOD_WIDGET_ID: "widget-teste",
      IFOOD_ORDER_ACTIONS: "true",
    });
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

  it("item com complementos: o preço da linha é o total do item e os complementos ficam listados", async () => {
    ifood.state.orders["pedido-combo"] = {
      ...ifoodOrder("pedido-combo", "5500", "cliente-combo"),
      items: [
        { name: "Refrigerante", quantity: 2, unitPrice: 6, totalPrice: 12, observations: "", options: [] },
        {
          name: "Combo da casa",
          quantity: 1,
          unitPrice: 5, // preço base; os complementos entram no total da linha
          totalPrice: 16,
          observations: "Sem cebola",
          options: [
            { name: "Bacon", quantity: 2, unitPrice: 2 },
            { name: "Sanduíche", quantity: 1, unitPrice: 2, customizations: [{ name: "Pão australiano", quantity: 1, unitPrice: 1 }] },
          ],
        },
      ],
      total: { subTotal: 28, deliveryFee: 5, orderAmount: 33 },
    };
    ifood.state.events.push(event("ev-combo", "PLACED", "pedido-combo"));
    await service.poll();
    const order = await admin.order.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, externalOrderId: "pedido-combo" },
      include: { items: { orderBy: { name: "asc" } } },
    });
    expect(order.items.map((i) => [i.name, i.quantity, i.unitPrice.toString(), i.notes, i.options])).toEqual([
      ["Combo da casa", 1, "16", "Sem cebola", ["2× Bacon", "1× Sanduíche", "↳ 1× Pão australiano"]],
      ["Refrigerante", 2, "6", "", []],
    ]);
    await admin.order.delete({ where: { id: order.id } }); // fora da contagem da aba Pedidos, logo abaixo
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
    expect(body).toEqual({ widgetId: "widget-teste", merchantIds: [fx.ifood.externalId], chat: false, extensionUrl: null });
  });

  it("trava do chat desligada: as rotas do chat não existem e o iFood não aceita resposta pela Inbox", async () => {
    const token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const post = (path: string, body?: object) => request(app.getHttpServer()).post(`/api${path}`).set("Authorization", `Bearer ${token}`).send(body);
    await post("/ifood-chat/sync", { orderCode: "4852", messages: [{ direction: "INBOUND", text: "Olá", time: "12:00:00" }] }).expect(404);
    await post("/ifood-chat/outbox/claim").expect(404);
    const order = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-1" } });
    const chat = await admin.conversation.create({ data: { tenantId: fx.tenant.id, contactId: order.contactId, channelId: fx.ifood.id, status: "OPEN" } });
    await post(`/conversations/${chat.id}/messages`, { text: "Olá" }).expect(422);
    await admin.conversation.delete({ where: { id: chat.id } });
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

  it("entrega própria: o código de entrega validado marca entregue e avisa", async () => {
    ifood.state.orders["pedido-codigo"] = ifoodOrder("pedido-codigo", "6917");
    const placed = Date.now() - 40 * 60_000;
    const at = (minutes: number) => new Date(placed + minutes * 60_000);
    ifood.state.events.push(event("ev-codigo-1", "PLACED", "pedido-codigo", undefined, at(0)));
    await service.poll();
    const { contactId } = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-codigo" } });
    const conversation = await admin.conversation.findFirstOrThrow({ where: { tenantId: fx.tenant.id, contactId, channelId: fx.whatsapp.id } });
    ifood.state.events.push(event("ev-codigo-2", "DISPATCHED", "pedido-codigo", undefined, at(20)), event("ev-codigo-3", "DELIVERY_DROP_CODE_VALIDATION_SUCCESS", "pedido-codigo", undefined, at(35)));
    await service.poll();
    const order = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-codigo" } });
    expect(order.status).toBe("DELIVERED");
    expect(order.deliveredAt).toEqual(at(35));
    const texts = (await admin.message.findMany({ where: { conversationId: conversation.id } })).map((m) => (m.content as { text?: string }).text);
    expect(texts).toContain("✅ Seu pedido #6917 foi entregue! Bom apetite 😋");
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

  describe("loja que não autoriza o aplicativo", () => {
    const channelStatus = async (id: string) => (await admin.channel.findUniqueOrThrow({ where: { id } })).status;

    it("fica com erro e sai do polling; as outras lojas continuam recebendo", async () => {
      const revoked = await admin.channel.create({
        data: { tenantId: fx.tenant.id, type: "IFOOD", name: "iFood revogada", externalId: randomUUID(), credentials: Buffer.from("{}"), status: "CONNECTED" },
      });
      ifood.state.forbidden.add(revoked.externalId);
      try {
        ifood.state.orders["pedido-9"] = ifoodOrder("pedido-9", "7005", "cliente-pedido-9");
        ifood.state.events.push(event("ev-pedido-9", "PLACED", "pedido-9"));
        await service.poll();
        expect(await channelStatus(revoked.id)).toBe("ERROR");
        expect(await channelStatus(fx.ifood.id)).toBe("CONNECTED");
        expect(await admin.order.count({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-9" } })).toBe(1);
        expect(ifood.state.acked).toContain("ev-pedido-9");

        await service.poll();
        expect(ifood.state.pollingMerchants.at(-1)).toContain(fx.ifood.externalId);
        expect(ifood.state.pollingMerchants.at(-1)).not.toContain(revoked.externalId);
      } finally {
        ifood.state.forbidden.clear();
        await admin.channel.delete({ where: { id: revoked.id } });
      }
    });

    it("loja aprovada depois do token guardado: renova o token antes de culpar a loja", async () => {
      // O token do polling é antigo e o iFood só aceita a consulta com um emitido depois da aprovação da loja.
      const client = service.client as unknown as { token: { issuedAt: number } };
      client.token.issuedAt -= 5 * 60_000;
      ifood.state.oldestValidToken = ifood.state.tokenRequests.length + 1;
      try {
        ifood.state.orders["pedido-10"] = ifoodOrder("pedido-10", "7006", "cliente-pedido-10");
        ifood.state.events.push(event("ev-pedido-10", "PLACED", "pedido-10"));
        await service.poll();
        expect(ifood.state.tokenRequests).toHaveLength(ifood.state.oldestValidToken);
        expect(await channelStatus(fx.ifood.id)).toBe("CONNECTED");
        expect(await admin.order.count({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-10" } })).toBe(1);
      } finally {
        ifood.state.oldestValidToken = 0;
      }
    });

    it("todas recusadas: o problema é da credencial, nenhuma loja é marcada", async () => {
      ifood.state.forbidAll = true;
      try {
        await service.poll();
        expect(await channelStatus(fx.ifood.id)).toBe("CONNECTED");
      } finally {
        ifood.state.forbidAll = false;
      }
    });

    it("conectar uma loja: só entra se o iFood confirma que ela autorizou o aplicativo", async () => {
      await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
      const token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
      const add = (merchantId: string) =>
        request(app.getHttpServer()).post(`/api/integrations/${fx.tenant.id}`).set("Authorization", `Bearer ${token}`).send({ type: "IFOOD", merchantId });

      const unauthorized = randomUUID();
      ifood.state.forbidden.add(unauthorized);
      try {
        expect((await add(unauthorized).expect(422)).body.message).toBe(
          "Não foi possível conectar o iFood: a loja ainda não autorizou o Dish Desk no Portal do Parceiro do iFood.",
        );
        expect((await add("4190562").expect(422)).body.message).toContain("o ID da loja não é válido");
        expect(await admin.channel.count({ where: { tenantId: fx.tenant.id, type: "IFOOD" } })).toBe(1);

        const authorized = randomUUID();
        expect((await add(authorized).expect(201)).body).toMatchObject({ externalId: authorized, status: "CONNECTED" });
        await admin.channel.deleteMany({ where: { tenantId: fx.tenant.id, externalId: authorized } });
      } finally {
        ifood.state.forbidden.clear();
      }
    });
  });

  describe("ações do pedido", () => {
    let token: string;
    const orderOf = (externalOrderId: string) => admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, externalOrderId } });
    const post = (orderId: string, path: string, body?: object) =>
      request(app.getHttpServer()).post(`/api/orders/${orderId}/${path}`).set("Authorization", `Bearer ${token}`).send(body);
    const listed = async (orderId: string) => {
      const { body } = await request(app.getHttpServer()).get("/api/orders?period=7d").set("Authorization", `Bearer ${token}`).expect(200);
      return body.items.find((o: { id: string }) => o.id === orderId);
    };
    /** Pedido novo, já com os eventos informados (o status só muda por evento do iFood). */
    const placed = async (id: string, displayId: string, deliveredBy: string, ...codes: string[]) => {
      const base = ifoodOrder(id, displayId, `cliente-${id}`);
      ifood.state.orders[id] = { ...base, delivery: { ...base.delivery, deliveredBy } };
      ifood.state.events.push(...["PLACED", ...codes].map((code) => event(`ev-${id}-${code}`, code, id)));
      await service.poll();
      return orderOf(id);
    };
    const arrives = async (id: string, code: string, metadata?: object) => {
      ifood.state.events.push(event(`ev-${id}-${code}`, code, id, undefined, new Date(), metadata));
      await service.poll();
    };

    beforeAll(async () => {
      token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    });

    it("um botão só: confirma, avisa que ficou pronto e despacha, conforme o status", async () => {
      const order = await placed("pedido-5", "7001", "MERCHANT");
      expect(await listed(order.id)).toMatchObject({ nextAction: "CONFIRM", cancelable: true });
      expect((await post(order.id, "advance").expect(200)).body).toEqual({ action: "CONFIRM" });
      // O iFood só aceitou: o pedido muda quando o evento chega pelo polling.
      expect((await orderOf("pedido-5")).status).toBe("PLACED");

      await arrives("pedido-5", "CONFIRMED");
      expect((await post(order.id, "advance").expect(200)).body).toEqual({ action: "READY" });
      await arrives("pedido-5", "READY_TO_PICKUP");
      expect((await post(order.id, "advance").expect(200)).body).toEqual({ action: "DISPATCH" });
      await arrives("pedido-5", "DISPATCHED");

      expect(ifood.state.actions).toEqual(["pedido-5/confirm", "pedido-5/readyToPickup", "pedido-5/dispatch"]);
      expect(await listed(order.id)).toMatchObject({ status: "DISPATCHED", nextAction: null, cancelable: true });
      await post(order.id, "advance").expect(422);
    });

    it("pronto com entregador do iFood: não há despacho pela loja", async () => {
      const order = await placed("pedido-6", "7002", "IFOOD", "CONFIRMED", "READY_TO_PICKUP");
      expect(await listed(order.id)).toMatchObject({ status: "READY", nextAction: null });
      await post(order.id, "advance").expect(422);
      expect(ifood.state.actions).not.toContain("pedido-6/dispatch");
    });

    it("cancelar: mostra os motivos do iFood e pede o cancelamento com o escolhido", async () => {
      const order = await orderOf("pedido-6");
      const reasons = () => request(app.getHttpServer()).get(`/api/orders/${order.id}/cancellation-reasons`).set("Authorization", `Bearer ${token}`);
      expect((await reasons().expect(200)).body).toEqual({ reasons: [] }); // o iFood não deixa cancelar agora

      ifood.state.reasons = [
        { cancelCodeId: "501", description: "PROBLEMAS DE SISTEMA" },
        { cancelCodeId: "503", description: "ITEM INDISPONÍVEL" },
      ];
      expect((await reasons().expect(200)).body).toEqual({
        reasons: [
          { code: "501", description: "PROBLEMAS DE SISTEMA" },
          { code: "503", description: "ITEM INDISPONÍVEL" },
        ],
      });
      ifood.state.reasonsAsDocumented = true;
      expect((await reasons().expect(200)).body.reasons).toEqual(expect.arrayContaining([{ code: "503", description: "ITEM INDISPONÍVEL" }]));
      ifood.state.reasonsAsDocumented = false;

      await post(order.id, "cancel", { code: "999" }).expect(422);
      await post(order.id, "cancel", {}).expect(400);
      expect(ifood.state.cancellations).toEqual([]);

      await post(order.id, "cancel", { code: "503" }).expect(204);
      expect(ifood.state.cancellations).toEqual([{ orderId: "pedido-6", reason: "ITEM INDISPONÍVEL", cancellationCode: "503" }]);
      expect((await orderOf("pedido-6")).status).toBe("READY");

      await arrives("pedido-6", "CANCELLED", { CANCEL_CODE: "503", CANCEL_REASON: "ITEM INDISPONÍVEL" });
      const canceled = await listed(order.id);
      expect(canceled).toMatchObject({ status: "CANCELED", nextAction: null, cancelable: false });
      expect(canceled.events.at(-1)).toMatchObject({ code: "CANCELLED", detail: "ITEM INDISPONÍVEL" });
    });

    it("detalhe do pedido: pagamento com o troco, cupom e quem paga, código de coleta, documento da nota e observações", async () => {
      const base = ifoodOrder("pedido-8", "7004", "cliente-pedido-8");
      ifood.state.orders["pedido-8"] = {
        ...base,
        extraInfo: null, // o iFood manda null quando não há observação do pedido
        delivery: { ...base.delivery, deliveredBy: "MERCHANT", pickupCode: "3830", observations: "Portão azul" },
        payments: {
          prepaid: 30,
          pending: 64.8,
          methods: [
            { method: "CREDIT", type: "ONLINE", prepaid: true, value: 30, card: { brand: "Visa" } },
            { method: "CASH", type: "OFFLINE", prepaid: false, value: 64.8, cash: { changeFor: 100 } },
          ],
        },
        benefits: [
          {
            value: 10,
            target: "CART",
            sponsorshipValues: [
              { name: "IFOOD", value: 7 },
              { name: "MERCHANT", value: 3 },
              { name: "EXTERNAL", value: 0 },
            ],
          },
        ],
      };
      ifood.state.events.push(event("ev-pedido-8-PLACED", "PLACED", "pedido-8"), event("ev-pedido-8-READY", "READY_TO_PICKUP", "pedido-8"));
      await service.poll();
      const order = await listed((await orderOf("pedido-8")).id);
      expect(order.platform).toEqual({
        payments: [
          { method: "CREDIT", brand: "Visa", value: "30.00", prepaid: true, changeFor: null, change: null },
          { method: "CASH", brand: null, value: "64.80", prepaid: false, changeFor: "100.00", change: "35.20" },
        ],
        benefits: [
          {
            value: "10.00",
            sponsors: [
              { name: "IFOOD", value: "7.00" },
              { name: "MERCHANT", value: "3.00" },
            ],
          },
        ],
        pickupCode: "3830",
        document: "123.456.789-09",
        notes: ["Portão azul"],
      });
      // Com `extraInfo: null` o pedido continua legível: pronto, com entrega da loja, oferece o despacho.
      expect(order.nextAction).toBe("DISPATCH");
    });

    it("cliente pede o cancelamento (Plataforma de Negociação): a loja aceita ou recusa, uma vez, dentro do prazo", async () => {
      const order = await orderOf("pedido-8");
      const dispute = (id: string, expiresAt: Date) => ({
        id,
        action: "CANCELLATION",
        handshakeType: "PREPARATION_TIME",
        message: "Pedi errado",
        expiresAt: expiresAt.toISOString(),
        timeoutAction: "ACCEPT_CANCELLATION",
        metadata: { acceptCancellationReasons: ["CUSTOMER_REQUEST"] },
      });
      const soon = new Date(Date.now() + 5 * 60_000);
      await post(order.id, "dispute", { accept: false, reason: "HIGH_STORE_DEMAND" }).expect(422); // nada a responder

      ifood.state.events.push(event("ev-disputa-1", "HANDSHAKE_DISPUTE", "pedido-8", undefined, new Date(), dispute("disputa-1", soon)));
      await service.poll();
      expect((await listed(order.id)).dispute).toEqual({
        id: "disputa-1",
        action: "CANCELLATION",
        message: "Pedi errado",
        expiresAt: soon.toISOString(),
        timeoutAction: "ACCEPT_CANCELLATION",
        acceptReasons: ["CUSTOMER_REQUEST"],
        answerable: true,
      });

      await post(order.id, "dispute", { accept: false }).expect(422); // recusa pede motivo
      await post(order.id, "dispute", { accept: true, reason: "OUTRO" }).expect(422); // aceite: só motivo que o iFood ofereceu
      expect(ifood.state.disputes).toEqual([]);
      await post(order.id, "dispute", { accept: false, reason: "HIGH_STORE_DEMAND" }).expect(204);
      expect(ifood.state.disputes).toEqual([{ id: "disputa-1", answer: "reject", reason: "HIGH_STORE_DEMAND" }]);

      // O desfecho chega pelo polling: a negociação sai da espera e entra na linha do tempo.
      ifood.state.events.push(event("ev-acordo-1", "HANDSHAKE_SETTLEMENT", "pedido-8", undefined, new Date(), { disputeId: "disputa-1", status: "REJECTED" }));
      await service.poll();
      const settled = await listed(order.id);
      expect(settled.dispute).toBeNull();
      expect(settled.events.slice(-2)).toMatchObject([
        { code: "HANDSHAKE_DISPUTE", detail: "Pedi errado" },
        { code: "HANDSHAKE_SETTLEMENT", detail: "Recusada" },
      ]);
      await post(order.id, "dispute", { accept: true, reason: "CUSTOMER_REQUEST" }).expect(422);

      // Outra negociação, aceita com o motivo oferecido; uma vencida não fica à espera.
      ifood.state.events.push(event("ev-disputa-2", "HANDSHAKE_DISPUTE", "pedido-8", undefined, new Date(), dispute("disputa-2", soon)));
      await service.poll();
      await post(order.id, "dispute", { accept: true, reason: "CUSTOMER_REQUEST" }).expect(204);
      expect(ifood.state.disputes.at(-1)).toEqual({ id: "disputa-2", answer: "accept", reason: "CUSTOMER_REQUEST" });
      ifood.state.events.push(
        event("ev-acordo-2", "HANDSHAKE_SETTLEMENT", "pedido-8", undefined, new Date(), { disputeId: "disputa-2", status: "ACCEPTED" }),
        event("ev-disputa-3", "HANDSHAKE_DISPUTE", "pedido-8", undefined, new Date(), dispute("disputa-3", new Date(Date.now() - 60_000))),
      );
      await service.poll();
      expect((await listed(order.id)).dispute).toBeNull();
    });

    it("trava desligada (padrão): o Dish Desk só acompanha, sem oferecer nem aceitar ações", async () => {
      const env = app.get<{ IFOOD_ORDER_ACTIONS: boolean }>(ENV);
      const waiting = await placed("pedido-11", "7007", "MERCHANT");
      await arrives("pedido-11", "HANDSHAKE_DISPUTE", {
        id: "disputa-11",
        action: "CANCELLATION",
        message: "Desisti",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
      env.IFOOD_ORDER_ACTIONS = false;
      try {
        const order = await listed(waiting.id);
        expect(order).toMatchObject({ status: "PLACED", nextAction: null, cancelable: false });
        // O pedido do cliente continua visível, só não dá para responder por aqui.
        expect(order.dispute).toMatchObject({ id: "disputa-11", message: "Desisti", answerable: false });
        expect(order.platform).not.toBeNull();

        const actions = ifood.state.actions.length;
        expect((await post(waiting.id, "advance").expect(422)).body.message).toContain("só acompanha os pedidos do iFood");
        await post(waiting.id, "cancel", { code: "501" }).expect(422);
        await post(waiting.id, "dispute", { accept: false, reason: "HIGH_STORE_DEMAND" }).expect(422);
        await request(app.getHttpServer()).get(`/api/orders/${waiting.id}/cancellation-reasons`).set("Authorization", `Bearer ${token}`).expect(422);
        expect(ifood.state.actions).toHaveLength(actions);
        expect(ifood.state.disputes.some((answer) => (answer as { id: string }).id === "disputa-11")).toBe(false);
      } finally {
        env.IFOOD_ORDER_ACTIONS = true;
      }
      expect((await listed(waiting.id)).dispute).toMatchObject({ answerable: true });
    });

    it("o iFood recusa a etapa: o painel recebe o motivo, sem erro interno", async () => {
      const order = await placed("pedido-7", "7003", "MERCHANT");
      ifood.state.rejectActions = true;
      try {
        const { body } = await post(order.id, "advance").expect(422);
        expect(body.message).toContain("O iFood não aceitou");
      } finally {
        ifood.state.rejectActions = false;
      }
    });

    it("pedido de outro restaurante: não encontrado", async () => {
      const other = await createChannelFixture();
      try {
        const outsider = await accessTokenFor(app, other.user.email, other.tenant.id);
        const order = await orderOf("pedido-7");
        await request(app.getHttpServer()).post(`/api/orders/${order.id}/advance`).set("Authorization", `Bearer ${outsider}`).expect(404);
      } finally {
        await other.cleanup();
      }
    });
  });
});

describe("iFood distribuído (cada loja autoriza com o código de vinculação)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let ifood: Awaited<ReturnType<typeof startMockIfood>>;
  let service: IfoodService;
  let token: string;
  let key: Buffer;
  const merchantId = randomUUID();
  const add = (body: object) =>
    request(app.getHttpServer()).post(`/api/integrations/${fx.tenant.id}`).set("Authorization", `Bearer ${token}`).send({ type: "IFOOD", ...body });
  const storeChannel = () => admin.channel.findFirstOrThrow({ where: { tenantId: fx.tenant.id, type: "IFOOD", externalId: merchantId } });
  const storedGrant = async () => JSON.parse(decrypt((await storeChannel()).credentials, key)) as { refreshToken: string; expiresAt: string };
  /** O acesso guardado já venceu (e some da memória): a próxima chamada ao iFood precisa renová-lo. */
  const expireGrant = async () => {
    const channel = await storeChannel();
    const grant = { ...(await storedGrant()), expiresAt: new Date(Date.now() - 1000).toISOString() };
    await admin.channel.update({ where: { id: channel.id }, data: { credentials: encrypt(JSON.stringify(grant), key) } });
    app.get(IfoodAuthService).forget(channel.id);
  };

  beforeAll(async () => {
    ifood = await startMockIfood();
    app = await createTestApp({
      IFOOD_CLIENT_ID: "cliente",
      IFOOD_CLIENT_SECRET: "segredo",
      IFOOD_API_URL: ifood.url,
      IFOOD_APP_TYPE: "distributed",
    });
    await app.get<Queue>(getQueueToken(QUEUES.ifood)).removeJobScheduler("ifood-polling");
    service = app.get(IfoodService);
    key = parseEncryptionKey(app.get<{ ENCRYPTION_KEY: string }>(ENV).ENCRYPTION_KEY);
    fx = await createChannelFixture();
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await ifood?.close();
  });

  it("loja conectada antes do distribuído (sem acesso próprio): fica com erro, para conectar de novo", async () => {
    await service.poll();
    expect((await admin.channel.findUniqueOrThrow({ where: { id: fx.ifood.id } })).status).toBe("ERROR");
    expect(ifood.state.pollingMerchants).toEqual([]);
  });

  it("conectar: gera o código, troca o código de autorização pelo acesso da loja e recebe os pedidos com ele", async () => {
    const { body: list } = await request(app.getHttpServer()).get(`/api/integrations?tenantId=${fx.tenant.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(list.platform).toMatchObject({ ifood: true, ifoodLinkCode: true });

    const { body: code } = await request(app.getHttpServer())
      .post(`/api/integrations/${fx.tenant.id}/ifood/link-code`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    expect(code).toMatchObject({ userCode: "ABCD-EFGH", verificationUrl: "https://portal.ifood.com.br/apps/code?c=ABCD-EFGH", expiresIn: 600 });
    // O verificador vai cifrado para o painel.
    expect(code.state).not.toContain("verificador");

    ifood.state.authorizationCodes.set("LHQX-ZZZZ", [merchantId]);
    ifood.state.authorizationCodes.set("DUAS-LOJA", [merchantId, randomUUID()]);
    expect((await add({}).expect(422)).body.message).toContain("gere o código de vinculação");
    expect((await add({ authorizationCode: "ERRADO-00", linkState: code.state }).expect(422)).body.message).toContain("não foi aceito");
    expect((await add({ authorizationCode: "LHQX-ZZZZ", linkState: "adulterado" }).expect(422)).body.message).toContain("gere um novo");

    // Sem o módulo Merchant e com duas lojas no acesso, nenhuma conectada: o restaurante escolhe (nada é conectado ainda).
    ifood.state.noMerchantModule = true;
    const { body: choice } = await add({ authorizationCode: "DUAS-LOJA", linkState: code.state }).expect(201);
    expect(choice.ifoodStores).toEqual([
      { id: merchantId, name: null, connected: false },
      { id: expect.any(String), name: null, connected: false },
    ]);
    expect(choice.selection).not.toContain("token-ifood");
    expect(await admin.channel.count({ where: { tenantId: fx.tenant.id, type: "IFOOD", externalId: merchantId } })).toBe(0);
    // ID informado que não está na autorização: recusado.
    expect((await add({ merchantId: randomUUID(), authorizationCode: "DUAS-LOJA", linkState: code.state }).expect(422)).body.message).toContain(
      "a autorização não inclui essa loja",
    );
    ifood.state.noMerchantModule = false;

    // Sem o ID da loja: ela é a que o acesso enxerga, com o nome que o iFood dá.
    const created = await add({ authorizationCode: "LHQX-ZZZZ", linkState: code.state }).expect(201);
    expect(created.body).toMatchObject({ externalId: merchantId, name: "Loja do iFood", status: "CONNECTED" });
    expect((await storedGrant()).refreshToken).toMatch(/^refresh-\d+$/);

    ifood.state.orders["pedido-d1"] = ifoodOrder("pedido-d1", "8101", "cliente-d1");
    ifood.state.events.push({ id: "ev-d1", code: "PLC", fullCode: "PLACED", orderId: "pedido-d1", merchantId, createdAt: new Date().toISOString() });
    await service.poll();
    expect(ifood.state.pollingMerchants.at(-1)).toBe(merchantId);
    expect(ifood.state.acked).toContain("ev-d1");
    expect(await admin.order.count({ where: { channelId: created.body.id, externalOrderId: "pedido-d1" } })).toBe(1);
  });

  it("segunda loja do mesmo responsável, sem o módulo Merchant: o acesso traz as duas e vale a que falta conectar", async () => {
    const second = randomUUID();
    ifood.state.authorizationCodes.set("SEGU-NDAL", [merchantId, second]);
    ifood.state.noMerchantModule = true;
    try {
      const { body: code } = await request(app.getHttpServer())
        .post(`/api/integrations/${fx.tenant.id}/ifood/link-code`)
        .set("Authorization", `Bearer ${token}`)
        .expect(201);
      const created = await add({ authorizationCode: "SEGU-NDAL", linkState: code.state }).expect(201);
      expect(created.body).toMatchObject({ externalId: second, name: `iFood ${second.slice(0, 8)}`, status: "CONNECTED" });

      // Autorização de novo com as mesmas duas lojas, já conectadas: nada a escolher, e o motivo aparece.
      const { body: again } = await request(app.getHttpServer())
        .post(`/api/integrations/${fx.tenant.id}/ifood/link-code`)
        .set("Authorization", `Bearer ${token}`)
        .expect(201);
      expect((await add({ authorizationCode: "SEGU-NDAL", linkState: again.state }).expect(422)).body.message).toContain(
        "só trouxe lojas que já estão conectadas",
      );
      // Fora dos testes seguintes, que contam as consultas da primeira loja.
      await admin.channel.update({ where: { id: created.body.id }, data: { status: "DISCONNECTED" } });
    } finally {
      ifood.state.noMerchantModule = false;
    }
  });

  it("várias lojas na autorização: conecta as escolhidas, com o mesmo acesso renovado uma vez para todas", async () => {
    const [centro, shopping, fora] = [randomUUID(), randomUUID(), randomUUID()];
    ifood.state.authorizationCodes.set("TRES-LOJA", [centro, shopping, randomUUID()]);
    ifood.state.noMerchantModule = true;
    const ids: string[] = [];
    try {
      const { body: code } = await request(app.getHttpServer())
        .post(`/api/integrations/${fx.tenant.id}/ifood/link-code`)
        .set("Authorization", `Bearer ${token}`)
        .expect(201);
      const { body: choice } = await add({ authorizationCode: "TRES-LOJA", linkState: code.state }).expect(201);
      expect(choice.ifoodStores).toHaveLength(3);
      const choose = (body: object) =>
        request(app.getHttpServer()).post(`/api/integrations/${fx.tenant.id}/ifood/stores`).set("Authorization", `Bearer ${token}`).send(body);

      // Escolha adulterada ou de outro restaurante: recusada.
      expect((await choose({ selection: `${choice.selection}x`, stores: [{ id: centro }] }).expect(422)).body.message).toContain("expirou");

      // Loja fora da autorização fica de fora, com o motivo; as outras entram, com o nome dado ou o padrão.
      const { body: result } = await choose({ selection: choice.selection, stores: [{ id: centro, name: "Centro" }, { id: shopping }, { id: fora }] }).expect(201);
      expect(result.connected.map((store: { externalId: string; name: string }) => [store.externalId, store.name])).toEqual([
        [centro, "Centro"],
        [shopping, `iFood ${shopping.slice(0, 8)}`],
      ]);
      expect(result.failed).toEqual([{ id: fora, message: "A autorização não inclui essa loja." }]);
      ids.push(...result.connected.map((store: { id: string }) => store.id));

      // As duas vencem juntas: uma renovação só, gravada nas duas.
      const grantOf = async (id: string) =>
        JSON.parse(decrypt((await admin.channel.findUniqueOrThrow({ where: { id } })).credentials, key)) as { refreshToken: string; expiresAt: string };
      const before = await grantOf(ids[0]!);
      for (const id of ids) {
        await admin.channel.update({
          where: { id },
          data: { credentials: encrypt(JSON.stringify({ ...before, expiresAt: new Date(Date.now() - 1000).toISOString() }), key) },
        });
        app.get(IfoodAuthService).forget(id);
      }
      const refreshes = () => ifood.state.tokenRequests.filter((raw) => raw.includes("grantType=refresh_token")).length;
      const startedAt = refreshes();
      await service.poll();
      expect(refreshes() - startedAt).toBe(1);
      const [first, second] = [await grantOf(ids[0]!), await grantOf(ids[1]!)];
      expect(first.refreshToken).not.toBe(before.refreshToken);
      expect(second.refreshToken).toBe(first.refreshToken);
    } finally {
      ifood.state.noMerchantModule = false;
      // Fora dos testes seguintes, que contam as consultas da primeira loja.
      await admin.channel.updateMany({ where: { id: { in: ids } }, data: { status: "DISCONNECTED" } });
    }
  });

  it("acesso vencido: renova com o refreshToken e guarda o novo", async () => {
    const before = (await storedGrant()).refreshToken;
    await expireGrant();
    ifood.state.orders["pedido-d2"] = ifoodOrder("pedido-d2", "8102", "cliente-d2");
    ifood.state.events.push({ id: "ev-d2", code: "PLC", fullCode: "PLACED", orderId: "pedido-d2", merchantId, createdAt: new Date().toISOString() });
    await service.poll();
    expect(ifood.state.tokenRequests.at(-1)).toContain("grantType=refresh_token");
    expect(ifood.state.tokenRequests.at(-1)).toContain(`refreshToken=${before}`);
    expect((await storedGrant()).refreshToken).not.toBe(before);
    expect(await admin.order.count({ where: { tenantId: fx.tenant.id, externalOrderId: "pedido-d2" } })).toBe(1);
    expect((await storeChannel()).status).toBe("CONNECTED");
  });

  it("a loja revoga o acesso: fica com erro e sai do polling", async () => {
    ifood.state.revokedRefreshTokens.add((await storedGrant()).refreshToken);
    await expireGrant();
    await service.poll();
    expect((await storeChannel()).status).toBe("ERROR");
    const polls = ifood.state.pollingMerchants.length;
    await service.poll();
    expect(ifood.state.pollingMerchants).toHaveLength(polls);
  });
});
