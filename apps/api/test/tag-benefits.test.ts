import { randomUUID } from "node:crypto";
import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConnectorsService } from "../src/connectors/connectors.service.js";
import { SESSION_COOKIE } from "../src/public/customer-auth.service.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const STORE = {
  address: { street: "Rua da Loja", number: "1", district: "Centro", city: "São Paulo", state: "SP", zip: "" },
  pickupEnabled: true,
  prepMinutes: 20,
  delivery: { mode: "BY_DISTRICT", districts: [{ district: "Centro", feeCents: 700 }] },
  minOrderCents: 0,
  deliveryMinMinutes: 30,
  deliveryMaxMinutes: 50,
  paymentMethods: ["cash"],
  scheduling: { enabled: false, minLeadMinutes: 30, slotMinutes: 30 },
  promoShowcase: { itemIds: [], frequencyHours: 24 },
};
const BENEFITS = {
  tags: {
    VIP: { enabled: true, freeDelivery: true, discountCents: 1000, minOrderCents: 3000, frequency: "MONTHLY" },
    Recorrente: { enabled: true, freeDelivery: false, discountCents: 500, minOrderCents: 0, frequency: "EVERY_ORDER" },
    Novo: { enabled: false, freeDelivery: false, discountCents: 0, minOrderCents: 0, frequency: "ONCE" },
    Sumido: { enabled: false, freeDelivery: false, discountCents: 0, minOrderCents: 0, frequency: "ONCE" },
  },
  recovery: { enabled: true, discountCents: 1500, freeDelivery: false, minOrderCents: 0, sendMessage: true },
};

describe("Vantagens por tag no cardápio", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let send: ReturnType<typeof vi.spyOn>;
  let adminToken: string;
  let pizza = "";
  let size = "";
  let ip = 0;
  const url = (path: string) => `/api/public/menu/${fx.b.slug}${path}`;
  const post = (path: string, body: object, cookie?: string) => {
    const req = request(app.getHttpServer()).post(url(path)).set("X-Real-IP", `10.9.0.${++ip}`);
    return (cookie ? req.set("Cookie", cookie) : req).send(body);
  };
  const lastCode = () => /\b(\d{6})\b/.exec(String(send.mock.lastCall?.[1]?.text))?.[1] ?? "";
  const phone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const order = (extra: object = {}) => ({
    idempotencyKey: randomUUID(),
    lines: [{ lineId: "l1", itemId: pizza, sizeId: size, quantity: 1 }],
    fulfillment: { mode: "DELIVERY", address: { street: "Rua A", number: "1", district: "Centro", city: "São Paulo", state: "SP" } },
    when: { kind: "now" },
    payment: { method: "cash" },
    ...extra,
  });
  /** Cliente que entrou com o código, com as tags dadas. */
  async function customer(tags: string[]) {
    const tel = phone();
    await post("/otp/request", { phone: tel }).expect(200);
    const res = await post("/otp/verify", { phone: tel, code: lastCode(), name: "Ana Cliente" }).expect(200);
    const cookie = [res.headers["set-cookie"]].flat().find((c) => c?.startsWith(SESSION_COOKIE))!.split(";")[0]!;
    await admin.contact.updateMany({ where: { tenantId: fx.b.id, phone: tel }, data: { tags } });
    return { cookie, tel };
  }

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
    await admin.tenantModule.create({ data: { tenantId: fx.b.id, module: "MENU" } });
    await admin.tenant.update({ where: { id: fx.b.id }, data: { settings: { menuStore: STORE } } });
    const menu = await admin.menu.create({ data: { tenantId: fx.b.id, name: "Cardápio" } });
    const category = await admin.menuCategory.create({ data: { tenantId: fx.b.id, menuId: menu.id, name: "Pizzas" } });
    const item = await admin.menuItem.create({
      data: { tenantId: fx.b.id, categoryId: category.id, name: "Calabresa", sizes: { create: [{ tenantId: fx.b.id, name: "G", priceCents: 5000 }] } },
      include: { sizes: true },
    });
    pizza = item.id;
    size = item.sizes[0]!.id;
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
    await admin.channel.create({
      data: { tenantId: fx.b.id, type: "WHATSAPP", name: "WhatsApp", externalId: `wa-${randomUUID()}`, credentials: encrypt(JSON.stringify({ accessToken: "t", instance: `i-${randomUUID()}` }), key), status: "CONNECTED" },
    });
    send = vi.spyOn(app.get(ConnectorsService).evolution, "send");
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("configuração: o administrador salva e lê; valor inválido é recusado", async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    await request(app.getHttpServer()).put(`/api/menu/${fx.b.id}/tag-benefits`).set(auth).send({ ...BENEFITS, recovery: { ...BENEFITS.recovery, discountCents: -1 } }).expect(400);
    await request(app.getHttpServer()).put(`/api/menu/${fx.b.id}/tag-benefits`).set(auth).send(BENEFITS).expect(200);
    const saved = await request(app.getHttpServer()).get(`/api/menu/${fx.b.id}/tag-benefits`).set(auth).expect(200);
    expect(saved.body.tags.VIP).toMatchObject({ freeDelivery: true, discountCents: 1000 });
  });

  it("cupons: só com o código e só das tags positivas ligadas (a negativa nunca aparece)", async () => {
    await request(app.getHttpServer()).get(url("/me/coupons")).expect(401);
    const { cookie } = await customer(["VIP", "Insatisfeito", "Novo"]);
    const res = await request(app.getHttpServer()).get(url("/me/coupons?subtotal=2000")).set("Cookie", cookie).expect(200);
    expect(res.body.coupons.map((c: { id: string }) => c.id)).toEqual(["VIP"]);
    expect(res.body.coupons[0]).toMatchObject({ title: "Cliente VIP", available: false, reason: "Vale a partir de R$ 30,00." });
    expect(JSON.stringify(res.body)).not.toContain("Insatisfeito");
  });

  it("cupom VIP: frete grátis e R$ 10 no pedido; uma vez por mês; vale o melhor (não soma com a recuperação)", async () => {
    const { cookie } = await customer(["VIP", "Insatisfeito"]);
    const res = await post("/orders", order({ couponId: "VIP" }), cookie).expect(200);
    const saved = await admin.order.findUniqueOrThrow({ where: { id: res.body.id } });
    // Recuperação dá R$ 15; o VIP dá R$ 10 + R$ 7 de taxa = R$ 17: vale o VIP, sozinho.
    expect([Number(saved.subtotal), Number(saved.deliveryFee), Number(saved.total)]).toEqual([50, 0, 40]);
    expect((saved.raw as { benefit: object }).benefit).toMatchObject({ kind: "coupon", tag: "VIP", discountCents: 1000, freeDelivery: true });
    const again = await post("/orders", order({ couponId: "VIP" }), cookie).expect(422);
    expect(again.body).toMatchObject({ code: "COUPON_INVALID", message: "Já usado este mês. Volta no mês que vem." });
  });

  it("recuperação silenciosa: sem cupom, a tag negativa ganha o presente da casa; a cada 30 dias", async () => {
    const { cookie } = await customer(["Em recuperação"]);
    const res = await post("/orders", order(), cookie).expect(200);
    const saved = await admin.order.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(Number(saved.total)).toBe(50 - 15 + 7);
    expect((saved.raw as { benefit: object }).benefit).toMatchObject({ kind: "recovery", label: "Presente da casa" });
    const second = await post("/orders", order(), cookie).expect(200);
    expect((await admin.order.findUniqueOrThrow({ where: { id: second.body.id } })).raw).not.toHaveProperty("benefit");
  });

  it("brinde do VIP: entra a R$ 0 com o pedido mínimo, soma com o cupom e respeita o limite do mês", async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    const vipGift = { enabled: true, itemId: pizza, minOrderCents: 4000, perMonth: 2 };
    await request(app.getHttpServer()).put(`/api/menu/${fx.b.id}/tag-benefits`).set(auth).send({ ...BENEFITS, vipGift }).expect(200);
    const { cookie } = await customer(["VIP"]);
    const coupons = await request(app.getHttpServer()).get(url("/me/coupons")).set("Cookie", cookie).expect(200);
    expect(coupons.body).toMatchObject({ vip: true, vipGift: { name: "Calabresa", minOrderCents: 4000, perMonth: 2, usedThisMonth: 0, available: true, reason: null } });

    const first = await post("/orders", order({ couponId: "VIP" }), cookie).expect(200);
    const saved = await admin.order.findUniqueOrThrow({ where: { id: first.body.id }, include: { items: true } });
    expect(Number(saved.total)).toBe(40); // o cupom VIP continua valendo junto
    expect(saved.items.find((i) => i.notes === "Brinde VIP")).toMatchObject({ name: "Calabresa", menuItemId: pizza });
    expect(Number(saved.items.find((i) => i.notes === "Brinde VIP")!.unitPrice)).toBe(0);

    await post("/orders", order(), cookie).expect(200);
    const third = await post("/orders", order(), cookie).expect(200);
    expect((await admin.order.findUniqueOrThrow({ where: { id: third.body.id }, include: { items: true } })).items).toHaveLength(1);
    const after = await request(app.getHttpServer()).get(url("/me/coupons")).set("Cookie", cookie).expect(200);
    expect(after.body.vipGift).toMatchObject({ usedThisMonth: 2, available: false, reason: "Você já ganhou o brinde 2 vezes este mês." });
    await request(app.getHttpServer()).put(`/api/menu/${fx.b.id}/tag-benefits`).set(auth).send(BENEFITS).expect(200);
  });

  it("visitante sem código não usa cupom", async () => {
    const res = await post("/orders", order({ couponId: "VIP", customer: { name: "Visitante", phone: phone() } })).expect(422);
    expect(res.body.code).toBe("COUPON_INVALID");
  });
});
