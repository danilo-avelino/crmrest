import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

describe("Dashboard do funil do cardápio (F7-06)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let token: string; // administrador em B
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const get = (tenantId: string, query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`) =>
    request(app.getHttpServer()).get(`/api/menu/${tenantId}/funnel?${query}`).set("Authorization", `Bearer ${token}`);
  const event = (tenantId: string, stage: "PAGE_VIEW" | "ADD_TO_CART" | "PURCHASE", sessionId: string, channel: "WEB" | "WHATSAPP" = "WEB", attribution: object = {}) =>
    admin.funnelEvent.create({ data: { tenantId, eventId: randomUUID(), stage, channel, sessionId, attribution } });
  const order = async (tenantId: string, contactId: string, channelId: string, total: string, over: Record<string, unknown> = {}) =>
    admin.order.create({
      data: { tenantId, contactId, channelId, externalOrderId: randomUUID(), status: "CONFIRMED", subtotal: total, deliveryFee: "0", total, placedAt: new Date(), raw: {}, source: "MENU", ...over },
    });

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    token = await accessTokenFor(app, fx.user.email, fx.b.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("sem o módulo MENU responde 403", async () => {
    await get(fx.b.id).expect(403);
  });

  it("período inválido responde 400", async () => {
    await admin.tenantModule.create({ data: { tenantId: fx.b.id, module: "MENU" } });
    await get(fx.b.id, `from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`).expect(400);
  });

  it("vazio: zeros e sem erro", async () => {
    const res = (await get(fx.b.id).expect(200)).body;
    expect(res).toMatchObject({ orders: 0, revenueCents: 0, averageTicketCents: 0, daily: [], byChannel: { WEB: 0, WHATSAPP: 0 } });
    expect(res.summary.steps[0]).toMatchObject({ stage: "PAGE_VIEW", visitors: 0 });
  });

  it("conta etapas, origem, canal, pedidos do cardápio (sem cancelados nem de outra origem) e ticket médio", async () => {
    await event(fx.b.id, "PAGE_VIEW", "s-000001", "WEB", { utm_source: "instagram" });
    await event(fx.b.id, "PAGE_VIEW", "s-000002");
    await event(fx.b.id, "ADD_TO_CART", "s-000001", "WEB", { utm_source: "instagram" });
    await event(fx.b.id, "PURCHASE", "s-000001", "WEB", { utm_source: "instagram" });
    await event(fx.b.id, "PURCHASE", "s-000009", "WHATSAPP");
    const contact = await admin.contact.create({ data: { tenantId: fx.b.id, name: "Cliente" } });
    const channel = await admin.channel.create({ data: { tenantId: fx.b.id, type: "WEBCHAT", name: "Teste", externalId: randomUUID(), credentials: Buffer.from("x"), status: "CONNECTED" } });
    const linked = await order(fx.b.id, contact.id, channel.id, "50.00");
    await order(fx.b.id, contact.id, channel.id, "30.50"); // sem evento PURCHASE ligado: fica sem origem
    await admin.funnelEvent.create({ data: { tenantId: fx.b.id, eventId: randomUUID(), stage: "PURCHASE", channel: "WEB", sessionId: "s-000001", orderId: linked.id, attribution: { utm_source: "instagram" } } });
    await order(fx.b.id, contact.id, channel.id, "40.00", { placedAt: new Date(Date.now() - 80 * 3_600_000) }); // fora do período, e fora do anterior
    await order(fx.b.id, contact.id, channel.id, "20.00", { placedAt: new Date(Date.now() - 47 * 3_600_000) }); // período anterior
    await order(fx.b.id, contact.id, channel.id, "99.00", { status: "CANCELED" });
    await order(fx.b.id, contact.id, channel.id, "70.00", { source: "PLATFORM" });

    const res = (await get(fx.b.id).expect(200)).body;
    expect(res.orders).toBe(2);
    expect(res.revenueCents).toBe(8050);
    expect(res.averageTicketCents).toBe(4025);
    expect(res.previous).toEqual({ orders: 1, revenueCents: 2000 });
    expect(res.ticketBySource).toEqual([{ source: "instagram", orders: 1, revenueCents: 5000 }]);
    expect(res.unattributedOrders).toBe(1);
    expect(res.daily.reduce((n: number, d: { orders: number }) => n + d.orders, 0)).toBe(2);
    expect(res.byChannel).toEqual({ WEB: 1, WHATSAPP: 1 });
    const step = (stage: string) => res.summary.steps.find((s: { stage: string }) => s.stage === stage);
    expect(step("PAGE_VIEW").visitors).toBe(2);
    expect(step("ADD_TO_CART")).toMatchObject({ visitors: 1, fromPrevious: null, fromFirst: 0.5 });
    expect(res.bySource).toContainEqual({ source: "instagram", stage: "PURCHASE", visitors: 1 });

    const web = (await get(fx.b.id, `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&channel=WEB`).expect(200)).body;
    expect(step("PURCHASE").visitors).toBe(2);
    expect(web.summary.steps.find((s: { stage: string }) => s.stage === "PURCHASE").visitors).toBe(1);
  });

  it("isolamento: não lê outro restaurante, nem sem vínculo", async () => {
    await admin.tenantModule.create({ data: { tenantId: fx.a.id, module: "MENU" } });
    await event(fx.a.id, "PAGE_VIEW", "s-outro01");
    // token de B (admin) não enxerga A; o usuário é só atendente em A e membro lê, mas os dados de B não vazam em A
    const tokenA = await accessTokenFor(app, fx.user.email, fx.a.id);
    const resA = await request(app.getHttpServer())
      .get(`/api/menu/${fx.a.id}/funnel?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(resA.status).toBe(200);
    expect(resA.body.orders).toBe(0);
    expect(resA.body.summary.steps[0].visitors).toBe(1);
    await get(fx.c.id).expect(403);
  });
});
