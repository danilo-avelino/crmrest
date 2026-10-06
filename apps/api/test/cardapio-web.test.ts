import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encrypt, parseEncryptionKey } from "@comanda/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CardapioWebService } from "../src/inbound/cardapio-web.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { admin, createChannelFixture, createTestApp, drainQueues, metaPayload, postMetaWebhook, startMockGraph } from "./helpers.js";

/** API de parceiros falsa: pedidos alterados (polling) e detalhes do pedido, com a chave da loja. */
async function startMockCardapioWeb() {
  const state = { updated: [] as object[], orders: {} as Record<string, object>, since: [] as string[] };
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
    expect(content.at(-2)!.text).toBe("Pedido confirmado 👍 Enquanto um atendente chega, já nos conte o problema ou a sua dúvida, assim agilizamos o atendimento.");
  });
});
