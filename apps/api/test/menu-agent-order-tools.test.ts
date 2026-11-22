import { randomUUID } from "node:crypto";
import { createPrismaClient, withTenants } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderAgentRules } from "../src/menu-agent/order-agent.service.js";
import { type MenuAgentDeps, menuAgentTools } from "../src/menu-agent/tools/index.js";
import { type AgentOrders, orderTools } from "../src/menu-agent/tools/order-tools.js";
import { isPixImageUrl } from "../src/outbound/outbound.processor.js";
import type { CreatePixInput, PixCharge, PixProvider, PixStatus } from "../src/payments/pix.js";
import { type PixPending, PublicOrderService } from "../src/public/public-order.service.js";
import { admin, createAuthFixture, createTestApp } from "./helpers.js";

class FakePix implements PixProvider {
  readonly name = "pagarme";
  configured = true;
  charges: CreatePixInput[] = [];
  statusOf = new Map<string, PixStatus>();
  async createCharge(input: CreatePixInput): Promise<PixCharge> {
    this.charges.push(input);
    const id = `or_${input.reference.slice(0, 8)}`;
    this.statusOf.set(id, "PENDING");
    return { providerOrderId: id, chargeId: "ch_1", qrCode: "00020126PIXAGENTE", qrCodeUrl: "https://api.pagar.me/qr.png", expiresAt: new Date(Date.now() + 15 * 60_000), status: "PENDING" };
  }
  async status(id: string): Promise<PixStatus> {
    return this.statusOf.get(id) ?? "PENDING";
  }
}

const STORE = {
  address: { street: "Rua", number: "1", district: "Centro", city: "São Paulo", state: "SP", zip: "" },
  pickupEnabled: true,
  prepMinutes: 20,
  delivery: { mode: "BY_DISTRICT", districts: [{ district: "Centro", feeCents: 500 }] },
  minOrderCents: 0,
  deliveryMinMinutes: 30,
  deliveryMaxMinutes: 50,
  paymentMethods: ["pix", "cash"],
  pixRecipientId: "re_agente12345",
  scheduling: { enabled: false, minLeadMinutes: 30, slotMinutes: 30 },
  promoShowcase: { itemIds: [], frequencyHours: 24 },
};

// O agente fecha o pedido (F4-03): pagar na entrega ou Pix, com as mesmas regras do site.
describe("Agente de pedidos: confirmar_pedido, gerar_pix e consultar_pagamento (F4-03)", () => {
  const db = createPrismaClient(process.env.DATABASE_URL ?? "");
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let pix: FakePix;
  let orders: AgentOrders;
  let pizza = "";
  let size = "";
  let contactId = "";
  let conversationId = "";
  let generated: PixPending[] = [];

  const deps = (): MenuAgentDeps => ({ db: { withTenants: (scope, fn) => withTenants(db, scope, fn) } });
  async function call(name: string, input: object = {}, withOrders = true) {
    const session = { conversationId, contactId };
    const tools = [...menuAgentTools(deps(), session), ...orderTools(deps(), session, withOrders ? orders : null, (p) => generated.push(p))];
    const tool = tools.find((t) => t.name === name)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await tool.handler(tool.inputSchema.parse(input), { tenantId: fx.a.id })) as any;
  }
  const newConversation = async () => {
    const channel = await admin.channel.findFirstOrThrow({ where: { tenantId: fx.a.id, type: "WHATSAPP" } });
    conversationId = (await admin.conversation.create({ data: { tenantId: fx.a.id, contactId, channelId: channel.id, status: "OPEN" } })).id;
  };
  const fillCart = async () => {
    await call("adicionar_ao_carrinho", { itemId: pizza, tamanhoId: size });
    await call("definir_dados_entrega", { modo: "retirada" });
  };

  beforeAll(async () => {
    app = await createTestApp();
    pix = new FakePix();
    const services = app.get(PublicOrderService, { each: true });
    for (const service of services) service.pix = pix;
    orders = { place: (t, c, i) => services[0]!.placeForAgent(t, c, i), pixStatus: (t, id) => services[0]!.pixStatusFor(t, id), contextLink: (t, c) => services[0]!.contextLink(t, c) };
    fx = await createAuthFixture();
    await admin.tenantModule.create({ data: { tenantId: fx.a.id, module: "MENU" } });
    await admin.tenant.update({ where: { id: fx.a.id }, data: { settings: { menuStore: STORE } } });
    const menu = await admin.menu.create({ data: { tenantId: fx.a.id, name: "Cardápio" } });
    const category = await admin.menuCategory.create({ data: { tenantId: fx.a.id, menuId: menu.id, name: "Pizzas" } });
    const item = await admin.menuItem.create({
      data: { tenantId: fx.a.id, categoryId: category.id, name: "Calabresa", sizes: { create: [{ tenantId: fx.a.id, name: "G", priceCents: 5000 }] } },
      include: { sizes: true },
    });
    pizza = item.id;
    size = item.sizes[0]!.id;
    await admin.channel.create({
      data: { tenantId: fx.a.id, type: "WHATSAPP", name: "+55 11 90000-0009", externalId: `wa-f403-${randomUUID()}`, credentials: new Uint8Array(), status: "CONNECTED" },
    });
    contactId = (await admin.contact.create({ data: { tenantId: fx.a.id, name: "Bruna", phone: "+5511977776666" } })).id;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await db.$disconnect();
    await app?.close();
  });

  it("sem o resumo confirmado não fecha; com ele, cria o pedido uma vez e fecha o carrinho", async () => {
    await newConversation();
    await fillCart();
    expect(await call("confirmar_pedido", { formaDePagamento: "cash" })).toMatchObject({ ok: false, codigo: "RESUMO_PENDENTE" });
    await call("resumir_pedido");
    const done = await call("confirmar_pedido", { formaDePagamento: "cash" });
    expect(done).toMatchObject({ ok: true, pedido: expect.any(String) });
    const cart = await admin.cart.findFirstOrThrow({ where: { conversationId } });
    expect(cart).toMatchObject({ status: "CHECKED_OUT", orderId: expect.any(String) });
    expect(await admin.order.findUniqueOrThrow({ where: { id: cart.orderId! } })).toMatchObject({ source: "MENU", paymentMethod: "CASH", contactId, externalOrderId: cart.id, raw: expect.objectContaining({ origin: "whatsapp_ai" }) });
    // Chamada dupla: o carrinho já fechou, nada novo.
    expect(await call("confirmar_pedido", { formaDePagamento: "cash" })).toMatchObject({ ok: false, codigo: "CARRINHO_VAZIO" });
    expect(await admin.order.count({ where: { tenantId: fx.a.id, externalOrderId: cart.id } })).toBe(1);
  });

  it("forma que a loja não aceita volta a recusa com o motivo", async () => {
    await newConversation();
    await fillCart();
    await call("resumir_pedido");
    expect(await call("confirmar_pedido", { formaDePagamento: "credit" })).toMatchObject({ ok: false, codigo: "PAYMENT_METHOD_UNAVAILABLE" });
  });

  it("gerar_pix exige CPF, cobra sem criar o pedido; pago na fonte, consultar_pagamento mostra o pedido", async () => {
    await newConversation();
    await fillCart();
    await call("resumir_pedido");
    expect(await call("gerar_pix", { cpf: "111.111.111-11" })).toMatchObject({ ok: false, codigo: "CPF_REQUIRED" });
    generated = [];
    const result = await call("gerar_pix", { cpf: "529.982.247-25" });
    expect(result).toMatchObject({ ok: true, valor: { centavos: 5000 } });
    expect(JSON.stringify(result)).not.toContain("00020126PIXAGENTE");
    expect(generated).toHaveLength(1);
    expect(pix.charges.at(-1)).toMatchObject({ recipientId: "re_agente12345", amountCents: 5000 });
    const cart = await admin.cart.findFirstOrThrow({ where: { conversationId } });
    expect(cart.status).toBe("AWAITING_CONFIRMATION");
    expect(await call("consultar_pagamento")).toMatchObject({ ok: true, situacao: "PENDING" });
    const payment = await admin.payment.findFirstOrThrow({ where: { cartId: cart.id } });
    pix.statusOf.set(payment.txid!, "PAID");
    const paid = await call("consultar_pagamento");
    expect(paid).toMatchObject({ ok: true, situacao: "PAID", pedido: expect.any(String) });
    const order = await admin.order.findFirstOrThrow({ where: { tenantId: fx.a.id, externalOrderId: cart.id } });
    expect(order).toMatchObject({ paymentMethod: "PIX", contactId });
    expect((await admin.cart.findUniqueOrThrow({ where: { id: cart.id } })).status).toBe("CHECKED_OUT");
    expect(await admin.funnelEvent.findFirst({ where: { orderId: order.id, stage: "PURCHASE" } })).toMatchObject({ channel: "WHATSAPP" });
  });

  it("link com contexto (F3-11): o site abre a sacola da conversa; link adulterado ou de outra loja não abre; o pedido do site fecha o carrinho", async () => {
    await newConversation();
    await fillCart();
    const { link } = await call("link_do_cardapio");
    const slug = (await admin.tenant.findUniqueOrThrow({ where: { id: fx.a.id }, select: { slug: true } })).slug;
    expect(link).toContain(`/c/${slug}?c=`);
    const token = new URL(link).searchParams.get("c")!;
    const ctx = (c: string, s = slug) => request(app.getHttpServer()).get(`/api/public/menu/${s}/context`).query({ c });
    expect((await ctx(token).expect(200)).body).toEqual({ lines: [{ itemId: pizza, sizeId: size, optionIds: [], halves: [], quantity: 1, note: null }] });
    await ctx(`${token.slice(0, -2)}xx`).expect(404);
    const other = await admin.tenant.findUniqueOrThrow({ where: { id: fx.b.id }, select: { slug: true } });
    await ctx(token, other.slug).expect(404);
    const placed = await request(app.getHttpServer())
      .post(`/api/public/menu/${slug}/orders`)
      .set("X-Real-IP", "10.9.0.1")
      .send({
        idempotencyKey: randomUUID(),
        lines: [{ lineId: "l1", itemId: pizza, sizeId: size, quantity: 1 }],
        fulfillment: { mode: "PICKUP" },
        when: { kind: "now" },
        payment: { method: "cash" },
        customer: { name: "Bruna", phone: "+5511977776666" },
        contextToken: token,
      })
      .expect(200);
    expect(await admin.cart.findFirstOrThrow({ where: { conversationId } })).toMatchObject({ status: "CHECKED_OUT", orderId: placed.body.id });
    await ctx(token).expect(404);
  });

  it("na simulação do painel nada é criado", async () => {
    await newConversation();
    await fillCart();
    await call("resumir_pedido");
    expect(await call("confirmar_pedido", { formaDePagamento: "cash" }, false)).toMatchObject({ ok: false, codigo: "SIMULACAO" });
    expect((await admin.cart.findFirstOrThrow({ where: { conversationId } })).status).toBe("AWAITING_CONFIRMATION");
  });

  it("regras: o resumo confirmado vira pedido pelas ferramentas; comprovante não vale", () => {
    const rules = orderAgentRules("Pizzaria", {});
    expect(rules).toContain("confirmar_pedido");
    expect(rules).toContain("gerar_pix");
    expect(rules).toContain("consultar_pagamento");
    expect(rules).not.toContain("Confirmar o pedido e o pagamento");
  });

  it("só baixa a imagem do QR Code da Pagar.me", () => {
    expect(isPixImageUrl("https://api.pagar.me/core/v5/qr.png")).toBe(true);
    expect(isPixImageUrl("http://api.pagar.me/qr.png")).toBe(false);
    expect(isPixImageUrl("https://pagar.me.evil.com/qr.png")).toBe(false);
    expect(isPixImageUrl("https://169.254.169.254/latest")).toBe(false);
  });
});
