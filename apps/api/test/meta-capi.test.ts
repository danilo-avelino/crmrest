import { randomUUID } from "node:crypto";
import { DEFAULT_MENU_STORE } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capiEvent, hashedPhone } from "../src/funnel/meta-capi.js";
import { MetaCapiService } from "../src/funnel/meta-capi.service.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const TOKEN = "EAAtokenDeTesteDaConversionsApi1234";
const BASE = {
  eventId: randomUUID(),
  stage: "PURCHASE" as const,
  channel: "WEB" as const,
  orderId: randomUUID(),
  contactId: "c1",
  valueCents: 5990,
  attribution: { ads_consent: "granted", fbp: "fb.1.1.2", fbc: "fb.1.1.abc", client_ua: "Mozilla/5.0", client_ip: "200.1.1.1" },
  createdAt: new Date("2026-11-22T20:00:00Z"),
  phone: "+55 11 98888-7777",
};

describe("Conversions API da Meta (F7-04)", () => {
  it("evento do site com consentimento: event_id do Pixel, telefone com hash e valor em reais", () => {
    const built = capiEvent(BASE, "https://app/c/loja");
    expect(built).toMatchObject({
      event: {
        event_name: "Purchase",
        event_id: BASE.eventId,
        action_source: "website",
        event_time: 1795377600,
        user_data: { ph: [hashedPhone("5511988887777")], fbp: "fb.1.1.2", fbc: "fb.1.1.abc", client_user_agent: "Mozilla/5.0", client_ip_address: "200.1.1.1" },
        custom_data: { value: 59.9, currency: "BRL" },
      },
    });
    expect(JSON.stringify(built)).not.toContain("98888");
  });

  it("não envia sem consentimento, do WhatsApp nem o checkout repetido pelo servidor", () => {
    expect(capiEvent({ ...BASE, attribution: { ...BASE.attribution, ads_consent: "denied" } }, "u")).toEqual({ skip: "skip: sem consentimento" });
    expect(capiEvent({ ...BASE, channel: "WHATSAPP" }, "u")).toEqual({ skip: "skip: WhatsApp (F7-05)" });
    expect(capiEvent({ ...BASE, stage: "INITIATE_CHECKOUT" }, "u")).toEqual({ skip: "skip: repete o do navegador" });
    expect(capiEvent({ ...BASE, attribution: { ads_consent: "granted" } }, "u")).toEqual({ skip: "skip: sem o navegador do visitante" });
  });

  describe("token, envio e saúde", () => {
    let app: INestApplication;
    let fx: Awaited<ReturnType<typeof createAuthFixture>>;
    let capi: MetaCapiService;
    const url = () => `/api/menu/${fx.b.id}/meta-capi`;

    beforeAll(async () => {
      app = await createTestApp();
      capi = app.get(MetaCapiService, { each: true })[0]!;
      fx = await createAuthFixture();
      await admin.tenantModule.create({ data: { tenantId: fx.b.id, module: "MENU" } });
      await admin.tenant.update({ where: { id: fx.b.id }, data: { settings: { menuStore: { ...DEFAULT_MENU_STORE, metaPixelId: "123456789012345", metaTestEventCode: "TEST123" } } } });
    });

    afterAll(async () => {
      await fx?.cleanup();
      await app?.close();
    });

    it("o administrador salva o token; ele fica criptografado e nunca volta", async () => {
      const token = await accessTokenFor(app, fx.user.email, fx.b.id);
      await request(app.getHttpServer()).put(url()).set("Authorization", `Bearer ${token}`).send({ token: "curto demais" }).expect(400);
      const saved = await request(app.getHttpServer()).put(url()).set("Authorization", `Bearer ${token}`).send({ token: TOKEN }).expect(200);
      expect(saved.body).toMatchObject({ configured: true, last4: "1234", pixelConfigured: true });
      expect(JSON.stringify(saved.body)).not.toContain(TOKEN);
      const tenant = await admin.tenant.findUniqueOrThrow({ where: { id: fx.b.id } });
      expect(JSON.stringify(tenant.settings)).not.toContain(TOKEN);
      expect(tenant.settings).toMatchObject({ menuStore: { metaPixelId: "123456789012345" } });
    });

    it("envia os eventos com o token no corpo (nunca na URL), marca enviados e guarda a recusa da Meta", async () => {
      const now = new Date();
      const contact = await admin.contact.create({ data: { tenantId: fx.b.id, name: "Ana", phone: "+5511977776666" } });
      const event = (stage: "PAGE_VIEW" | "PURCHASE", attribution: object) =>
        admin.funnelEvent.create({ data: { tenantId: fx.b.id, eventId: randomUUID(), stage, channel: "WEB", contactId: contact.id, valueCents: stage === "PURCHASE" ? 5000 : null, attribution } });
      const ok = await event("PURCHASE", BASE.attribution);
      const denied = await event("PAGE_VIEW", { ads_consent: "denied" });
      const calls: { url: string; body: { data: { event_id: string }[]; access_token: string; test_event_code?: string } }[] = [];
      const fake = (status: number) => (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(status === 200 ? { events_received: 1 } : { error: { message: "Invalid OAuth access token" } }), { status });
      }) as typeof fetch;

      await capi.sendTenant(fx.b.id, now, fake(500)); // 5xx: tenta de novo depois
      expect((await admin.funnelEvent.findUniqueOrThrow({ where: { id: ok.id } })).capiSentAt).toBeNull();

      await capi.sendTenant(fx.b.id, now, fake(200));
      const last = calls.at(-1)!;
      expect(last.url).toMatch(/\/123456789012345\/events$/);
      expect(last.url).not.toContain(TOKEN);
      expect(last.body).toMatchObject({ access_token: TOKEN, test_event_code: "TEST123", data: [{ event_id: ok.eventId }] });
      expect(await admin.funnelEvent.findUniqueOrThrow({ where: { id: ok.id } })).toMatchObject({ capiSentAt: expect.any(Date), capiError: null });
      expect((await admin.funnelEvent.findUniqueOrThrow({ where: { id: denied.id } })).capiError).toBe("skip: sem consentimento");

      const refused = await event("PURCHASE", BASE.attribution);
      await capi.sendTenant(fx.b.id, now, fake(400));
      expect((await admin.funnelEvent.findUniqueOrThrow({ where: { id: refused.id } })).capiError).toBe("Meta 400: Invalid OAuth access token");

      const token = await accessTokenFor(app, fx.user.email, fx.b.id);
      const status = await request(app.getHttpServer()).get(url()).set("Authorization", `Bearer ${token}`).expect(200);
      const purchase = status.body.health.stages.find((s: { stage: string }) => s.stage === "PURCHASE");
      expect(purchase).toMatchObject({ browser: null, server: 1, failed: 1 });
      expect(status.body.health.stages.find((s: { stage: string }) => s.stage === "PAGE_VIEW")).toMatchObject({ browser: 0, server: 0 });
      expect(status.body.health.lastError).toMatchObject({ message: "Meta 400: Invalid OAuth access token" });
    });

    it("apagar o token desliga o envio", async () => {
      const token = await accessTokenFor(app, fx.user.email, fx.b.id);
      const off = await request(app.getHttpServer()).put(url()).set("Authorization", `Bearer ${token}`).send({ token: null }).expect(200);
      expect(off.body).toMatchObject({ configured: false, last4: null });
    });
  });
});
