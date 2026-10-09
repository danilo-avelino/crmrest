import { createPrismaClient, withTenants } from "@dishdesk/database";
import { automationTextDefaults, DEFAULT_BUSINESS_HOURS, PERSONALITY_MESSAGES } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const CORDIAL = automationTextDefaults("cordial");
const LINKS = [
  { label: "Cardápio digital", url: "https://pedido.exemplo.com" },
  { label: "iFood", url: "https://www.ifood.com.br/delivery/exemplo" },
];

describe("Configurações do restaurante (links de pedido)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let agentToken: string; // atendente em A
  let adminToken: string; // administrador em B
  let masterToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    await admin.tenant.update({ where: { id: fx.b.id }, data: { settings: { horario: "18h às 23h" } } });
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
    masterToken = await accessTokenFor(app, fx.user.email, "master");
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const api = (method: "get" | "put", path: string, token: string) =>
    request(app.getHttpServer())[method](`/api/settings${path}`).set("Authorization", `Bearer ${token}`);

  it("atendente vê as configurações do restaurante, mas não altera", async () => {
    const { body } = await api("get", "", agentToken).expect(200);
    expect(body).toMatchObject([{ tenantId: fx.a.id, tenantName: "Teste A", canEdit: false, orderLinks: [] }]);
    const refused = await api("put", `/${fx.a.id}/order-links`, agentToken).send({ orderLinks: LINKS }).expect(403);
    expect(refused.body.message).toBe("Só o administrador do restaurante altera as configurações.");
  });

  it("administrador salva os links, sem apagar as outras configurações", async () => {
    const { body } = await api("put", `/${fx.b.id}/order-links`, adminToken).send({ orderLinks: LINKS }).expect(200);
    expect(body).toMatchObject({ tenantId: fx.b.id, tenantName: "Teste B", canEdit: true, orderLinks: LINKS });
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { id: fx.b.id } });
    expect(tenant.settings).toEqual({ horario: "18h às 23h", orderLinks: LINKS });
  });

  it("recusa link sem nome, endereço que não é http(s) e links demais", async () => {
    const put = (orderLinks: unknown) => api("put", `/${fx.b.id}/order-links`, adminToken).send({ orderLinks });
    await put([{ label: "", url: "https://pedido.exemplo.com" }]).expect(400);
    await put([{ label: "Cardápio", url: "pedido.exemplo.com" }]).expect(400);
    await put([{ label: "Cardápio", url: "javascript:alert(1)" }]).expect(400);
    await put(Array.from({ length: 6 }, (_, i) => ({ label: `Link ${i}`, url: `https://exemplo.com/${i}` }))).expect(400);
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: fx.b.id } })).settings).toMatchObject({ orderLinks: LINKS });
  });

  it("painel master lista os restaurantes do usuário e não altera restaurante de fora", async () => {
    const { body } = await api("get", "", masterToken).expect(200);
    expect(body).toMatchObject([
      { tenantId: fx.a.id, tenantName: "Teste A", canEdit: false, orderLinks: [] },
      { tenantId: fx.b.id, tenantName: "Teste B", canEdit: true, orderLinks: LINKS },
    ]);
    await api("put", `/${fx.c.id}/order-links`, masterToken).send({ orderLinks: LINKS }).expect(403);
    await api("put", `/${fx.b.id}/order-links`, masterToken).send({ orderLinks: [] }).expect(200);
  });

  it("mensagens automáticas e horário: padrões até o admin salvar, sem apagar os links", async () => {
    const before = (await api("get", "", adminToken).expect(200)).body[0];
    expect(before).toMatchObject({ personality: "cordial", automationTexts: CORDIAL, businessHours: DEFAULT_BUSINESS_HOURS });

    const texts = { ...CORDIAL, greeting: "Bem-vindo à Cantina, {nome}!" };
    await api("put", `/${fx.a.id}/automation-texts`, agentToken).send(texts).expect(403);
    await api("put", `/${fx.b.id}/automation-texts`, adminToken).send({ ...texts, phoneRequest: " " }).expect(400);
    const saved = await api("put", `/${fx.b.id}/automation-texts`, adminToken).send(texts).expect(200);
    expect(saved.body.automationTexts).toEqual(texts);

    const hours = { ...DEFAULT_BUSINESS_HOURS, enabled: true, days: [null, ...DEFAULT_BUSINESS_HOURS.days.slice(1)] };
    await api("put", `/${fx.b.id}/business-hours`, adminToken).send({ ...hours, days: hours.days.slice(1) }).expect(400);
    await api("put", `/${fx.b.id}/business-hours`, adminToken)
      .send({ ...hours, days: [{ open: "25:00", close: "23:00" }, ...hours.days.slice(1)] })
      .expect(400);
    const { body } = await api("put", `/${fx.b.id}/business-hours`, adminToken).send(hours).expect(200);
    expect(body).toMatchObject({ businessHours: hours, automationTexts: texts });
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: fx.b.id } })).settings).toMatchObject({ horario: "18h às 23h" });
  });

  it("personalidade: troca os textos que seguiam o padrão e mantém os personalizados", async () => {
    await api("put", `/${fx.a.id}/personality`, agentToken).send({ personality: "formal" }).expect(403);
    await api("put", `/${fx.b.id}/personality`, adminToken).send({ personality: "sarcastico" }).expect(400);

    const formal = PERSONALITY_MESSAGES.formal;
    const { body } = await api("put", `/${fx.b.id}/personality`, adminToken).send({ personality: "formal" }).expect(200);
    expect(body).toMatchObject({
      personality: "formal",
      // A saudação foi editada no teste anterior: continua a do restaurante.
      automationTexts: { ...automationTextDefaults("formal"), greeting: "Bem-vindo à Cantina, {nome}!" },
      businessHours: { enabled: true, closedMessage: formal.closedMessage },
      orderLinks: [],
    });

    // Voltar ao cordial devolve os textos do cordial.
    const back = await api("put", `/${fx.b.id}/personality`, adminToken).send({ personality: "cordial" }).expect(200);
    expect(back.body.automationTexts).toEqual({ ...CORDIAL, greeting: "Bem-vindo à Cantina, {nome}!" });
    expect(back.body.businessHours.closedMessage).toBe(DEFAULT_BUSINESS_HOURS.closedMessage);
  });

  it("no banco, só o administrador grava, e só a coluna de configurações", async () => {
    const db = createPrismaClient(process.env.DATABASE_URL ?? "");
    try {
      const asUser = (tenantId: string, data: { settings?: object; name?: string }) =>
        withTenants(db, { tenantIds: [tenantId], userId: fx.user.id }, (tx) => tx.tenant.update({ where: { id: tenantId }, data }));
      await expect(asUser(fx.a.id, { settings: { orderLinks: [] } })).rejects.toThrow(); // atendente em A
      await expect(asUser(fx.b.id, { name: "Outro nome" })).rejects.toThrow(); // nome é da plataforma
      await expect(asUser(fx.b.id, { settings: { orderLinks: [] } })).resolves.toMatchObject({ id: fx.b.id });
    } finally {
      await db.$disconnect();
    }
  });
});
