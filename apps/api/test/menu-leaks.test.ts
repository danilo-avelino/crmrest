import { randomUUID } from "node:crypto";
import { createPrismaClient, encrypt, parseEncryptionKey, withTenants } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsService } from "../src/connectors/connectors.service.js";
import type { CreatePixInput, PixCharge, PixProvider, PixStatus } from "../src/payments/pix.js";
import { type MenuAgentDeps, menuAgentTools } from "../src/menu-agent/tools/index.js";
import { orderTools } from "../src/menu-agent/tools/order-tools.js";
import { SESSION_COOKIE } from "../src/public/customer-auth.service.js";
import { PublicOrderService } from "../src/public/public-order.service.js";
import { admin, createAuthFixture, createTestApp } from "./helpers.js";

class FakePix implements PixProvider {
  readonly name = "pagarme";
  configured = true;
  async createCharge(input: CreatePixInput): Promise<PixCharge> {
    return { providerOrderId: `or_${input.reference}`, chargeId: "ch", qrCode: "000201LEAK", qrCodeUrl: null, expiresAt: new Date(Date.now() + 600_000), status: "PENDING" };
  }
  async status(): Promise<PixStatus> {
    return "PAID";
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
  pixRecipientId: "re_vazamento1",
  scheduling: { enabled: false, minLeadMinutes: 30, slotMinutes: 30 },
};

/**
 * Q-02: nada de um restaurante aparece pelo cardápio, pela sessão, pelos tokens ou pelas ferramentas do agente de outro.
 * Cada caso usa o slug de B com ids, tokens ou cookie de A (e o contrário nas ferramentas).
 */
describe("Vazamento entre restaurantes nas rotas públicas do cardápio e nas ferramentas (Q-02)", () => {
  const db = createPrismaClient(process.env.DATABASE_URL ?? "");
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let send: ReturnType<typeof vi.spyOn>;
  let ip = 0;
  const menus: Record<"a" | "b", { pizza: string; size: string }> = { a: { pizza: "", size: "" }, b: { pizza: "", size: "" } };
  const url = (slug: string, path: string) => `/api/public/menu/${slug}${path}`;
  const post = (slug: string, path: string, body: object, cookie?: string) => {
    const req = request(app.getHttpServer()).post(url(slug, path)).set("X-Real-IP", `10.8.0.${ip}`);
    return (cookie ? req.set("Cookie", cookie) : req).send(body);
  };
  const get = (slug: string, path: string, headers: Record<string, string> = {}) => {
    let req = request(app.getHttpServer()).get(url(slug, path)).set("X-Real-IP", `10.8.0.${ip}`);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req;
  };
  const order = (menu: { pizza: string; size: string }, payment: object = { method: "cash" }) => ({
    idempotencyKey: randomUUID(),
    lines: [{ lineId: "l1", itemId: menu.pizza, sizeId: menu.size, quantity: 1 }],
    fulfillment: { mode: "PICKUP" },
    when: { kind: "now" },
    payment,
    customer: { name: "Cliente A", phone: "+5511966665555" },
  });
  const cookieOf = (res: request.Response) => [res.headers["set-cookie"]].flat().find((c) => c?.startsWith(SESSION_COOKIE))!.split(";")[0]!;
  const lastCode = () => /\b(\d{6})\b/.exec(String(send.mock.lastCall?.[1]?.text))?.[1] ?? "";

  beforeAll(async () => {
    app = await createTestApp();
    for (const service of app.get(PublicOrderService, { each: true })) service.pix = new FakePix();
    fx = await createAuthFixture();
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
    for (const [name, tenant] of [["a", fx.a], ["b", fx.b]] as const) {
      await admin.tenantModule.create({ data: { tenantId: tenant.id, module: "MENU" } });
      await admin.tenant.update({ where: { id: tenant.id }, data: { settings: { menuStore: STORE } } });
      const menu = await admin.menu.create({ data: { tenantId: tenant.id, name: "Cardápio" } });
      const category = await admin.menuCategory.create({ data: { tenantId: tenant.id, menuId: menu.id, name: "Pizzas" } });
      const item = await admin.menuItem.create({
        data: { tenantId: tenant.id, categoryId: category.id, name: `Pizza ${name}`, sizes: { create: [{ tenantId: tenant.id, name: "G", priceCents: 5000 }] } },
        include: { sizes: true },
      });
      menus[name] = { pizza: item.id, size: item.sizes[0]!.id };
      await admin.channel.create({
        data: {
          tenantId: tenant.id,
          type: "WHATSAPP",
          name: "WhatsApp",
          externalId: `wa-${randomUUID()}`,
          credentials: encrypt(JSON.stringify({ accessToken: "token", instance: `inst-${randomUUID()}` }), key),
          status: "CONNECTED",
        },
      });
    }
    send = vi.spyOn(app.get(ConnectorsService).evolution, "send");
  });

  beforeEach(() => {
    ip++;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await db.$disconnect();
    await app?.close();
  });

  it("item, preço e pedido com o item de outra loja não existem", async () => {
    await get(fx.b.slug, `/items/${menus.a.pizza}`).expect(404);
    const price = await post(fx.b.slug, "/price", { itemId: menus.a.pizza, sizeId: menus.a.size, quantity: 1 }).expect(200);
    expect(price.body).toMatchObject({ ok: false, errors: [{ code: "ITEM_NOT_FOUND" }] });
    expect(JSON.stringify(price.body)).not.toContain("Pizza a");
    const placed = await post(fx.b.slug, "/orders", order(menus.a)).expect(422);
    expect(placed.body.code).toBe("ITEM_UNAVAILABLE");
  });

  it("pedido, nota e Pix de A não abrem pelo slug de B, nem com o token certo", async () => {
    const placed = await post(fx.a.slug, "/orders", order(menus.a)).expect(200);
    await get(fx.a.slug, `/orders/${placed.body.id}`, { "X-Order-Token": placed.body.token }).expect(200);
    await get(fx.b.slug, `/orders/${placed.body.id}`, { "X-Order-Token": placed.body.token }).expect(404);
    const rating = await post(fx.b.slug, `/orders/${placed.body.id}/rating`, { score: 5 }).set("X-Order-Token", placed.body.token);
    expect([401, 404]).toContain(rating.status);

    const pix = await post(fx.a.slug, "/orders", order(menus.a, { method: "pix", cpf: "529.982.247-25" })).expect(200);
    await get(fx.b.slug, `/payments/${pix.body.paymentId}`, { "X-Payment-Token": pix.body.token }).expect(404);
    // Webhook com o pagamento de A e a cobrança de outro: a função do banco não acha restaurante e nada muda.
    await app.get(PublicOrderService, { each: true })[0]!.providerNotified(pix.body.paymentId, "or_outra-cobranca");
    expect((await admin.payment.findUniqueOrThrow({ where: { id: pix.body.paymentId } })).status).toBe("PENDING");
  });

  it("a sessão do código de A não vale no cardápio de B", async () => {
    const phone = "+5511955554444";
    await post(fx.a.slug, "/otp/request", { phone }).expect(200);
    const cookie = cookieOf(await post(fx.a.slug, "/otp/verify", { phone, code: lastCode() }).expect(200));
    await get(fx.a.slug, "/me", { Cookie: cookie }).expect(200);
    await get(fx.b.slug, "/me", { Cookie: cookie }).expect(401);
    const orders = await get(fx.b.slug, "/me/orders", { Cookie: cookie });
    expect([200, 401]).toContain(orders.status);
    if (orders.status === 200) expect(orders.body).toEqual([]);
    const coupons = await get(fx.b.slug, "/me/coupons", { Cookie: cookie });
    expect([200, 401]).toContain(coupons.status);
    if (coupons.status === 200) expect(JSON.stringify(coupons.body)).not.toMatch(/"id":/);
  });

  it("ferramentas do agente: a conversa de A com o restaurante B no contexto não lê nem fecha nada", async () => {
    const contact = await admin.contact.create({ data: { tenantId: fx.a.id, name: "Bia", phone: "+5511944443333" } });
    const channel = await admin.channel.findFirstOrThrow({ where: { tenantId: fx.a.id, type: "WHATSAPP" } });
    const conversation = await admin.conversation.create({ data: { tenantId: fx.a.id, contactId: contact.id, channelId: channel.id, status: "OPEN" } });
    const deps: MenuAgentDeps = { db: { withTenants: (scope, fn) => withTenants(db, scope, fn) } };
    const session = { conversationId: conversation.id, contactId: contact.id };
    const services = app.get(PublicOrderService, { each: true });
    const orders = {
      place: (t: string, c: string, i: Parameters<PublicOrderService["placeForAgent"]>[2]) => services[0]!.placeForAgent(t, c, i),
      pixStatus: (t: string, id: string) => services[0]!.pixStatusFor(t, id),
      contextLink: (t: string, c: string) => services[0]!.contextLink(t, c),
    };
    const tools = [...menuAgentTools(deps, session), ...orderTools(deps, session, orders, () => undefined)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (name: string, input: object, tenantId: string): Promise<any> => {
      const tool = tools.find((t) => t.name === name)!;
      return tool.handler(tool.inputSchema.parse(input), { tenantId });
    };
    // Carrinho em A, com o item de A.
    await call("adicionar_ao_carrinho", { itemId: menus.a.pizza, tamanhoId: menus.a.size }, fx.a.id);
    await call("definir_dados_entrega", { modo: "retirada" }, fx.a.id);
    await call("resumir_pedido", {}, fx.a.id);
    // O item de A não existe em B, e o carrinho de A não aparece em B.
    expect(await call("detalhar_item", { itemId: menus.a.pizza }, fx.b.id)).toMatchObject({ ok: false });
    expect(await call("ver_carrinho", {}, fx.b.id)).toMatchObject({ status: "VAZIO" });
    expect(await call("confirmar_pedido", { formaDePagamento: "cash" }, fx.b.id)).toMatchObject({ ok: false, codigo: "CARRINHO_VAZIO" });
    expect(await call("consultar_pagamento", {}, fx.b.id)).toMatchObject({ ok: false, codigo: "SEM_PIX" });
    const link = await call("link_do_cardapio", {}, fx.b.id);
    expect(link.link).not.toContain("?c=");
    expect(await admin.order.count({ where: { tenantId: fx.b.id } })).toBe(0);
    // O link com contexto de A não abre no cardápio de B.
    const { link: linkA } = await call("link_do_cardapio", {}, fx.a.id);
    const token = new URL(linkA as string).searchParams.get("c")!;
    await get(fx.b.slug, `/context?${new URLSearchParams({ c: token })}`).expect(404);
    await get(fx.a.slug, `/context?${new URLSearchParams({ c: token })}`).expect(200);
  });
});
