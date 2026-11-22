import { randomUUID } from "node:crypto";
import { createPrismaClient, withTenants } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FunnelService } from "../src/funnel/funnel.service.js";
import { admin, createAuthFixture, createTestApp } from "./helpers.js";

describe("Funil de vendas do cardápio (F7-01)", () => {
  const funnel = new FunnelService();
  const appDb = createPrismaClient(process.env.DATABASE_URL ?? "");
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  const post = (slug: string, body: object) => request(app.getHttpServer()).post(`/api/public/menu/${slug}/events`).send(body);
  const browserEvent = (over: Record<string, unknown> = {}) => ({ eventId: randomUUID(), stage: "PAGE_VIEW", sessionId: "sessao-0001", ...over });
  const range = () => ({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });
  const inTenant = <T>(tenantId: string, fn: Parameters<typeof withTenants<T>>[2]) => withTenants(appDb, { tenantIds: [tenantId] }, fn);
  const rec = (tenantId: string, over: Partial<Parameters<FunnelService["record"]>[2]> = {}) =>
    inTenant(tenantId, (tx) => funnel.record(tx, tenantId, { eventId: randomUUID(), stage: "PAGE_VIEW", channel: "WEB", ...over }));

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    await admin.tenantModule.create({ data: { tenantId: fx.a.id, module: "MENU" } });
    await admin.menu.create({ data: { tenantId: fx.a.id, name: "Cardápio" } });
    await admin.tenantModule.create({ data: { tenantId: fx.b.id, module: "MENU" } });
    await admin.menu.create({ data: { tenantId: fx.b.id, name: "Cardápio" } });
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await appDb.$disconnect();
  });

  it("record não duplica o mesmo eventId no restaurante", async () => {
    const eventId = randomUUID();
    expect(await rec(fx.a.id, { eventId })).toBe(true);
    expect(await rec(fx.a.id, { eventId })).toBe(false);
    expect(await admin.funnelEvent.count({ where: { tenantId: fx.a.id, eventId } })).toBe(1);
  });

  it("endpoint público grava a etapa do navegador no canal WEB com a atribuição filtrada", async () => {
    const body = browserEvent({ stage: "ADD_TO_CART", valueCents: 4500, attribution: { utm_source: "instagram", fbclid: "abc", intruso: "x" } });
    const res = await post(fx.a.slug, body).expect(200);
    expect(res.body).toEqual({ recorded: true });
    const row = await admin.funnelEvent.findFirstOrThrow({ where: { tenantId: fx.a.id, eventId: body.eventId } });
    expect(row).toMatchObject({ stage: "ADD_TO_CART", channel: "WEB", sessionId: "sessao-0001", valueCents: 4500 });
    expect(row.attribution).toEqual({ utm_source: "instagram", fbclid: "abc" });
    expect((await post(fx.a.slug, body).expect(200)).body).toEqual({ recorded: false });
  });

  it("slug desconhecido e módulo desligado respondem 404", async () => {
    await post("nao-existe-xyz", browserEvent()).expect(404);
    await post(fx.c.slug, browserEvent()).expect(404);
    await admin.tenantModule.deleteMany({ where: { tenantId: fx.b.id } });
    await post(fx.b.slug, browserEvent()).expect(404);
    expect(await admin.funnelEvent.count({ where: { tenantId: { in: [fx.b.id, fx.c.id] } } })).toBe(0);
  });

  it("etapa inválida é rejeitada: PURCHASE e ADD_PAYMENT_INFO nunca vêm do navegador", async () => {
    for (const stage of ["PURCHASE", "ADD_PAYMENT_INFO", "QUALQUER"]) await post(fx.a.slug, browserEvent({ stage })).expect(400);
    await post(fx.a.slug, browserEvent({ eventId: "nao-uuid" })).expect(400);
    await post(fx.a.slug, browserEvent({ sessionId: "curto" })).expect(400);
    expect(await admin.funnelEvent.count({ where: { tenantId: fx.a.id, stage: { in: ["PURCHASE", "ADD_PAYMENT_INFO"] } } })).toBe(0);
  });

  it("summary conta visitantes por etapa, a conversão entre etapas e filtra por canal", async () => {
    const tenantId = fx.b.id;
    // 4 visitantes veem a página (um deles duas vezes), 2 veem item, 1 coloca no carrinho no WhatsApp e compra.
    for (const s of ["s1", "s2", "s3", "s4", "s4"]) await rec(tenantId, { sessionId: s });
    for (const s of ["s1", "s2"]) await rec(tenantId, { stage: "VIEW_CONTENT", sessionId: s });
    await rec(tenantId, { stage: "SEARCH", sessionId: "s1" });
    await rec(tenantId, { stage: "ADD_TO_CART", sessionId: "s1" });
    const contactId = randomUUID();
    await rec(tenantId, { stage: "ADD_TO_CART", channel: "WHATSAPP", contactId });
    await rec(tenantId, { stage: "INITIATE_CHECKOUT", channel: "WHATSAPP", contactId });
    await rec(tenantId, { stage: "PURCHASE", channel: "WHATSAPP", contactId, valueCents: 5000 });
    const summary = await inTenant(tenantId, (tx) => funnel.summary(tx, tenantId, range()));
    const step = (stage: string) => summary.steps.find((s) => s.stage === stage)!;
    expect(step("PAGE_VIEW")).toMatchObject({ events: 5, visitors: 4, fromPrevious: null });
    expect(step("VIEW_CONTENT")).toMatchObject({ visitors: 2, fromPrevious: 0.5, fromFirst: 0.5 });
    expect(step("ADD_TO_CART")).toMatchObject({ visitors: 2, fromPrevious: 1, fromFirst: 0.5 });
    expect(step("INITIATE_CHECKOUT")).toMatchObject({ visitors: 1, fromPrevious: 0.5, fromFirst: 0.25 });
    expect(step("ADD_PAYMENT_INFO")).toMatchObject({ visitors: 0, fromPrevious: 0 });
    expect(step("PURCHASE")).toMatchObject({ visitors: 1, fromPrevious: null, fromFirst: 0.25 });
    expect(summary.searches).toBe(1);
    const whatsapp = await inTenant(tenantId, (tx) => funnel.summary(tx, tenantId, { ...range(), channel: "WHATSAPP" }));
    expect(whatsapp.steps.find((s) => s.stage === "PAGE_VIEW")).toMatchObject({ visitors: 0, fromFirst: null });
    expect(whatsapp.steps.find((s) => s.stage === "PURCHASE")).toMatchObject({ visitors: 1 });
    const outside = await inTenant(tenantId, (tx) => funnel.summary(tx, tenantId, { from: new Date(0), to: new Date(1000) }));
    expect(outside.steps.every((s) => s.events === 0)).toBe(true);
  });

  it("bySource separa por utm_source, referrer e direto", async () => {
    const tenantId = fx.b.id;
    await rec(tenantId, { sessionId: "o1", attribution: { utm_source: "meta" } });
    await rec(tenantId, { sessionId: "o2", attribution: { referrer: "google.com" } });
    const rows = await inTenant(tenantId, (tx) => funnel.bySource(tx, tenantId, range()));
    const of = (source: string) => rows.find((r) => r.source === source && r.stage === "PAGE_VIEW")?.visitors;
    expect(of("meta")).toBe(1);
    expect(of("google.com")).toBe(1);
    expect(of("direto")).toBeGreaterThanOrEqual(4);
  });

  it("isolamento: um restaurante não vê nem conta eventos do outro", async () => {
    const eventId = randomUUID();
    await rec(fx.a.id, { eventId, sessionId: "so-a" });
    const seenByB = await inTenant(fx.b.id, (tx) => tx.funnelEvent.count({ where: { eventId } }));
    expect(seenByB).toBe(0);
    // O mesmo eventId em outro restaurante é outro evento (único por restaurante).
    expect(await rec(fx.b.id, { eventId })).toBe(true);
    const summaryA = await inTenant(fx.a.id, (tx) => funnel.summary(tx, fx.a.id, range()));
    expect(summaryA.steps.find((s) => s.stage === "PURCHASE")!.events).toBe(0);
  });
});
