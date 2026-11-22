import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CreatePixInput, type PixCharge, type PixProvider, type PixStatus, pagarmeStatus } from "../src/payments/pix.js";
import { PublicOrderService } from "../src/public/public-order.service.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp, PASSWORD } from "./helpers.js";

/** Pagar.me falsa: cobra, e o teste decide a situação de cada cobrança. */
class FakePix implements PixProvider {
  readonly name = "pagarme";
  configured = true;
  charges: CreatePixInput[] = [];
  statusOf = new Map<string, PixStatus>();
  async createCharge(input: CreatePixInput): Promise<PixCharge> {
    this.charges.push(input);
    const id = `or_${input.reference.slice(0, 8)}`;
    this.statusOf.set(id, "PENDING");
    return { providerOrderId: id, chargeId: "ch_1", qrCode: "00020126PIXCOPIAECOLA", qrCodeUrl: "https://pix/qr.png", expiresAt: new Date(Date.now() + 15 * 60_000), status: "PENDING" };
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
  scheduling: { enabled: false, minLeadMinutes: 30, slotMinutes: 30 },
  promoShowcase: { itemIds: [], frequencyHours: 24 },
};

describe("Pix do cardápio (F6): o pedido só nasce pago", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let pix: FakePix;
  let pizza = "";
  let size = "";
  let superToken = "";
  let superId = "";
  let ip = 0;
  const url = (path: string) => `/api/public/menu/${fx.b.slug}${path}`;
  const order = (extra: object = {}) => ({
    idempotencyKey: randomUUID(),
    lines: [{ lineId: "l1", itemId: pizza, sizeId: size, quantity: 1 }],
    fulfillment: { mode: "PICKUP" },
    when: { kind: "now" },
    payment: { method: "pix", cpf: "529.982.247-25" },
    customer: { name: "Bia Pix", phone: "+5511988887777" },
    ...extra,
  });
  const post = (body: object) => request(app.getHttpServer()).post(url("/orders")).set("X-Real-IP", `10.7.0.${++ip}`).send(body);

  beforeAll(async () => {
    app = await createTestApp({ PAGARME_WEBHOOK_USER: "pagarme", PAGARME_WEBHOOK_PASSWORD: "segredo" });
    pix = new FakePix();
    // A api e o worker têm cada um o seu PublicOrderService: o falso vale nos dois.
    for (const service of app.get(PublicOrderService, { each: true })) service.pix = pix;
    fx = await createAuthFixture();
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
    const superUser = await admin.user.create({
      data: { name: "Plataforma", email: `pix-${randomUUID()}@teste.local`, passwordHash: await hash(PASSWORD), isSuperAdmin: true, memberships: { create: { tenantId: fx.a.id, role: "ADMIN" } } },
    });
    superId = superUser.id;
    superToken = await accessTokenFor(app, superUser.email, fx.a.id);
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: superId } });
    await fx?.cleanup();
    await app?.close();
  });

  it("sem o recebedor da Pagar.me o Pix não aparece nem é aceito", async () => {
    const menu = await request(app.getHttpServer()).get(url("")).expect(200);
    expect(menu.body.store.paymentMethods).not.toContain("pix");
    expect((await post(order()).expect(422)).body.code).toBe("PIX_UNAVAILABLE");
  });

  it("só a plataforma liga o recebedor; o PUT da loja não o apaga", async () => {
    const ownerToken = await accessTokenFor(app, fx.user.email, fx.b.id);
    await request(app.getHttpServer()).put(`/api/platform/menu-pix/${fx.b.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ recipientId: "re_abc123456" }).expect(403);
    await request(app.getHttpServer()).put(`/api/platform/menu-pix/${fx.b.id}`).set("Authorization", `Bearer ${superToken}`).send({ recipientId: "re_abc123456" }).expect(200);
    const menu = await request(app.getHttpServer()).get(url("")).expect(200);
    expect(menu.body.store.paymentMethods).toContain("pix");
  });

  it("Pix: exige CPF; gera a cobrança com split 100% para o recebedor e não cria pedido ainda", async () => {
    expect((await post(order({ payment: { method: "pix", cpf: "111.111.111-11" } })).expect(422)).body.code).toBe("CPF_REQUIRED");
    const before = await admin.order.count({ where: { tenantId: fx.b.id } });
    const res = await post(order()).expect(200);
    expect(res.body).toMatchObject({ kind: "pix", qrCode: "00020126PIXCOPIAECOLA", amountCents: 5000 });
    expect(pix.charges.at(-1)).toMatchObject({ recipientId: "re_abc123456", amountCents: 5000, customer: { cpf: "52998224725" } });
    expect(await admin.order.count({ where: { tenantId: fx.b.id } })).toBe(before);
    const payment = await admin.payment.findUniqueOrThrow({ where: { id: res.body.paymentId } });
    expect(payment).toMatchObject({ status: "PENDING", amountCents: 5000 });
    expect(JSON.stringify(payment.raw)).not.toContain("52998224725");
  });

  it("pago na fonte: a consulta cria o pedido uma vez, com PIX e o PURCHASE do funil; token errado não vê nada", async () => {
    const res = await post(order()).expect(200);
    const get = (token = res.body.token) => request(app.getHttpServer()).get(url(`/payments/${res.body.paymentId}`)).set("X-Payment-Token", token);
    await get("token-errado").expect(404);
    expect((await get().expect(200)).body).toMatchObject({ status: "PENDING", qrCode: "00020126PIXCOPIAECOLA", orderId: null });
    const payment = await admin.payment.findUniqueOrThrow({ where: { id: res.body.paymentId } });
    pix.statusOf.set(payment.txid!, "PAID");
    const paid = (await get().expect(200)).body;
    expect(paid).toMatchObject({ status: "PAID", qrCode: null, orderId: expect.any(String), orderToken: expect.any(String) });
    await get().expect(200);
    const saved = await admin.order.findUniqueOrThrow({ where: { id: paid.orderId } });
    expect(saved).toMatchObject({ source: "MENU", status: "CONFIRMED", paymentMethod: "PIX" });
    expect(await admin.order.count({ where: { tenantId: fx.b.id, externalOrderId: saved.externalOrderId } })).toBe(1);
    expect(await admin.funnelEvent.findFirst({ where: { orderId: saved.id, stage: "PURCHASE" } })).toMatchObject({ valueCents: 5000 });
    await request(app.getHttpServer()).get(url(`/orders/${paid.orderId}`)).set("X-Order-Token", paid.orderToken).expect(200);
  });

  it("webhook: sem o Basic Auth é recusado; com ele, só a consulta na fonte decide", async () => {
    const res = await post(order()).expect(200);
    const payment = await admin.payment.findUniqueOrThrow({ where: { id: res.body.paymentId } });
    const hook = (auth?: string) => {
      const req = request(app.getHttpServer()).post("/api/webhooks/pagarme");
      return (auth ? req.set("Authorization", auth) : req).send({ type: "order.paid", data: { id: payment.txid, code: payment.id, status: "paid" } });
    };
    await hook().expect(401);
    const basic = `Basic ${Buffer.from("pagarme:segredo").toString("base64")}`;
    await hook(basic).expect(200); // a fonte ainda diz pendente: nada muda
    expect((await admin.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("PENDING");
    pix.statusOf.set(payment.txid!, "PAID");
    await hook(basic).expect(200);
    const after = await admin.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("PAID");
    expect(after.orderId).not.toBeNull();
  });

  it("Pix vencido sem pagamento vira EXPIRED e não cria pedido", async () => {
    const res = await post(order()).expect(200);
    await admin.payment.update({ where: { id: res.body.paymentId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const view = await request(app.getHttpServer()).get(url(`/payments/${res.body.paymentId}`)).set("X-Payment-Token", res.body.token).expect(200);
    expect(view.body).toMatchObject({ status: "EXPIRED", orderId: null, qrCode: null });
  });

  it("varredura do worker: pega o Pix pago sem aviso e fecha o vencido", async () => {
    const paidRes = await post(order()).expect(200);
    const lateRes = await post(order()).expect(200);
    const paid = await admin.payment.findUniqueOrThrow({ where: { id: paidRes.body.paymentId } });
    pix.statusOf.set(paid.txid!, "PAID");
    await admin.payment.update({ where: { id: lateRes.body.paymentId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await app.get(PublicOrderService).sweepPix();
    expect(await admin.payment.findUniqueOrThrow({ where: { id: paid.id } })).toMatchObject({ status: "PAID", orderId: expect.any(String) });
    expect((await admin.payment.findUniqueOrThrow({ where: { id: lateRes.body.paymentId } })).status).toBe("EXPIRED");
  });

  it("X1: a lista da plataforma mostra o uso do Cardápio só de quem tem o módulo", async () => {
    const list = await request(app.getHttpServer()).get("/api/platform/tenants").set("Authorization", `Bearer ${superToken}`).expect(200);
    const b = list.body.find((t: { id: string }) => t.id === fx.b.id);
    const a = list.body.find((t: { id: string }) => t.id === fx.a.id);
    expect(b.menuUsage).toMatchObject({ items: 1, ordersThisMonth: expect.any(Number), aiCostMicroUsd: 0 });
    expect(b.menuUsage.ordersThisMonth).toBeGreaterThanOrEqual(1);
    expect(a.menuUsage).toBeNull();
  });

  it("situação da Pagar.me", () => {
    expect(pagarmeStatus({ status: "paid" })).toBe("PAID");
    expect(pagarmeStatus({ status: "pending", charges: [{ status: "paid" }] })).toBe("PAID");
    expect(pagarmeStatus({ status: "canceled" })).toBe("CANCELED");
    expect(pagarmeStatus({ status: "pending" })).toBe("PENDING");
  });
});
