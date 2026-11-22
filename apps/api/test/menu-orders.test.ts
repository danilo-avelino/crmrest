import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import { fillMessage, PERSONALITY_MESSAGES } from "@dishdesk/shared";
import { menuInfoOf } from "../src/conversations/conversation.mapper.js";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsService } from "../src/connectors/connectors.service.js";
import { FraudService } from "../src/orders/fraud.service.js";
import { SESSION_COOKIE } from "../src/public/customer-auth.service.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

/** "HH:MM" em Brasília de agora + `minutes`, arredondado para a meia hora de baixo. */
function brasiliaClock(minutes: number): string {
  const at = new Date(Date.now() + minutes * 60_000 - 3 * 60 * 60_000);
  const total = Math.floor((at.getUTCHours() * 60 + at.getUTCMinutes()) / 30) * 30;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const STORE = {
  address: { street: "Rua da Loja", number: "1", district: "Centro", city: "São Paulo", state: "SP", zip: "" },
  pickupEnabled: true,
  prepMinutes: 20,
  delivery: { mode: "BY_DISTRICT", districts: [{ district: "Centro", feeCents: 500 }] },
  minOrderCents: 2000,
  deliveryMinMinutes: 30,
  deliveryMaxMinutes: 50,
  paymentMethods: ["pix", "cash", "credit", "debit", "pix_on_delivery"],
  scheduling: { enabled: true, minLeadMinutes: 30, slotMinutes: 30 },
  promoShowcase: { itemIds: [], frequencyHours: 24 },
  phone: "(11) 3333-4444",
};

describe("Pedido do cardápio público com pagamento na entrega (F3-08, F6-07)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let send: ReturnType<typeof vi.spyOn>;
  let arrived: ReturnType<typeof vi.spyOn>;
  let ip = 0;
  const menuA = { pizza: "", size: "", bacon: "", soda: "", water: "" };
  let pizzaB = "";
  const url = (slug: string, path: string) => `/api/public/menu/${slug}${path}`;
  const post = (slug: string, path: string, body: object, cookie?: string) => {
    const req = request(app.getHttpServer()).post(url(slug, path)).set("X-Real-IP", `10.1.0.${ip}`);
    return (cookie ? req.set("Cookie", cookie) : req).send(body);
  };
  const getOrder = (slug: string, id: string, auth: { token?: string; cookie?: string } = {}) => {
    let req = request(app.getHttpServer()).get(url(slug, `/orders/${id}`));
    if (auth.token) req = req.set("X-Order-Token", auth.token);
    if (auth.cookie) req = req.set("Cookie", auth.cookie);
    return req;
  };
  const randomPhone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const cookieOf = (res: request.Response) => [res.headers["set-cookie"]].flat().find((c) => c?.startsWith(SESSION_COOKIE))!.split(";")[0]!;
  const lastCode = () => /\b(\d{6})\b/.exec(String(send.mock.lastCall?.[1]?.text))?.[1] ?? "";

  const pizzaLine = (extra: object = {}) => ({ lineId: "l1", itemId: menuA.pizza, sizeId: menuA.size, optionIds: [menuA.bacon, menuA.bacon], quantity: 1, ...extra });
  const order = (extra: object = {}) => ({
    idempotencyKey: randomUUID(),
    lines: [pizzaLine({ expectedTotalCents: 5600 })],
    fulfillment: {
      mode: "DELIVERY",
      address: { street: "Rua A", number: "10", complement: "ap 2", district: "Centro", city: "São Paulo", state: "SP", zipCode: "01001000", reference: "" },
    },
    when: { kind: "now" },
    payment: { method: "cash", changeForCents: 10_000 },
    customer: { name: "Ana Visitante", phone: randomPhone() },
    notes: "Sem cebola",
    ...extra,
  });

  async function seedMenu(tenantId: string) {
    await admin.tenantModule.create({ data: { tenantId, module: "MENU" } });
    const menu = await admin.menu.create({ data: { tenantId, name: "Cardápio" } });
    const category = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Pizzas" } });
    const group = await admin.menuOptionGroup.create({
      data: { tenantId, menuId: menu.id, name: "Adicionais", minSelect: 0, maxSelect: 3, options: { create: [{ tenantId, name: "Bacon", priceCents: 300 }] } },
      include: { options: true },
    });
    const pizza = await admin.menuItem.create({
      data: { tenantId, categoryId: category.id, name: "Calabresa", sizes: { create: [{ tenantId, name: "Grande", priceCents: 5000 }] } },
      include: { sizes: true },
    });
    await admin.menuItemOptionGroup.create({ data: { tenantId, itemId: pizza.id, groupId: group.id } });
    const soda = await admin.menuItem.create({ data: { tenantId, categoryId: category.id, name: "Refri", priceCents: 800, soldOut: true } });
    const water = await admin.menuItem.create({ data: { tenantId, categoryId: category.id, name: "Água", priceCents: 400 } });
    return { pizza: pizza.id, size: pizza.sizes[0]!.id, bacon: group.options[0]!.id, soda: soda.id, water: water.id };
  }

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    Object.assign(menuA, await seedMenu(fx.a.id));
    pizzaB = (await seedMenu(fx.b.id)).pizza;
    await admin.tenant.update({ where: { id: fx.a.id }, data: { settings: { personality: "direto", menuStore: STORE } } });
    // B fechada agora (abre daqui a 2 h, todos os dias), com agendamento.
    const open = brasiliaClock(120);
    const close = brasiliaClock(360);
    await admin.tenant.update({
      where: { id: fx.b.id },
      data: {
        settings: {
          menuStore: STORE,
          businessHours: { enabled: true, days: Array.from({ length: 7 }, () => [{ open, close }]), closedMessage: "Fechado. Voltamos {retorno}." },
        },
      },
    });
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
    await admin.channel.create({
      data: {
        tenantId: fx.a.id,
        type: "WHATSAPP",
        name: "WhatsApp",
        externalId: `wa-${randomUUID()}`,
        credentials: encrypt(JSON.stringify({ accessToken: "token", instance: `inst-${randomUUID()}` }), key),
        status: "CONNECTED",
      },
    });
    send = vi.spyOn(app.get(ConnectorsService).evolution, "send");
    arrived = vi.spyOn(FraudService.prototype, "orderArrived");
  });

  beforeEach(() => {
    ip++;
    send.mockClear();
    arrived.mockClear();
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("entrega como visitante: pedido CONFIRMED, sem canal, preço do servidor, fraude e funil; confirmação pelo token", async () => {
    const body = order();
    const res = await post(fx.a.slug, "/orders", body).expect(200);
    expect(res.body).toMatchObject({ id: expect.any(String), code: expect.stringMatching(/^\d{4}$/), token: expect.any(String) });

    const saved = await admin.order.findUniqueOrThrow({ where: { id: res.body.id }, include: { items: true, contact: true, events: true } });
    expect(saved).toMatchObject({ source: "MENU", channelId: null, status: "CONFIRMED", paymentMethod: "CASH", externalOrderId: body.idempotencyKey, scheduledFor: null });
    expect([Number(saved.subtotal), Number(saved.deliveryFee), Number(saved.total)]).toEqual([56, 5, 61]);
    expect(saved.items).toEqual([expect.objectContaining({ name: "Calabresa (Grande)", quantity: 1, options: ["2× Bacon"], menuItemId: menuA.pizza })]);
    expect(saved.events.map((e) => e.code).sort()).toEqual(["CONFIRMED", "PLACED"]);
    expect(saved.raw).toMatchObject({ orderType: "DELIVERY", extraInfo: "Sem cebola", payment: { method: "cash", changeForCents: 10_000 } });
    expect(JSON.stringify(saved.raw)).not.toContain(res.body.token);
    // Regra 9: cadastro criado pelo telefone digitado, sem consentimento de marketing (não pedido).
    expect(saved.contact).toMatchObject({ name: "Ana Visitante", phone: body.customer.phone, phoneSource: "informed_by_customer" });
    expect(await admin.consent.count({ where: { contactId: saved.contactId } })).toBe(0);
    expect(arrived).toHaveBeenCalledWith(fx.a.id, saved.id, expect.any(Date));
    expect(await admin.funnelEvent.findFirst({ where: { orderId: saved.id } })).toMatchObject({ stage: "INITIATE_CHECKOUT", channel: "WEB", valueCents: 6100 });
    // Visitante: o telefone não foi provado, então nada vai para o WhatsApp.
    expect(await admin.message.count({ where: { tenantId: fx.a.id, content: { path: ["automation"], equals: "menu_order_confirmed" } } })).toBe(0);

    await getOrder(fx.a.slug, saved.id).expect(401);
    await getOrder(fx.a.slug, saved.id, { token: "token-inventado" }).expect(401);
    const shown = (await getOrder(fx.a.slug, saved.id, { token: res.body.token }).expect(200)).body;
    expect(shown).toMatchObject({
      code: res.body.code,
      mode: "DELIVERY",
      status: "CONFIRMED",
      eta: { minMinutes: 30, maxMinutes: 50 },
      address: "Rua A, 10, ap 2 · Centro · São Paulo",
      totalCents: 6100,
      payment: { method: "cash", changeForCents: 10_000 },
      storePhone: "(11) 3333-4444",
      items: [{ name: "Calabresa (Grande)", quantity: 1, totalCents: 5600, options: ["2× Bacon"] }],
    });
    expect(JSON.stringify(shown)).not.toMatch(/contactId|tenantId|accessTokenHash/);

    // Painel: o pedido aparece na aba Pedidos como "Cardápio Dish Desk", com previsão e histórico sem erro.
    const token = await accessTokenFor(app, fx.user.email, fx.a.id);
    const list = (await request(app.getHttpServer()).get("/api/orders?period=7d").set("Authorization", `Bearer ${token}`).expect(200)).body;
    expect(list.items.find((o: { id: string }) => o.id === saved.id)).toMatchObject({
      channelType: "MENU",
      store: "Cardápio Dish Desk",
      cancelable: false,
      nextAction: null,
      history: { bySource: [{ channelType: "MENU", orders: 1 }] },
    });
  });

  it("idempotência: o mesmo envio repetido devolve o mesmo pedido, sem duplicar", async () => {
    const body = order();
    const first = (await post(fx.a.slug, "/orders", body).expect(200)).body;
    const again = (await post(fx.a.slug, "/orders", body).expect(200)).body;
    expect(again).toEqual(first);
    expect(await admin.order.count({ where: { tenantId: fx.a.id, externalOrderId: body.idempotencyKey } })).toBe(1);
    expect(arrived).toHaveBeenCalledTimes(1);
  });

  it("retirada no débito, com opt-in de marketing: sem taxa e com o consentimento gravado", async () => {
    const res = await post(fx.a.slug, "/orders", order({ fulfillment: { mode: "PICKUP" }, payment: { method: "debit" }, marketingOptIn: true })).expect(200);
    const saved = await admin.order.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(saved).toMatchObject({ paymentMethod: "DEBIT_ON_DELIVERY", deliveryAddress: null });
    expect(Number(saved.total)).toBe(56);
    expect(saved.raw).toMatchObject({ orderType: "TAKEOUT", payment: { method: "debit", changeForCents: null } });
    expect(await admin.consent.findFirst({ where: { contactId: saved.contactId } })).toMatchObject({ purpose: "marketing_whatsapp", granted: true, source: "menu_checkout" });
    expect((await getOrder(fx.a.slug, saved.id, { token: res.body.token }).expect(200)).body).toMatchObject({ mode: "PICKUP", deliveryFeeCents: 0, address: null });
  });

  it("Pix na maquininha: pago na entrega, gravado como PIX_ON_DELIVERY e nunca como Pix online", async () => {
    const res = await post(fx.a.slug, "/orders", order({ payment: { method: "pix_on_delivery" } })).expect(200);
    const saved = await admin.order.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(saved).toMatchObject({ paymentMethod: "PIX_ON_DELIVERY" });
    expect(saved.raw).toMatchObject({ payment: { method: "pix_on_delivery", changeForCents: null } });
    const panel = menuInfoOf(saved);
    expect(panel?.payment).toEqual({ method: "pix_on_delivery", changeForCents: null });
  });

  it("preço mudou: PRICE_CHANGED com o de antes e o de agora de cada linha, sem criar pedido", async () => {
    const body = order({ lines: [pizzaLine({ expectedTotalCents: 4900 })] });
    const res = await post(fx.a.slug, "/orders", body).expect(422);
    expect(res.body).toMatchObject({ code: "PRICE_CHANGED", lines: [{ lineId: "l1", name: "Calabresa (Grande)", fromCents: 4900, toCents: 5600 }] });
    expect(res.body.message).toContain("Calabresa (Grande) mudou de R$");
    expect(await admin.order.count({ where: { externalOrderId: body.idempotencyKey } })).toBe(0);
    // "Aceitar": o mesmo envio com o preço novo passa.
    await post(fx.a.slug, "/orders", { ...body, lines: [pizzaLine({ expectedTotalCents: 5600 })] }).expect(200);
  });

  it("item esgotado, Pix, troco, área e mínimo: cada erro com o código do W13", async () => {
    const soldOut = await post(fx.a.slug, "/orders", order({ lines: [pizzaLine(), { lineId: "l2", itemId: menuA.soda, quantity: 1 }] })).expect(422);
    expect(soldOut.body).toMatchObject({ code: "ITEM_UNAVAILABLE", lines: [{ lineId: "l2" }] });
    expect((await post(fx.a.slug, "/orders", order({ payment: { method: "pix" } })).expect(422)).body.code).toBe("PIX_UNAVAILABLE");
    // A loja guarda o Pix, mas o cardápio público só expõe as formas efetivas (sem Pix até a F6).
    const menu = await request(app.getHttpServer()).get(url(fx.a.slug, "")).expect(200);
    expect(menu.body.store.paymentMethods).toEqual(["cash", "credit", "debit", "pix_on_delivery"]);
    const low = await post(fx.a.slug, "/orders", order({ payment: { method: "cash", changeForCents: 6100 } })).expect(422);
    expect(low.body).toMatchObject({ code: "CHANGE_TOO_LOW", totalCents: 6100 });
    const far = order({ fulfillment: { mode: "DELIVERY", address: { street: "Rua B", number: "1", district: "Longe", city: "SP", state: "SP" } } });
    expect((await post(fx.a.slug, "/orders", far).expect(422)).body.code).toBe("OUT_OF_AREA");
    const small = await post(fx.a.slug, "/orders", order({ lines: [{ lineId: "l1", itemId: menuA.water, quantity: 1 }] })).expect(422);
    expect(small.body).toMatchObject({ code: "MIN_ORDER", missingCents: 1600 });
    // Sem nome e telefone e sem sessão: 400.
    await post(fx.a.slug, "/orders", order({ customer: null })).expect(400);
    expect(arrived).not.toHaveBeenCalled();
  });

  it("R2 loja fechada: 'agora' volta STORE_CLOSED com a próxima faixa; agendado nela, o pedido entra com o horário", async () => {
    const base = order({ lines: [{ lineId: "l1", itemId: pizzaB, sizeId: (await admin.menuItemSize.findFirstOrThrow({ where: { itemId: pizzaB } })).id, quantity: 1 }] });
    const closed = await post(fx.b.slug, "/orders", base).expect(422);
    expect(closed.body).toMatchObject({ code: "STORE_CLOSED", paused: false, nextSlot: { start: expect.any(String), label: expect.any(String) } });
    const start = closed.body.nextSlot.start as string;
    await post(fx.b.slug, "/orders", { ...base, when: { kind: "scheduled", start: "2020-01-01T10:00:00.000Z" } }).expect(422, /SLOT_UNAVAILABLE/);
    const res = await post(fx.b.slug, "/orders", { ...base, when: { kind: "scheduled", start } }).expect(200);
    const saved = await admin.order.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(saved.scheduledFor?.toISOString()).toBe(start);
    expect(saved.tenantId).toBe(fx.b.id);
  });

  it("com o código: pedido no cadastro da sessão, endereço salvo como Casa, confirmação no WhatsApp no tom da loja", async () => {
    const phone = randomPhone();
    await post(fx.a.slug, "/otp/request", { phone }).expect(200);
    const cookie = cookieOf(await post(fx.a.slug, "/otp/verify", { phone, code: lastCode(), name: "Bia Cliente" }).expect(200));
    const sessionContact = await admin.contact.findFirstOrThrow({ where: { tenantId: fx.a.id, phone } });

    const body = order({ customer: { name: "Bia Cliente", phone }, fulfillment: { ...order().fulfillment, saveAs: "Casa" } });
    const res = await post(fx.a.slug, "/orders", body, cookie).expect(200);
    const saved = await admin.order.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(saved.contactId).toBe(sessionContact.id);
    expect(saved.conversationId).not.toBeNull();
    expect(await admin.contactAddress.findFirst({ where: { contactId: sessionContact.id } })).toMatchObject({ label: "Casa", street: "Rua A", number: "10" });

    const message = await admin.message.findFirstOrThrow({ where: { conversationId: saved.conversationId!, content: { path: ["automation"], equals: "menu_order_confirmed" } } });
    const text = (message.content as { text: string }).text;
    const expected = fillMessage(PERSONALITY_MESSAGES.direto.menuOrderConfirmed, { nome: "Bia", pedido: res.body.code, quando: "QUANDO", pagamento: "na entrega, em dinheiro (troco para R$ 100,00)" });
    const [before, after] = expected.split("QUANDO");
    expect(text.startsWith(before!)).toBe(true);
    expect(text.endsWith(after!)).toBe(true);
    expect(text).toMatch(/Previsão de entrega entre \d\d:\d\d e \d\d:\d\d\./);

    // A sessão do mesmo cliente abre o pedido sem o token; a de outro restaurante, não.
    await getOrder(fx.a.slug, saved.id, { cookie }).expect(200);
    await getOrder(fx.b.slug, saved.id, { cookie }).expect(404);
    await getOrder(fx.b.slug, saved.id, { token: res.body.token }).expect(404);
  });

  it("isolamento: item de outro restaurante pelo slug de A não entra", async () => {
    const res = await post(fx.a.slug, "/orders", order({ lines: [{ lineId: "x", itemId: pizzaB, quantity: 1 }] })).expect(422);
    expect(res.body.code).toBe("ITEM_UNAVAILABLE");
  });

  it("acompanhamento (F3-09): linha do tempo, escolhas para pedir de novo e nota só depois de entregue, uma vez", async () => {
    const res = await post(fx.a.slug, "/orders", order({ notes: null })).expect(200);
    const token = res.body.token as string;
    const shown = (await getOrder(fx.a.slug, res.body.id, { token }).expect(200)).body;
    expect(shown.timeline.map((t: { code: string }) => t.code)).toEqual(["PLACED", "CONFIRMED"]);
    expect(shown.rating).toBeNull();
    expect(shown.reorder).toEqual([{ itemId: menuA.pizza, sizeId: menuA.size, optionIds: [menuA.bacon, menuA.bacon], halves: [], quantity: 1, note: null }]);

    const rate = (score: number, auth = token) => request(app.getHttpServer()).post(url(fx.a.slug, `/orders/${res.body.id}/rating`)).set("X-Order-Token", auth).send({ score });
    expect((await rate(5).expect(409)).body.code).toBe("NOT_DELIVERED");
    await admin.order.update({ where: { id: res.body.id }, data: { status: "DELIVERED" } });
    await rate(6).expect(400);
    await rate(4, "token-inventado").expect(401);
    expect((await rate(4).expect(200)).body).toEqual({ rating: 4 });
    expect((await rate(5).expect(409)).body.code).toBe("ALREADY_RATED");
    expect((await getOrder(fx.a.slug, res.body.id, { token }).expect(200)).body.rating).toBe(4);
  });

  it("origem da visita (F7-02): fica no pedido e no evento do funil, com a sessão do navegador; chave estranha é descartada", async () => {
    const body = { ...order(), sessionId: "sessao-navegador-1", attribution: { utm_source: "instagram", fbc: "fb.1.1.ABC", hack: "x" } };
    const res = await post(fx.a.slug, "/orders", body).expect(200);
    const saved = await admin.order.findUniqueOrThrow({ where: { id: res.body.id } });
    expect((saved.raw as { attribution?: object }).attribution).toEqual({ utm_source: "instagram", fbc: "fb.1.1.ABC" });
    expect(await admin.funnelEvent.findFirst({ where: { orderId: saved.id } })).toMatchObject({
      stage: "INITIATE_CHECKOUT",
      sessionId: "sessao-navegador-1",
      attribution: { utm_source: "instagram", fbc: "fb.1.1.ABC" },
    });
  });

  it("histórico (W16): só com o código, 10 por página, com os pedidos do cadastro da sessão", async () => {
    await request(app.getHttpServer()).get(url(fx.a.slug, "/me/orders")).expect(401);
    const phone = randomPhone();
    await post(fx.a.slug, "/otp/request", { phone }).expect(200);
    const cookie = cookieOf(await post(fx.a.slug, "/otp/verify", { phone, code: lastCode(), name: "Caio" }).expect(200));
    for (let i = 0; i < 11; i++) await post(fx.a.slug, "/orders", order({ customer: { name: "Caio", phone } }), cookie).expect(200);
    const first = (await request(app.getHttpServer()).get(url(fx.a.slug, "/me/orders")).set("Cookie", cookie).expect(200)).body;
    expect(first.orders).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    expect(first.orders[0]).toMatchObject({ status: "CONFIRMED", totalCents: 6100, fromMenu: true, summary: "1× Calabresa (Grande)" });
    const last = first.orders.at(-1).placedAt as string;
    const next = (await request(app.getHttpServer()).get(url(fx.a.slug, `/me/orders?before=${encodeURIComponent(last)}`)).set("Cookie", cookie).expect(200)).body;
    expect(next).toMatchObject({ hasMore: false });
    expect(next.orders).toHaveLength(1);
    await request(app.getHttpServer()).get(url(fx.b.slug, "/me/orders")).set("Cookie", cookie).expect(401);
    await request(app.getHttpServer()).get(url(fx.a.slug, "/me/orders?before=ontem")).set("Cookie", cookie).expect(400);
  });
});
