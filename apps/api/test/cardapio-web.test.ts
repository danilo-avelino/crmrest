import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CardapioWebService } from "../src/inbound/cardapio-web.service.js";
import type { CardapioWebImportJob } from "../src/queues/queues.module.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { admin, createChannelFixture, createTestApp, drainQueues, metaPayload, postMetaWebhook, startMockGraph } from "./helpers.js";

/** API de parceiros falsa: pedidos alterados (polling), detalhes do pedido e base de clientes, com a chave da loja. */
async function startMockCardapioWeb() {
  const state = {
    updated: [] as object[],
    orders: {} as Record<string, object>,
    since: [] as string[],
    customerPages: [] as object[][],
    customerRequests: [] as string[],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://cardapio.web");
    const json = (status: number, body?: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));
    if (req.headers["x-api-key"] !== "chave-da-loja") return json(401);
    if (url.pathname === "/api/partner/v1/orders") {
      const since = url.searchParams.get("updated_since") ?? "";
      state.since.push(since);
      // Como a API real: updated_since de no máximo 24 horas atrás.
      if (since && Date.now() - Date.parse(since) > 24 * 3_600_000) {
        return json(400, { code: 4000, message: "Parâmetros inválidos.", details: "updated_since deve ser depois de 24 horas atrás" });
      }
      return json(200, state.updated);
    }
    if (url.pathname === "/api/partner/v1/merchant/customers") {
      state.customerRequests.push(url.search);
      const page = Number(url.searchParams.get("page"));
      const total = state.customerPages.reduce((sum, customers) => sum + customers.length, 0);
      const pagination = { current_page: page, total_pages: state.customerPages.length, total_customers: total };
      return json(200, { customers: state.customerPages[page - 1] ?? [], pagination });
    }
    const id = url.pathname.match(/^\/api\/partner\/v1\/orders\/(\d+)$/)?.[1];
    if (id) return state.orders[id] ? json(200, state.orders[id]) : json(404);
    return json(404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cwOrder = (id: number, displayId: number, salesChannel = "catalog") => ({
  id,
  display_id: displayId,
  external_display_id: null,
  status: "confirmed",
  order_type: "delivery",
  sales_channel: salesChannel,
  delivery_fee: 6,
  total: 51.8,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  fiscal_document: null,
  customer: { id: 1574794, name: "Matheus Lessa", phone: "85994197929", ddi: "55" },
  delivery_address: {
    street: "Rua das Flores",
    number: "45",
    neighborhood: "Aldeota",
    city: "Fortaleza",
    state: "CE",
    complement: null,
    reference: null,
    postal_code: "60150000",
  },
  items: [{ item_id: 1, name: "Hambúrguer", quantity: 2, unit_price: 12.9, total_price: 45.8, observation: "sem cebola", options: [] }],
});
const summary = (order: { id: number; sales_channel: string }, status: string) => ({
  id: order.id,
  status,
  order_type: "delivery",
  sales_channel: order.sales_channel,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

describe("Cardápio Web (pedidos por polling)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let cardapioWeb: Awaited<ReturnType<typeof startMockCardapioWeb>>;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let service: CardapioWebService;
  let channelId: string;
  let whatsappContactId: string;

  beforeAll(async () => {
    cardapioWeb = await startMockCardapioWeb();
    graph = await startMockGraph();
    app = await createTestApp({ CARDAPIO_WEB_API_URL: cardapioWeb.url, CHANNELS_DRY_RUN: "false", META_GRAPH_URL: graph.url });
    // O teste chama o polling direto: sem o agendamento a cada 30s.
    await app.get<Queue>(getQueueToken(QUEUES.cardapioWeb)).removeJobScheduler("cardapio-web-polling");
    service = app.get(CardapioWebService);
    fx = await createChannelFixture();
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
    channelId = (
      await admin.channel.create({
        data: {
          tenantId: fx.tenant.id,
          type: "CARDAPIO_WEB",
          name: "Cardápio Web",
          externalId: `loja-${fx.tenant.id}`,
          credentials: encrypt(JSON.stringify({ accessToken: "chave-da-loja" }), key),
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
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await cardapioWeb?.close();
    await graph?.close();
  });

  it("pedido novo entra no cadastro do cliente do WhatsApp (mesmo telefone), sem abrir conversa", async () => {
    const order = cwOrder(9001, 48);
    cardapioWeb.state.orders["9001"] = order;
    cardapioWeb.state.updated = [summary(order, "confirmed")];
    await service.poll();

    // Primeira leitura: o máximo que a API aceita (24 h).
    const lookback = Date.now() - Date.parse(cardapioWeb.state.since[0]!);
    expect(lookback).toBeGreaterThan(23 * 3_600_000);
    expect(lookback).toBeLessThan(24 * 3_600_000);
    const saved = await admin.order.findFirstOrThrow({
      where: { channelId, externalOrderId: "9001" },
      include: { items: true, contact: { include: { identities: true, addresses: true } } },
    });
    expect(saved).toMatchObject({ displayCode: "48", status: "CONFIRMED", conversationId: null });
    expect([saved.subtotal, saved.deliveryFee, saved.total].map(String)).toEqual(["45.8", "6", "51.8"]);
    expect(saved.items.map((i) => [i.name, i.quantity, i.unitPrice.toString(), i.notes])).toEqual([["Hambúrguer", 2, "22.9", "sem cebola"]]);
    expect(saved.contact.id).toBe(whatsappContactId);
    expect(saved.contact.name).toBe("Matheus"); // dados existentes não são sobrescritos
    expect(saved.contact.identities.map((i) => [i.channelType, i.externalId])).toEqual(
      expect.arrayContaining([
        ["CARDAPIO_WEB", "1574794"],
        ["WHATSAPP", "5585994197929"],
      ]),
    );
    expect(saved.contact.identities).toHaveLength(2);
    expect(saved.contact.addresses).toEqual([expect.objectContaining({ street: "Rua das Flores", number: "45", label: "Entrega Cardápio Web" })]);
  });

  it("status alterado atualiza o pedido; pedidos do iFood repassados pelo Cardápio Web ficam de fora", async () => {
    const fromIfood = cwOrder(9002, 49, "ifood");
    cardapioWeb.state.orders["9002"] = fromIfood;
    cardapioWeb.state.updated = [summary(cwOrder(9001, 48), "released"), summary(fromIfood, "confirmed")];
    await service.poll();

    // A segunda leitura continua de onde a primeira parou (com uma pequena sobreposição).
    expect(Date.now() - Date.parse(cardapioWeb.state.since.at(-1)!)).toBeLessThan(5 * 60_000);
    const saved = await admin.order.findFirstOrThrow({ where: { channelId, externalOrderId: "9001" } });
    expect(saved.status).toBe("DISPATCHED");
    expect(saved.dispatchedAt).toBeInstanceOf(Date);
    expect(await admin.order.count({ where: { channelId, externalOrderId: "9002" } })).toBe(0); // o restaurante tem o iFood conectado
  });

  it("depois de mais de um dia sem ler, volta só as 24 h que a API aceita (sem travar em erro)", async () => {
    cardapioWeb.state.updated = [];
    const later = Date.now() + 25 * 3_600_000;
    vi.useFakeTimers({ toFake: ["Date"], now: later });
    try {
      await service.poll();
    } finally {
      vi.useRealTimers();
    }
    expect(later - Date.parse(cardapioWeb.state.since.at(-1)!)).toBeLessThan(24 * 3_600_000);
  });

  it("no WhatsApp, o pedido do Cardápio Web é achado pelo telefone do cadastro, sem pedir o número", async () => {
    const say = async (id: string, body: string) => {
      await postMetaWebhook(
        app,
        metaPayload(fx.whatsapp.externalId, {
          contacts: [{ profile: { name: "Matheus" }, wa_id: "5585994197929" }],
          messages: [{ from: "5585994197929", id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
        }),
      ).expect(200);
      await drainQueues(app);
    };
    await say("wamid.CW1", "Oi");
    await say("wamid.CW2", "1");
    await say("wamid.CW3", "1");

    const conversation = await admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, contactId: whatsappContactId, channelId: fx.whatsapp.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    const order = await admin.order.findFirstOrThrow({ where: { channelId, externalOrderId: "9001" } });
    const content = conversation.messages.map((m) => m.content as { event?: string; text?: string; automation?: string });
    expect(content).toContainEqual({ event: "order", orderId: order.id });
    expect(content.some((c) => c.event === "contacts_merged")).toBe(false); // mesmo cadastro desde o pedido
    expect(content.flatMap((c) => (c.automation ? [c.automation] : []))).toEqual(["menu", "order_lookup", "order_confirmed"]);
    expect(content.find((c) => c.automation === "order_lookup")!.text).toMatch(/^Encontramos o pedido #48 \(saiu para entrega\):\n/);
    // O pedido já saiu para entrega: a confirmação diz quando saiu, no lugar da previsão.
    expect(content.find((c) => c.automation === "order_confirmed")!.text).toMatch(
      /^Pedido confirmado 👍\n🛵 Seu pedido já saiu para entrega às \d{2}:\d{2} \(.+\)\.\n\nEnquanto um atendente chega, já nos conte o problema ou a sua dúvida, assim agilizamos o atendimento\.$/,
    );
  });

  it("saiu para entrega e entregue com a conversa do cliente em andamento: avisa uma vez cada, pelo WhatsApp", async () => {
    const order = cwOrder(9003, 50);
    cardapioWeb.state.orders["9003"] = order;
    cardapioWeb.state.updated = [summary(order, "confirmed")];
    await service.poll();
    const conversation = { tenantId: fx.tenant.id, contactId: whatsappContactId, channelId: fx.whatsapp.id };
    const notices = async () =>
      (await admin.message.findMany({ where: { conversation }, orderBy: { createdAt: "asc" } }))
        .map((m) => m.content as { automation?: string; text?: string })
        .filter((c) => c.automation === "order_dispatched" || c.automation === "order_delivered");
    expect(await notices()).toEqual([]); // confirmado não avisa

    const sentBefore = graph.requests.length;
    cardapioWeb.state.updated = [summary(order, "released")];
    await service.poll();
    await drainQueues(app);
    expect(await notices()).toEqual([
      { automation: "order_dispatched", text: expect.stringMatching(/^🛵 Boa notícia! Seu pedido #50 saiu para entrega às \d{2}:\d{2}\.$/) },
    ]);
    expect(graph.requests.slice(sentBefore).map((r) => r.body)).toEqual([
      expect.objectContaining({ to: "5585994197929", text: expect.objectContaining({ body: expect.stringContaining("#50 saiu para entrega") }) }),
    ]);

    // O mesmo status lido de novo (a leitura se sobrepõe) não repete o aviso.
    await service.poll();
    await drainQueues(app);
    expect(await notices()).toHaveLength(1);

    cardapioWeb.state.updated = [summary(order, "delivered")];
    await service.poll();
    await drainQueues(app);
    expect((await notices()).at(-1)).toEqual({ automation: "order_delivered", text: "✅ Seu pedido #50 foi entregue! Bom apetite 😋" });
    // "closed" também é entregue: não repete.
    cardapioWeb.state.updated = [summary(order, "closed")];
    await service.poll();
    await drainQueues(app);
    expect(await notices()).toHaveLength(2);
  });

  it("base de clientes: importa todas as páginas, junta pelo telefone, não repete quem já está ligado nem traz quem só tem nome", async () => {
    // Cliente que só falou pelo WhatsApp, sem nome no cadastro.
    const whatsappOnly = await admin.contact.create({
      data: { tenantId: fx.tenant.id, phone: "+5585977776666", phoneSource: "channel", phoneStatus: "ok" },
    });
    const customer = (id: number, data: object) => ({ id, created_at: "2024-03-10T12:00:00.000-03:00", loyalty_points: 0, ...data });
    cardapioWeb.state.customerPages = [
      [
        // Já ligado ao cadastro pelo pedido 9001: fica como está.
        customer(1574794, { name: "Matheus Lessa", phone_number: "85994197929", ddi: "55", notifications_enabled: true }),
        customer(2001, {
          name: "Ana Souza",
          phone_number: "85988887777",
          ddi: "55",
          email: "ana@teste.com",
          birth_date: "1990-05-12",
          notifications_enabled: false,
        }),
      ],
      [
        customer(2002, { name: "Carlos Lima", phone_number: "85977776666", ddi: "55", email: null, birth_date: null }),
        customer(2003, { name: "Sem Telefone", phone_number: null, ddi: null, email: "sem.telefone@teste.com", birth_date: "00/00/0000" }),
        // Só nome (telefone inválido, sem e-mail): fica de fora.
        customer(2004, { name: "Só Nome", phone_number: "123", ddi: "55", email: null, birth_date: "1985-01-01" }),
      ],
    ];
    const queue = app.get<Queue>(getQueueToken(QUEUES.cardapioWeb));
    const importAll = async () => {
      await service.importCustomers({ tenantId: fx.tenant.id, channelId, page: 1, imported: 0 });
      // As páginas seguintes vêm pela fila.
      await vi.waitFor(
        async () => {
          const counts = await queue.getJobCounts("waiting", "active", "delayed");
          expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(0);
        },
        { timeout: 15_000, interval: 100 },
      );
    };
    await importAll();

    expect(cardapioWeb.state.customerRequests).toEqual(["?page=1&per_page=50", "?page=2&per_page=50"]);
    const imported = await admin.contactIdentity.findMany({
      where: { tenantId: fx.tenant.id, channelType: "CARDAPIO_WEB" },
      include: { contact: { include: { consents: true } } },
      orderBy: { externalId: "asc" },
    });
    expect(imported.map((i) => i.externalId)).toEqual(["1574794", "2001", "2002", "2003"]);
    const [matheus, ana, carlos, semTelefone] = imported.map((i) => i.contact);
    expect(matheus).toMatchObject({ id: whatsappContactId, name: "Matheus" });
    expect(ana).toMatchObject({ name: "Ana Souza", phone: "+5585988887777", email: "ana@teste.com", lastSeenAt: null });
    expect(ana!.birthDate?.toISOString()).toBe("1990-05-12T00:00:00.000Z");
    expect(ana!.firstSeenAt.toISOString()).toBe("2024-03-10T15:00:00.000Z");
    expect(ana!.consents).toEqual([expect.objectContaining({ purpose: "marketing_whatsapp", granted: false, source: "cardapio_web" })]);
    expect(carlos).toMatchObject({ id: whatsappOnly.id, name: "Carlos Lima", phone: "+5585977776666" });
    expect(carlos!.consents).toEqual([]);
    expect(semTelefone).toMatchObject({ name: "Sem Telefone", phone: null, email: "sem.telefone@teste.com", birthDate: null });
    expect(await admin.contact.count({ where: { tenantId: fx.tenant.id, name: "Só Nome" } })).toBe(0);

    // Conectar de novo importa outra vez sem duplicar ninguém.
    const contactsBefore = await admin.contact.count({ where: { tenantId: fx.tenant.id } });
    await importAll();
    expect(await admin.contact.count({ where: { tenantId: fx.tenant.id } })).toBe(contactsBefore);
    expect(await admin.consent.count({ where: { tenantId: fx.tenant.id, source: "cardapio_web" } })).toBe(1);
  });

  it("base de clientes: loja desconectada no meio da importação para de ler", async () => {
    await admin.channel.update({ where: { id: channelId }, data: { status: "DISCONNECTED" } });
    const requests = cardapioWeb.state.customerRequests.length;
    const job: CardapioWebImportJob = { tenantId: fx.tenant.id, channelId, page: 2, imported: 10 };
    await service.importCustomers(job);
    expect(cardapioWeb.state.customerRequests).toHaveLength(requests);
    await admin.channel.update({ where: { id: channelId }, data: { status: "CONNECTED" } });
  });

  it("conversa resolvida não recebe o aviso de saída", async () => {
    await admin.conversation.updateMany({ where: { tenantId: fx.tenant.id, contactId: whatsappContactId }, data: { status: "RESOLVED" } });
    const order = cwOrder(9004, 51);
    cardapioWeb.state.orders["9004"] = order;
    cardapioWeb.state.updated = [summary(order, "confirmed")];
    await service.poll();
    cardapioWeb.state.updated = [summary(order, "released")];
    await service.poll();
    await drainQueues(app);
    const texts = (await admin.message.findMany({ where: { tenantId: fx.tenant.id, conversation: { contactId: whatsappContactId } } })).map(
      (m) => (m.content as { text?: string }).text ?? "",
    );
    expect(texts.some((text) => text.includes("#51"))).toBe(false);
  });
});
