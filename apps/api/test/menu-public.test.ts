import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_RATE_LIMIT } from "../src/public/public-menu.controller.js";
import { availableAt } from "../src/public/public-menu.service.js";
import { admin, createAuthFixture, createTestApp } from "./helpers.js";

describe("Cardápio público (F0-04, F3-01)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let pizzaId: string;
  let sodaId: string;
  let itemOfB: string;
  const url = (slug: string, path = "") => `/api/public/menu/${slug}${path}`;
  const get = (slug: string, path = "") => request(app.getHttpServer()).get(url(slug, path));
  const post = (slug: string, path: string, body: object) => request(app.getHttpServer()).post(url(slug, path)).send(body);
  const enable = (tenantId: string) => admin.tenantModule.create({ data: { tenantId, module: "MENU" } });

  /** Cardápio com uma pizza de tamanhos (com nota para a IA) e um refrigerante esgotado. */
  async function seedMenu(tenantId: string) {
    const menu = await admin.menu.create({ data: { tenantId, name: "Cardápio" } });
    const category = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Pizzas" } });
    const pizza = await admin.menuItem.create({
      data: {
        tenantId,
        categoryId: category.id,
        name: "Calabresa",
        aiNotes: "SEGREDO-IA",
        synonyms: ["calabreza"],
        tags: ["mais pedido"],
        sizes: { create: [{ tenantId, name: "Grande", priceCents: 5000 }] },
      },
    });
    const soda = await admin.menuItem.create({ data: { tenantId, categoryId: category.id, name: "Refri", priceCents: 800, soldOut: true } });
    await admin.menuItem.create({ data: { tenantId, categoryId: category.id, name: "Arquivado", priceCents: 100, active: false } });
    return { pizza, soda };
  }

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    await enable(fx.a.id);
    await enable(fx.b.id);
    ({ pizza: { id: pizzaId }, soda: { id: sodaId } } = await seedMenu(fx.a.id));
    itemOfB = (await seedMenu(fx.b.id)).pizza.id;
    await seedMenu(fx.c.id); // C sem o módulo
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("slug desconhecido, módulo desligado e assinatura vencida respondem o mesmo 404", async () => {
    const unknown = await get("nao-existe-xyz").expect(404);
    const off = await get(fx.c.slug).expect(404);
    expect(off.body).toEqual(unknown.body);
    await admin.tenant.update({ where: { id: fx.b.id }, data: { trialEndsAt: new Date(Date.now() - 86_400_000), createdAt: new Date(Date.now() - 30 * 86_400_000) } });
    expect((await get(fx.b.slug).expect(404)).body).toEqual(unknown.body);
    await admin.tenant.update({ where: { id: fx.b.id }, data: { trialEndsAt: null } });
    await get(fx.b.slug).expect(200);
  });

  it("cardápio: loja, itens visíveis, esgotado sinalizado, sem campos internos e com cache curto", async () => {
    const res = await get(fx.a.slug).expect(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=30");
    expect(res.body.store).toMatchObject({ name: fx.a.name, status: "open", paymentMethods: ["cash", "credit", "debit", "pix_on_delivery"], schedulingEnabled: false });
    const items = res.body.categories[0].items;
    expect(items.map((i: { name: string }) => i.name)).toEqual(["Calabresa", "Refri"]);
    expect(items[1]).toMatchObject({ soldOut: true, availableNow: true });
    expect(items[0].sizes).toEqual([{ id: expect.any(String), name: "Grande", priceCents: 5000 }]);
    const text = JSON.stringify(res.body);
    for (const internal of ["SEGREDO-IA", "aiNotes", "synonyms", "tenantId", fx.a.id]) expect(text).not.toContain(internal);

    const item = (await get(fx.a.slug, `/items/${pizzaId}`).expect(200)).body;
    expect(item.name).toBe("Calabresa");
    expect(JSON.stringify(item)).not.toContain("SEGREDO-IA");
  });

  it("item de outro restaurante pelo slug de A é 404", async () => {
    await get(fx.a.slug, `/items/${itemOfB}`).expect(404);
    const price = await post(fx.a.slug, "/price", { itemId: itemOfB, quantity: 1 }).expect(200);
    expect(price.body.errors[0].code).toBe("ITEM_NOT_FOUND");
  });

  it("preço: sem tamanho é SIZE_REQUIRED com o botão desligado; com tamanho sai o valor", async () => {
    const missing = (await post(fx.a.slug, "/price", { itemId: pizzaId, quantity: 1 }).expect(200)).body;
    expect(missing).toMatchObject({ ok: false, errors: [{ code: "SIZE_REQUIRED" }], button: { disabled: true, code: "SIZE_REQUIRED" } });

    const tree = (await get(fx.a.slug).expect(200)).body;
    const sizeId = tree.categories[0].items[0].sizes[0].id;
    const ok = (await post(fx.a.slug, "/price", { itemId: pizzaId, sizeId, quantity: 2 }).expect(200)).body;
    expect(ok).toMatchObject({ ok: true, line: { totalCents: 10000 }, button: { disabled: false, totalCents: 10000 } });

    const soldOut = (await post(fx.a.slug, "/price", { itemId: sodaId, quantity: 1 }).expect(200)).body;
    expect(soldOut.errors[0].code).toBe("ITEM_UNAVAILABLE");
    await post(fx.a.slug, "/price", { itemId: "x", quantity: 1 }).expect(400);
  });

  it("entrega e agendamento", async () => {
    const pickup = (await post(fx.a.slug, "/delivery-quote", { mode: "PICKUP", subtotalCents: 5000 }).expect(200)).body;
    expect(pickup).toMatchObject({ ok: true, mode: "PICKUP", feeCents: 0 });
    const out = (await post(fx.a.slug, "/delivery-quote", { mode: "DELIVERY", subtotalCents: 5000, address: { district: "Centro" } }).expect(200)).body;
    expect(out).toMatchObject({ ok: false, code: "OUT_OF_AREA" });
    await post(fx.a.slug, "/delivery-quote", { mode: "VOO" }).expect(400);
    expect((await get(fx.a.slug, "/slots").expect(200)).body).toEqual({ slots: [] });
  });

  it("faixa de horário do item vale no horário de Brasília e passa da meia-noite", () => {
    const friday23h = new Date("2026-11-21T02:00:00Z"); // sexta 23:00 em Brasília
    expect(availableAt([], friday23h)).toBe(true);
    expect(availableAt([{ weekday: 5, startMinute: 18 * 60, endMinute: 2 * 60 }], friday23h)).toBe(true);
    expect(availableAt([{ weekday: 5, startMinute: 18 * 60, endMinute: 2 * 60 }], new Date("2026-11-21T04:00:00Z"))).toBe(true); // sáb 01:00
    expect(availableAt([{ weekday: 5, startMinute: 11 * 60, endMinute: 15 * 60 }], friday23h)).toBe(false);
  });

  it("limite por IP responde 429", async () => {
    let status = 0;
    for (let i = 0; i <= PUBLIC_RATE_LIMIT && status !== 429; i++) status = (await get("limite-xyz", "/slots")).status;
    expect(status).toBe(429);
  });
});
