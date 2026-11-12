import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { neemoTime } from "../src/connectors/neemo.client.js";
import { NeemoService } from "../src/inbound/neemo.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp } from "./helpers.js";

const TOKEN = "token-da-loja-neemo-0001";
/** Código da loja na Neemo, único por execução (o banco é o mesmo de outras execuções e do dev). */
const STORE = 900_000_000 + (Date.now() % 99_999_999);

/**
 * API de integração falsa, como a real: tudo por formulário com o `token_account`, respostas de sucesso com HTTP 201
 * e o nome da loja em `name`. Pedidos (lista paginada e detalhes), clientes (500 por página) e mudança de status.
 */
async function startMockNeemo() {
  const state = {
    orders: {} as Record<string, Record<string, unknown>>,
    customers: [] as object[],
    requests: [] as { method: string; path: string; form: Record<string, string> }[],
    refuseStatus: false,
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = new URL(req.url ?? "", "http://neemo").pathname;
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      state.requests.push({ method: req.method ?? "", path, form });
      const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (form.token_account !== TOKEN) return json(401, { code: 401, name: "Unauthorized - Falha de autenticação", error: "Unauthorized access" });
      const limit = Number(form.limit ?? 50);
      const page = Number(form.page ?? 1);
      const slice = <T>(items: T[]) => items.slice((page - 1) * limit, page * limit);
      if (path === "/v1/order" && req.method === "POST") {
        // Como a API: `modified` no horário de Brasília, sem fuso; ordem por id, do mais novo, ou pela alteração.
        let orders = Object.values(state.orders);
        if (form.modified) orders = orders.filter((o) => neemoTime(new Date(String(o.updated_at))) >= form.modified!);
        if (form.status) orders = orders.filter((o) => String(o.status) === form.status);
        orders.sort((a, b) => (form.sort === "updated_at asc" ? String(a.updated_at).localeCompare(String(b.updated_at)) : Number(b.id) - Number(a.id)));
        // A lista vem sem os itens.
        const list = slice(orders).map(({ ItemOrder: _items, restaurant_id: _store, ...summary }) => summary);
        return json(201, { code: 200, name: "Nippon", paging: { total: orders.length, limit, page }, Orders: list });
      }
      if (path === "/v1/client") return json(201, { code: 200, name: "Nippon", Clients: slice(state.customers) });
      const id = path.match(/^\/v1\/order\/(\d+)$/)?.[1];
      if (id && req.method === "POST") return state.orders[id] ? json(201, { code: 200, name: "Nippon", Order: state.orders[id] }) : json(404, {});
      if (id && req.method === "PUT") {
        if (state.refuseStatus || !state.orders[id]) return json(422, { code: 422 });
        state.orders[id] = { ...state.orders[id], status: Number(form.status), updated_at: new Date().toISOString() };
        return json(201, { code: 200 });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Pedido no formato dos detalhes da Neemo (os campos que importam aqui). */
const neemoOrder = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  restaurant_id: STORE,
  order_number: id - 70_000_000,
  status: 1,
  date: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  name: "Matheus Lessa",
  email: "matheus@teste.com",
  phone: "85994197929",
  cpf: "",
  client_id: 19265982,
  street: "Rua das Flores",
  number: "45",
  complement: "apto 12",
  reference_point: "perto da praça",
  neighborhood: "Aldeota",
  city: "Fortaleza",
  uf: "CE",
  cep: "60150000",
  forma_entrega: 1,
  tax: 6,
  sub_total: 81.79,
  total: 87.79,
  ItemOrder: [
    {
      title: "Bentô",
      name: "Bentô",
      quantity: 1,
      price: 0,
      total: 35.99,
      notes: "sem gergelim",
      ComplementCategories: [
        { title: "Escolha a proteína", Complements: [{ quantity: 1, title: "Chickenkatsu", price_un: 35.99, total: 35.99 }] },
        { title: "Escolha o arroz", Complements: [{ quantity: 1, title: "Arroz Yakimeshi", price_un: 0, total: 0 }] },
      ],
    },
    { title: "Temaki", name: "Temaki", quantity: 2, price: 0, total: 45.8, notes: "", ComplementCategories: [] },
  ],
  PizzaOrders: [],
  ComboOrders: [],
  ...extra,
});

describe("Neemo (pedidos por polling)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let neemo: Awaited<ReturnType<typeof startMockNeemo>>;
  let service: NeemoService;
  let channelId: string;
  let whatsappContactId: string;
  let token: string;

  const api = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const saved = (externalOrderId: string) =>
    admin.order.findFirstOrThrow({ where: { channelId, externalOrderId }, include: { items: true, contact: { include: { identities: true, addresses: true } } } });
  const queueIdle = async () => {
    const queue = app.get<Queue>(getQueueToken(QUEUES.neemo));
    await vi.waitFor(
      async () => {
        const counts = await queue.getJobCounts("waiting", "active", "delayed");
        expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(0);
      },
      { timeout: 30_000, interval: 100 },
    );
  };

  beforeAll(async () => {
    neemo = await startMockNeemo();
    app = await createTestApp({ NEEMO_API_URL: neemo.url, CHANNELS_DRY_RUN: "true" });
    // O teste chama o polling direto: sem o agendamento a cada minuto.
    await app.get<Queue>(getQueueToken(QUEUES.neemo)).removeJobScheduler("neemo-polling");
    service = app.get(NeemoService);
    fx = await createChannelFixture();
    channelId = (
      await admin.channel.create({
        data: {
          tenantId: fx.tenant.id,
          type: "NEEMO",
          name: "Nippon",
          externalId: `neemo-${fx.tenant.id}`,
          credentials: encrypt(JSON.stringify({ accessToken: TOKEN }), parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")),
          status: "CONNECTED",
        },
      })
    ).id;
    // O cliente já conversou pelo WhatsApp com o mesmo telefone do pedido.
    whatsappContactId = (
      await admin.contact.create({
        data: {
          tenantId: fx.tenant.id,
          name: "Matheus",
          phone: "+5585994197929",
          phoneSource: "channel",
          phoneStatus: "ok",
          identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: "5585994197929" } },
        },
      })
    ).id;
    await admin.tenantMember.update({ where: { tenantId_userId: { tenantId: fx.tenant.id, userId: fx.user.id } }, data: { role: "ADMIN" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await neemo?.close();
  });

  it("pedido novo entra no cadastro do cliente do WhatsApp (mesmo telefone), com itens, complementos e endereço", async () => {
    neemo.state.orders["71000001"] = neemoOrder(71000001);
    await service.poll();

    // Primeira leitura: as últimas 24 h, no horário de Brasília.
    const first = neemo.state.requests.find((r) => r.path === "/v1/order")!;
    expect(first.form).toMatchObject({ token_account: TOKEN, limit: "50", page: "1", sort: "updated_at asc" });
    expect(first.form.modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const lookback = Date.now() - Date.parse(first.form.modified!.replace(" ", "T") + "-03:00");
    expect(lookback).toBeGreaterThan(23.9 * 3_600_000);
    expect(lookback).toBeLessThan(24.1 * 3_600_000);

    const order = await saved("71000001");
    expect(order).toMatchObject({ displayCode: "1000001", status: "CONFIRMED", conversationId: null });
    expect([order.subtotal, order.deliveryFee, order.total].map(String)).toEqual(["81.79", "6", "87.79"]);
    expect(order.items.map((i) => [i.name, i.quantity, i.unitPrice.toString(), i.notes, i.options])).toEqual([
      ["Bentô", 1, "35.99", "sem gergelim", ["1× Chickenkatsu", "1× Arroz Yakimeshi"]],
      ["Temaki", 2, "22.9", null, []],
    ]);
    expect(order.contact.id).toBe(whatsappContactId);
    expect(order.contact).toMatchObject({ name: "Matheus", email: "matheus@teste.com" }); // só completa o que falta
    expect(order.contact.identities.map((i) => [i.channelType, i.externalId])).toEqual(
      expect.arrayContaining([
        ["NEEMO", "19265982"],
        ["WHATSAPP", "5585994197929"],
      ]),
    );
    expect(order.contact.addresses).toEqual([expect.objectContaining({ street: "Rua das Flores", number: "45", state: "CE", label: "Entrega Neemo" })]);
    expect(order.deliveryAddress).toMatchObject({ street: "Rua das Flores", reference: "perto da praça", state: "CE" });
  });

  it("lê todas as páginas da lista; retirada fica sem endereço e aparece como retirada na aba Pedidos", async () => {
    const before = neemo.state.requests.length;
    for (let n = 0; n < 51; n++) neemo.state.orders[String(71000100 + n)] = neemoOrder(71000100 + n);
    neemo.state.orders["71000200"] = neemoOrder(71000200, { forma_entrega: 2, street: "", city: "", number: "" });
    await service.poll();

    const pages = neemo.state.requests.slice(before).filter((r) => r.path === "/v1/order").map((r) => r.form.page);
    expect(pages).toEqual(["1", "2"]);
    expect(await admin.order.count({ where: { channelId } })).toBe(53);
    expect((await saved("71000200")).deliveryAddress).toBeNull();
    const { body } = await api().get("/api/orders?period=today&channel=NEEMO").set(auth()).expect(200);
    const takeout = (id: string) => body.items.find((o: { displayCode: string }) => o.displayCode === id).takeout;
    expect([takeout("1000200"), takeout("1000150")]).toEqual([true, false]);
  });

  it("status alterado na Neemo atualiza o pedido e a linha do tempo; cancelado fora do Dish Desk guarda a hora", async () => {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    neemo.state.orders["71000001"] = { ...neemo.state.orders["71000001"]!, status: 4, updated_at: at(0) };
    neemo.state.orders["71000100"] = { ...neemo.state.orders["71000100"]!, status: 3, updated_at: at(0) };
    // Retirada: o "enviado" da Neemo é o pedido pronto, esperando o cliente.
    neemo.state.orders["71000200"] = { ...neemo.state.orders["71000200"]!, status: 4, updated_at: at(0) };
    await service.poll();

    const ready = await saved("71000200");
    expect(ready).toMatchObject({ status: "READY", dispatchedAt: null });
    expect((await admin.orderEvent.findMany({ where: { orderId: ready.id } })).map((e) => e.code)).toContain("READY_TO_PICKUP");

    const dispatched = await saved("71000001");
    expect(dispatched.status).toBe("DISPATCHED");
    expect(dispatched.dispatchedAt).toBeInstanceOf(Date);
    const events = await admin.orderEvent.findMany({ where: { orderId: dispatched.id }, orderBy: { occurredAt: "asc" } });
    // Lido já confirmado: feito e confirmado têm a mesma hora; depois, a saída.
    expect(events.map((e) => e.code).sort()).toEqual(["CONFIRMED", "DISPATCHED", "PLACED"]);
    expect(events.at(-1)!.code).toBe("DISPATCHED");
    const canceled = await saved("71000100");
    expect(canceled).toMatchObject({ status: "CANCELED", cancellationReason: null });
    expect(canceled.canceledAt).toBeInstanceOf(Date);
  });

  it("cancelar pelo Dish Desk: muda o status na Neemo para cancelado pelo restaurante; o motivo fica só no Dish Desk", async () => {
    const order = await saved("71000101");
    const options = await api().get(`/api/orders/${order.id}/cancellation-reasons`).set(auth()).expect(200);
    expect(options.body).toMatchObject({ reasons: [], reasonMode: "text", address: "Rua das Flores, 45 · apto 12 · Aldeota" });

    neemo.state.refuseStatus = true;
    const refused = await api().post(`/api/orders/${order.id}/cancel`).set(auth()).send({ reason: "Suspeita" }).expect(422);
    expect(refused.body.message).toBe("A Neemo não aceitou e o pedido continua ativo. Tente de novo ou cancele no painel da Neemo.");
    neemo.state.refuseStatus = false;

    await api().post(`/api/orders/${order.id}/cancel`).set(auth()).send({ reason: "Suspeita de golpe" }).expect(204);
    const put = neemo.state.requests.filter((r) => r.method === "PUT");
    expect(put.at(-1)).toEqual({ method: "PUT", path: "/v1/order/71000101", form: { token_account: TOKEN, status: "3" } });
    expect(await admin.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "CANCELED", cancellationReason: "Suspeita de golpe" });
  });

  it("base de clientes: lê as páginas de 500 até a incompleta, junta pelo telefone e não repete quem já está ligado", async () => {
    const whatsappOnly = await admin.contact.create({ data: { tenantId: fx.tenant.id, phone: "+5585977776666", phoneSource: "channel", phoneStatus: "ok" } });
    // Primeira página cheia (500), só com e-mail; a segunda traz os casos que importam.
    neemo.state.customers = [
      ...Array.from({ length: 500 }, (_, n) => ({ id: 500_000 + n, name: `Cliente ${n}`, email: `cliente${n}@teste.com`, ddd: "", phone: "", cpf: null })),
      { id: 19265982, name: "Matheus Lessa", email: "matheus@teste.com", ddd: "85", phone: "994197929", cpf: null }, // já ligado pelo pedido
      { id: 2002, name: "Carlos Lima", email: "", ddd: "85", phone: "977776666", cpf: null },
      { id: 2003, name: "Só Nome", email: "", ddd: "85", phone: "123", cpf: null },
    ];
    const before = neemo.state.requests.length;
    await service.importCustomers({ tenantId: fx.tenant.id, channelId, page: 1, imported: 0 });
    await queueIdle();

    expect(neemo.state.requests.slice(before).map((r) => [r.path, r.form.page, r.form.limit])).toEqual([
      ["/v1/client", "1", "500"],
      ["/v1/client", "2", "500"],
    ]);
    const identities = await admin.contactIdentity.findMany({ where: { tenantId: fx.tenant.id, channelType: "NEEMO" }, include: { contact: true } });
    expect(identities).toHaveLength(502); // 500 + Carlos + Matheus (pelo pedido)
    const carlos = identities.find((i) => i.externalId === "2002")!.contact;
    expect(carlos).toMatchObject({ id: whatsappOnly.id, name: "Carlos Lima", phone: "+5585977776666", lastSeenAt: null });
    expect(identities.find((i) => i.externalId === "19265982")!.contactId).toBe(whatsappContactId);
    expect(await admin.contact.count({ where: { tenantId: fx.tenant.id, name: "Só Nome" } })).toBe(0);
  });

  it("conectar pelo painel: testa o token, usa o código e o nome da loja na Neemo e importa a base de clientes", async () => {
    const add = (body: object) => api().post(`/api/integrations/${fx.tenant.id}`).set(auth()).send(body);
    const refused = await add({ type: "NEEMO", apiKey: "token-errado-da-loja" }).expect(422);
    expect(refused.body.message).toBe("Não foi possível conectar a Neemo: a credencial não foi aceita.");

    // A mesma loja já conectada (canal do teste) troca de código: o novo canal vem da API.
    await admin.channel.update({ where: { id: channelId }, data: { externalId: String(STORE) } });
    const queue = app.get<Queue>(getQueueToken(QUEUES.neemo));
    const { body } = await add({ type: "NEEMO", apiKey: TOKEN }).expect(201);
    expect(body).toMatchObject({ id: channelId, type: "NEEMO", name: "Nippon", externalId: String(STORE), status: "CONNECTED" });
    const jobs = (await queue.getJobs(["waiting", "active", "delayed", "completed"])).filter((job) => job.name === "import-customers" && job.data.page === 1);
    expect(jobs.map((job) => job.data)).toContainEqual({ tenantId: fx.tenant.id, channelId, page: 1, imported: 0 });
    await queueIdle();
  });

  it("histórico: importa os cancelamentos antigos de cada status cancelado, com o andamento", async () => {
    const old = (id: number, status: number, daysAgo: number) =>
      neemoOrder(id, { status, date: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), updated_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() });
    neemo.state.orders["60000001"] = old(60000001, 3, 200);
    neemo.state.orders["60000002"] = old(60000002, 6, 90);
    neemo.state.orders["60000003"] = old(60000003, 2, 100); // entregue: fica de fora

    const { body } = await api().post(`/api/integrations/${fx.tenant.id}/${channelId}/order-history`).set(auth()).expect(200);
    expect(body.orderHistory).toMatchObject({ status: "running", progress: 0 });
    await queueIdle();

    const { orderHistoryImport } = await admin.channel.findUniqueOrThrow({ where: { id: channelId } });
    // 60000001 e 60000002, mais os dois cancelados que já estavam gravados (71000100 e 71000101), que não se repetem.
    expect(orderHistoryImport).toMatchObject({ status: "done", progress: 100, imported: 2 });
    expect(Date.parse((orderHistoryImport as { from: string }).from)).toBeLessThan(Date.now() - 199 * 86_400_000);
    const imported = await admin.order.findMany({
      where: { channelId, externalOrderId: { in: ["60000001", "60000002", "60000003"] } },
      orderBy: { externalOrderId: "asc" },
    });
    expect(imported.map((o) => [o.externalOrderId, o.status, Boolean(o.importedAt)])).toEqual([
      ["60000001", "CANCELED", true],
      ["60000002", "CANCELED", true],
    ]);
  });
});
