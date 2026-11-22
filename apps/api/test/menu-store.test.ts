import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

describe("Dados da loja do cardápio (F2-13)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let adminToken: string; // administrador em B
  let agentToken: string; // atendente em A
  const store = (tenantId: string, method: "get" | "put", token: string, path = "") =>
    request(app.getHttpServer())[method](`/api/menu/${tenantId}/store${path}`).set("Authorization", `Bearer ${token}`);

  const body = {
    address: { street: "Rua das Flores", number: "10", district: "Centro", city: "Recife", state: "PE", zip: "50000-000" },
    pickupEnabled: true,
    prepMinutes: 20,
    delivery: { mode: "BY_DISTRICT", districts: [{ district: "Centro", feeCents: 600 }] },
    minOrderCents: 2500,
    freeDeliveryFromCents: 9000,
    deliveryMinMinutes: 30,
    deliveryMaxMinutes: 50,
    paymentMethods: ["pix", "cash"],
    scheduling: { enabled: true, minLeadMinutes: 60, slotMinutes: 30 },
    promoShowcase: { itemIds: [], frequencyHours: 24 },
    accentColor: "#112233",
    city: "Recife",
    phone: "(81) 99999-0000",
    cnpj: "12.345.678/0001-90",
    about: "Massas artesanais",
  };

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const enable = (tenantId: string) => admin.tenantModule.upsert({ where: { tenantId_module: { tenantId, module: "MENU" } }, create: { tenantId, module: "MENU" }, update: {} });

  it("sem o módulo MENU responde 403", async () => {
    await store(fx.b.id, "get", adminToken).expect(403);
    await store(fx.b.id, "put", adminToken).send(body).expect(403);
  });

  it("salva, devolve e mantém o resto das configurações; corpo inválido responde 400; logo por URL é ignorada", async () => {
    await enable(fx.b.id);
    await admin.tenant.update({ where: { id: fx.b.id }, data: { settings: { personality: "formal" } } });
    const first = (await store(fx.b.id, "get", adminToken).expect(200)).body;
    expect(first).toMatchObject({ slug: fx.b.slug, accentDefault: "#8E2F1B" });

    const saved = (await store(fx.b.id, "put", adminToken).send({ ...body, logoUrl: "https://evil/x.png" }).expect(200)).body;
    expect(saved.store).toMatchObject({ accentColor: "#112233", city: "Recife", minOrderCents: 2500 });
    expect(saved.store.logoUrl).toBeUndefined();
    const row = await admin.tenant.findUniqueOrThrow({ where: { id: fx.b.id }, select: { settings: true } });
    expect(row.settings).toMatchObject({ personality: "formal", menuStore: { accentColor: "#112233" } });

    await store(fx.b.id, "put", adminToken).send({ ...body, accentColor: "red" }).expect(400);
    await store(fx.b.id, "put", adminToken).send({ ...body, minOrderCents: 12.5 }).expect(400);
  });

  it("atendente lê, mas não altera nem envia imagem; formato de imagem inválido responde 400", async () => {
    await enable(fx.a.id);
    await store(fx.a.id, "get", agentToken).expect(200);
    await store(fx.a.id, "put", agentToken).send(body).expect(403);
    await store(fx.a.id, "put", agentToken, "/logo").set("Content-Type", "image/png").send(Buffer.from([1, 2])).expect(403);
    await store(fx.b.id, "put", adminToken, "/cover").set("Content-Type", "image/gif").send(Buffer.from([1, 2])).expect(400);
    await store(fx.b.id, "put", adminToken, "/logo").set("Content-Type", "image/png").send(Buffer.alloc(0)).expect(400);
  });

  it("a API pública traz a marca, o horário e a hora de fechar, sem campo interno", async () => {
    await admin.menu.upsert({ where: { tenantId: fx.b.id }, create: { tenantId: fx.b.id, name: "Cardápio" }, update: {} });
    const days = Array.from({ length: 7 }, () => [{ open: "00:00", close: "23:59" }]);
    await admin.tenant.update({
      where: { id: fx.b.id },
      data: { settings: { businessHours: { enabled: true, days, closedMessage: "Fechado" }, menuStore: { ...body, logoUrl: "https://cdn/logo.png", coverUrl: "https://cdn/capa.jpg" } } },
    });
    const res = await request(app.getHttpServer()).get(`/api/public/menu/${fx.b.slug}`).expect(200);
    expect(res.body.store).toMatchObject({
      logoUrl: "https://cdn/logo.png",
      coverUrl: "https://cdn/capa.jpg",
      accentColor: "#112233",
      city: "Recife",
      address: "Rua das Flores, 10 · Centro",
      phone: "(81) 99999-0000",
      cnpj: "12.345.678/0001-90",
      about: "Massas artesanais",
      status: "open",
      closesAt: "23:59",
    });
    expect(res.body.store.weekHours).toHaveLength(7);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(fx.b.id);
    // A vitrine (W3) e o Pixel ID são públicos de propósito; o código de teste da Meta, não.
    expect(text).not.toContain("metaTestEventCode");
    expect(text).not.toContain("closedMessage");
  });

  it("sem marca salva, a cor é a padrão e os campos vêm nulos", async () => {
    await admin.tenant.update({ where: { id: fx.b.id }, data: { settings: {} } });
    const res = await request(app.getHttpServer()).get(`/api/public/menu/${fx.b.slug}`).expect(200);
    expect(res.body.store).toMatchObject({ accentColor: "#8E2F1B", logoUrl: null, coverUrl: null, city: null, address: null, phone: null, weekHours: null, closesAt: null });
  });
});
