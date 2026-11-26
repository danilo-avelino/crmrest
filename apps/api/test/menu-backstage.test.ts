import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MENU_STORE, type MenuStoreSettings } from "@dishdesk/shared";
import { quoteDelivery } from "../src/menu/delivery.js";
import { reportWindow } from "../src/menu/menu-report.js";
import { couponDiscount, couponStatus, type CouponRule, inSchedule, scheduleText } from "../src/public/menu-coupons.js";
import { noticeStatus } from "../src/menu/menu-notices.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const STORE = {
  address: { street: "Rua da Loja", number: "1", district: "Centro", city: "São Paulo", state: "SP", zip: "" },
  pickupEnabled: true,
  prepMinutes: 20,
  delivery: { mode: "BY_DISTRICT", districts: [{ district: "Centro", feeCents: 500 }] },
  minOrderCents: 1000,
  deliveryMinMinutes: 30,
  deliveryMaxMinutes: 50,
  paymentMethods: ["pix", "cash", "credit", "debit", "pix_on_delivery"],
  scheduling: { enabled: false, minLeadMinutes: 30, slotMinutes: 30 },
  promoShowcase: { itemIds: [], frequencyHours: 24 },
};

/** 26/11/2026, quinta-feira, 19h40 em Brasília. */
const THURSDAY_1940 = new Date("2026-11-26T22:40:00Z");

const RULE: CouponRule = {
  id: "c1",
  name: "Happy hour",
  code: "PIZZA10",
  kind: "PERCENT",
  valueCents: 0,
  percent: 10,
  maxDiscountCents: 2000,
  startsOn: "2026-11-01",
  endsOn: "2026-12-31",
  weekdays: [1, 2, 3, 4],
  startMinute: 18 * 60,
  endMinute: 20 * 60,
  delivery: true,
  pickup: true,
  usageLimit: 300,
  minOrderCents: 5000,
  newCustomersOnly: false,
  oncePerCustomer: false,
  paymentMethods: [],
  categoryIds: ["pizzas"],
  itemIds: [],
  active: true,
};

describe("Cupons e avisos: regras puras", () => {
  it("cupom: disponível na faixa, fora do horário depois, expirado pela data ou pelo limite, inativo", () => {
    expect(couponStatus(RULE, 86, THURSDAY_1940)).toEqual({ kind: "AVAILABLE", until: "2026-11-26T23:00:00.000Z" });
    const friday = new Date("2026-11-27T22:40:00Z");
    expect(couponStatus(RULE, 86, friday)).toMatchObject({ kind: "OUT_OF_HOURS", nextAt: "2026-11-30T21:00:00.000Z" });
    expect(couponStatus(RULE, 300, THURSDAY_1940)).toMatchObject({ kind: "EXPIRED", reason: "LIMIT" });
    expect(couponStatus({ ...RULE, endsOn: "2026-11-25" }, 0, THURSDAY_1940)).toMatchObject({ kind: "EXPIRED", reason: "DATE" });
    expect(couponStatus({ ...RULE, active: false }, 0, THURSDAY_1940)).toEqual({ kind: "INACTIVE" });
    expect(scheduleText(RULE)).toBe("de seg a qui, das 18h às 20h");
  });

  it("faixa que passa da meia-noite vale no começo do dia seguinte", () => {
    const late = { startsOn: null, endsOn: null, weekdays: [4], startMinute: 22 * 60, endMinute: 2 * 60 };
    expect(inSchedule(late, new Date("2026-11-27T04:30:00Z"))).toBe(true); // sexta 1h30, faixa de quinta
    expect(inSchedule(late, new Date("2026-11-28T04:30:00Z"))).toBe(false); // sábado 1h30
  });

  it("desconto: só nas categorias escolhidas, com teto; R$ até a parte elegível; entrega grátis zera a taxa", () => {
    const lines = [
      { itemId: "calabresa", categoryId: "pizzas", totalCents: 5690 },
      { itemId: "coca", categoryId: "bebidas", totalCents: 650 },
    ];
    expect(couponDiscount(RULE, lines)).toEqual({ discountCents: 569, freeDelivery: false });
    expect(couponDiscount({ ...RULE, percent: 50 }, lines).discountCents).toBe(2000);
    expect(couponDiscount({ ...RULE, kind: "FIXED", valueCents: 10_000 }, lines).discountCents).toBe(5690);
    expect(couponDiscount({ ...RULE, kind: "FREE_DELIVERY" }, lines)).toEqual({ discountCents: 0, freeDelivery: true });
  });

  it("aviso: no ar, fora do horário com a volta, encerrado e pausado", () => {
    const notice = { weekdays: [], startMinute: 18 * 60, endMinute: 20 * 60, endsOn: null, active: true };
    expect(noticeStatus(notice, THURSDAY_1940)).toMatchObject({ kind: "LIVE" });
    expect(noticeStatus({ ...notice, startMinute: 11 * 60, endMinute: 14 * 60 }, THURSDAY_1940)).toMatchObject({ kind: "OUT_OF_HOURS", nextAt: "2026-11-27T14:00:00.000Z" });
    expect(noticeStatus({ ...notice, endsOn: "2026-11-20" }, THURSDAY_1940)).toEqual({ kind: "ENDED", since: "2026-11-20" });
    expect(noticeStatus({ ...notice, active: false }, THURSDAY_1940)).toEqual({ kind: "PAUSED" });
  });

  it("relatório: hoje até agora contra ontem até a mesma hora; período máximo", () => {
    const w = reportWindow("2026-11-26", "2026-11-26", THURSDAY_1940);
    expect(w).toMatchObject({ days: 1, start: new Date("2026-11-26T03:00:00Z"), end: THURSDAY_1940 });
    expect(w.previous).toEqual({ start: new Date("2026-11-25T03:00:00Z"), end: new Date("2026-11-25T22:40:00Z") });
    expect(() => reportWindow("2026-01-01", "2026-11-26", THURSDAY_1940)).toThrow(/92 dias/);
  });

  it("áreas desenhadas: vale a de menor taxa onde se cruzam; prazo da área; fora de todas não entrega", () => {
    const store: MenuStoreSettings = {
      ...DEFAULT_MENU_STORE,
      address: { ...DEFAULT_MENU_STORE.address, lat: -23.56, lng: -46.69 },
      minOrderCents: 0,
      delivery: {
        mode: "BY_AREA",
        areas: [
          { id: "ate2", name: "Até 2 km", shape: { type: "circle", minKm: 0, maxKm: 2 }, feeCents: 500, etaMinMinutes: 30, etaMaxMinutes: 40 },
          { id: "2a4", name: "2 a 4 km", shape: { type: "circle", minKm: 2, maxKm: 4 }, feeCents: 800 },
          {
            id: "pinheiros",
            name: "Alto de Pinheiros",
            shape: { type: "polygon", points: [{ lat: -23.55, lng: -46.71 }, { lat: -23.55, lng: -46.69 }, { lat: -23.565, lng: -46.69 }, { lat: -23.565, lng: -46.71 }] },
            feeCents: 700,
          },
        ],
      },
    };
    const near = quoteDelivery(store, { mode: "DELIVERY", subtotalCents: 5000, address: { lat: -23.561, lng: -46.695 } });
    expect(near).toMatchObject({ ok: true, feeCents: 500, areaId: "ate2", eta: { minMinutes: 30, maxMinutes: 40 } });
    const polygonOnly = quoteDelivery(store, { mode: "DELIVERY", subtotalCents: 5000, address: { lat: -23.551, lng: -46.709 } });
    expect(polygonOnly).toMatchObject({ ok: true, feeCents: 700, areaId: "pinheiros", eta: { minMinutes: store.deliveryMinMinutes } });
    expect(quoteDelivery(store, { mode: "DELIVERY", subtotalCents: 5000, address: { lat: -23.7, lng: -46.9 } })).toMatchObject({ ok: false, code: "OUT_OF_AREA" });
  });
});

describe("Abas novas do Cardápio: planilha, opções, cupons, avisos e relatório", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let token: string;
  let ip = 0;
  const ids = { menu: "", pizzas: "", bebidas: "", calabresa: "", grande: "", coca: "", bordaG: "", bordaM: "" };
  const call = (method: "get" | "post" | "put" | "patch" | "delete", path: string) =>
    request(app.getHttpServer())[method](`/api/menu/${fx.b.id}${path}`).set("Authorization", `Bearer ${token}`);
  const placeOrder = (extra: object = {}) => {
    ip++;
    return request(app.getHttpServer())
      .post(`/api/public/menu/${fx.b.slug}/orders`)
      .set("X-Real-IP", `10.9.0.${ip}`)
      .send({
        idempotencyKey: randomUUID(),
        lines: [
          { lineId: "l1", itemId: ids.calabresa, sizeId: ids.grande, quantity: 1 },
          { lineId: "l2", itemId: ids.coca, quantity: 1 },
        ],
        fulfillment: {
          mode: "DELIVERY",
          address: { street: "Rua A", number: "10", complement: "", district: "Centro", city: "São Paulo", state: "SP", zipCode: "01001000", reference: "" },
        },
        when: { kind: "now" },
        payment: { method: "cash", changeForCents: 20_000 },
        customer: { name: "Bia", phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}` },
        ...extra,
      });
  };

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    token = await accessTokenFor(app, fx.user.email, fx.b.id);
    await admin.tenantModule.create({ data: { tenantId: fx.b.id, module: "MENU" } });
    await admin.tenant.update({ where: { id: fx.b.id }, data: { settings: { menuStore: STORE } } });
    const menu = await admin.menu.create({ data: { tenantId: fx.b.id, name: "Cardápio" } });
    const pizzas = await admin.menuCategory.create({ data: { tenantId: fx.b.id, menuId: menu.id, name: "Pizzas" } });
    const bebidas = await admin.menuCategory.create({ data: { tenantId: fx.b.id, menuId: menu.id, name: "Bebidas", sortOrder: 1 } });
    const calabresa = await admin.menuItem.create({
      data: { tenantId: fx.b.id, categoryId: pizzas.id, name: "Calabresa", costCents: 1420, sizes: { create: [{ tenantId: fx.b.id, name: "Grande", priceCents: 5690 }] } },
      include: { sizes: true },
    });
    const coca = await admin.menuItem.create({ data: { tenantId: fx.b.id, categoryId: bebidas.id, name: "Coca-Cola lata", priceCents: 650 } });
    const bordaG = await admin.menuOptionGroup.create({ data: { tenantId: fx.b.id, menuId: menu.id, name: "Borda da pizza G" } });
    const bordaM = await admin.menuOptionGroup.create({ data: { tenantId: fx.b.id, menuId: menu.id, name: "Borda da pizza M", sortOrder: 1 } });
    Object.assign(ids, { menu: menu.id, pizzas: pizzas.id, bebidas: bebidas.id, calabresa: calabresa.id, grande: calabresa.sizes[0]!.id, coca: coca.id, bordaG: bordaG.id, bordaM: bordaM.id });
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("planilha: status, promocional, custo, destaque e categoria em uma chamada; regras do preço", async () => {
    await call("patch", "/items")
      .send({ items: [{ id: ids.coca, promoPriceCents: 590, costCents: 310, featured: true, status: "AVAILABLE" }, { id: ids.calabresa, status: "SOLD_OUT" }] })
      .expect(200);
    const coca = await admin.menuItem.findUniqueOrThrow({ where: { id: ids.coca } });
    expect(coca).toMatchObject({ promoPriceCents: 590, costCents: 310, tags: ["destaque"], soldOut: false, active: true });
    expect((await admin.menuItem.findUniqueOrThrow({ where: { id: ids.calabresa } })).soldOut).toBe(true);

    // Nada muda quando uma linha é inválida (tudo ou nada).
    const bad = await call("patch", "/items").send({ items: [{ id: ids.coca, costCents: 999 }, { id: ids.calabresa, priceCents: 100 }] }).expect(400);
    expect(bad.body.message).toMatch(/tem tamanhos/);
    expect((await admin.menuItem.findUniqueOrThrow({ where: { id: ids.coca } })).costCents).toBe(310);
    await call("patch", "/items").send({ items: [{ id: ids.coca, promoPriceCents: 650 }] }).expect(400);

    // O cardápio público mostra o promocional e o preço cheio riscado.
    const publicMenu = (await request(app.getHttpServer()).get(`/api/public/menu/${fx.b.slug}`).set("X-Real-IP", "10.9.1.1").expect(200)).body;
    const shown = publicMenu.categories.flatMap((c: { items: object[] }) => c.items).find((i: { id: string }) => i.id === ids.coca);
    expect(shown).toMatchObject({ priceCents: 590, regularPriceCents: 650 });

    await call("patch", "/items").send({ items: [{ id: ids.calabresa, status: "AVAILABLE" }, { id: ids.coca, featured: false }] }).expect(200);
    expect((await admin.menuItem.findUniqueOrThrow({ where: { id: ids.coca } })).tags).toEqual([]);
  });

  it("opções: o nome cria na biblioteca; pausar e tirar do estoque valem em todos os grupos; cada grupo com o seu preço", async () => {
    const created = (await call("post", `/option-groups/${ids.bordaG}/options`).send({ name: "Borda de catupiry", priceCents: 800 }).expect(201)).body;
    expect(created.choiceId).toEqual(expect.any(String));
    const choice = (await call("post", `/choices/${created.choiceId}/groups`).send({ groupId: ids.bordaM, priceCents: 600 }).expect(201)).body;
    expect(choice.options.map((o: { priceCents: number; group: { name: string } }) => [o.group.name, o.priceCents])).toEqual([
      ["Borda da pizza G", 800],
      ["Borda da pizza M", 600],
    ]);
    await call("post", `/choices/${created.choiceId}/groups`).send({ groupId: ids.bordaM }).expect(400);

    await call("patch", `/choices/${created.choiceId}`).send({ inStock: false, costCents: 320, code: "BRD-CAT", name: "Borda catupiry" }).expect(200);
    const options = await admin.menuOption.findMany({ where: { choiceId: created.choiceId } });
    expect(options.map((o) => [o.name, o.soldOut])).toEqual([
      ["Borda catupiry", true],
      ["Borda catupiry", true],
    ]);

    // Mudar pelo grupo (tela de complementos) também muda a biblioteca.
    await call("patch", `/options/${created.id}`).send({ soldOut: false, priceCents: 900 }).expect(200);
    expect((await admin.menuChoice.findUniqueOrThrow({ where: { id: created.choiceId } })).inStock).toBe(true);
    expect((await admin.menuOption.findUniqueOrThrow({ where: { id: created.id } })).priceCents).toBe(900);

    const list = (await call("get", "/choices").expect(200)).body;
    expect(list.find((c: { id: string }) => c.id === created.choiceId)).toMatchObject({ kind: "EXTRA", code: "BRD-CAT", costCents: 320 });

    await call("delete", `/choices/${created.choiceId}`).expect(204);
    expect(await admin.menuOption.count({ where: { choiceId: created.choiceId } })).toBe(0);
  });

  it("cupons: código no checkout (só nas pizzas), usos e valor na lista; código errado recusa; automático de entrega grátis", async () => {
    const coupon = (
      await call("post", "/coupons")
        .send({ name: "Happy hour das pizzas", code: " pizza10 ", kind: "PERCENT", percent: 10, maxDiscountCents: 2000, categoryIds: [ids.pizzas], minOrderCents: 1000 })
        .expect(201)
    ).body;
    expect(coupon).toMatchObject({ code: "PIZZA10", uses: 0, status: { kind: "AVAILABLE" } });
    await call("post", "/coupons").send({ name: "Outro", code: "PIZZA10", kind: "FIXED", valueCents: 500 }).expect(400);

    const placed = await placeOrder({ couponCode: "pizza10" }).expect(200);
    const order = await admin.order.findUniqueOrThrow({ where: { id: placed.body.id } });
    // Pizza 56,90 + Coca em promoção 5,90 = 62,80; 10% só da pizza = 5,69; entrega 5,00.
    expect(Number(order.total)).toBeCloseTo(62.8 - 5.69 + 5, 2);
    expect((order.raw as { benefit: object }).benefit).toMatchObject({ kind: "menu_coupon", code: "PIZZA10", discountCents: 569 });

    const listed = (await call("get", "/coupons").expect(200)).body.find((c: { id: string }) => c.id === coupon.id);
    expect(listed).toMatchObject({ uses: 1, discountedCents: 569 });

    const wrong = await placeOrder({ couponCode: "NAOEXISTE" }).expect(422);
    expect(wrong.body).toMatchObject({ code: "COUPON_INVALID", message: "Cupom não encontrado. Confira o código." });

    // Um uso por cliente pede o código do WhatsApp (o telefone digitado não prova quem é).
    await call("patch", `/coupons/${coupon.id}`).send({ name: coupon.name, code: "PIZZA10", kind: "PERCENT", percent: 10, oncePerCustomer: true }).expect(200);
    expect((await placeOrder({ couponCode: "PIZZA10" }).expect(422)).body.message).toMatch(/código do WhatsApp/);
    await call("patch", `/coupons/${coupon.id}/active`).send({ active: false }).expect(200);

    // Automático (sem código): entrega grátis entra sozinha no pedido de entrega.
    await call("post", "/coupons").send({ name: "Entrega grátis", kind: "FREE_DELIVERY" }).expect(201);
    const free = await placeOrder().expect(200);
    const freeOrder = await admin.order.findUniqueOrThrow({ where: { id: free.body.id }, include: { couponUse: true } });
    expect(Number(freeOrder.deliveryFee)).toBe(0);
    expect(freeOrder.couponUse).toMatchObject({ discountCents: 500 });
  });

  it("avisos: no ar entram no cardápio público; desligado sai e guarda quem desligou", async () => {
    const notice = (await call("post", "/notices").send({ title: "Chegou a Diavola", body: "Calabresa picante e mel." }).expect(201)).body;
    expect(notice.status).toMatchObject({ kind: "LIVE" });
    const menu = () => request(app.getHttpServer()).get(`/api/public/menu/${fx.b.slug}`).set("X-Real-IP", "10.9.1.2").expect(200);
    expect((await menu()).body.notices).toEqual([{ id: notice.id, title: "Chegou a Diavola", body: "Calabresa picante e mel.", photoUrl: null }]);

    const paused = (await call("patch", `/notices/${notice.id}/active`).send({ active: false }).expect(200)).body;
    expect(paused).toMatchObject({ active: false, status: { kind: "PAUSED" }, pausedBy: expect.any(String) });
    expect((await menu()).body.notices).toEqual([]);
  });

  it("relatório: produtos + taxas − descontos = faturamento; itens com custo e margem", async () => {
    const report = (await call("get", "/report").expect(200)).body;
    const { totals } = report;
    expect(totals.orders).toBeGreaterThanOrEqual(2);
    expect(totals.productsCents + totals.feesCents - totals.discountsCents).toBe(totals.revenueCents);
    expect(report.grouping).toBe("hour");
    expect(report.series.current).toHaveLength(24);
    const pizza = report.items.find((i: { id: string }) => i.id === ids.calabresa);
    expect(pizza).toMatchObject({ name: "Calabresa", averageCents: 5690, costCents: 1420 * pizza.quantity });
    expect(pizza.marginPct).toBe(Math.round(((5690 - 1420) / 5690) * 100));
    expect(report.categories.map((c: { name: string }) => c.name)).toEqual(["Pizzas", "Bebidas"]);
  });
});
