import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceOf, siteSource } from "../src/site/site.controller.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp, PASSWORD } from "./helpers.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36";

describe("tráfego do site", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let superAdminId: string;
  let superToken: string;
  let userToken: string;
  const path = `/teste-${randomUUID()}`;

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    const superAdmin = await admin.user.create({
      data: {
        name: "Equipe Plataforma",
        email: `trafego-${fx.a.id}@teste.local`,
        passwordHash: await hash(PASSWORD),
        isSuperAdmin: true,
        memberships: { create: { tenantId: fx.a.id, role: "ADMIN" } },
      },
      select: { id: true, email: true },
    });
    superAdminId = superAdmin.id;
    superToken = await accessTokenFor(app, superAdmin.email, fx.a.id);
    userToken = await accessTokenFor(app, fx.user.email, fx.b.id);
  });

  afterAll(async () => {
    await admin.siteVisit.deleteMany({ where: { path } });
    await admin.user.deleteMany({ where: { id: superAdminId } });
    await fx?.cleanup();
    await app?.close();
  });

  const visit = (body: object, userAgent = DESKTOP, ip = "203.0.113.7") =>
    request(app.getHttpServer()).post("/api/site/visits").set("User-Agent", userAgent).set("X-Forwarded-For", `${ip}, 10.0.0.1`).send(body);

  it("grava a página vista sem login, com a origem e o aparelho, sem o IP", async () => {
    await visit({ kind: "pageview", path: `${path}?utm_campaign=x`, referrer: "https://l.instagram.com/?u=abc" }, IPHONE).expect(204);
    await visit({ kind: "cta", path, referrer: "https://www.dishdesk.com.br/funcionalidades" }).expect(204);

    const rows = await admin.siteVisit.findMany({ where: { path }, orderBy: { createdAt: "asc" } });
    expect(rows).toMatchObject([
      { kind: "PAGEVIEW", source: "Instagram", device: "MOBILE" },
      { kind: "CTA", source: null, device: "DESKTOP" },
    ]);
    expect(rows[0]!.visitorId).not.toBe(rows[1]!.visitorId);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.7");
  });

  it("ignora robôs e recusa dados malformados", async () => {
    await visit({ kind: "pageview", path }, "Mozilla/5.0 (compatible; Googlebot/2.1)").expect(204);
    await visit({ kind: "pageview", path: "sem-barra" }).expect(400);
    await visit({ kind: "outro", path }).expect(400);
    expect(await admin.siteVisit.count({ where: { path } })).toBe(2);
  });

  it("o mesmo visitante no mesmo dia conta uma vez", async () => {
    await visit({ kind: "pageview", path }, IPHONE).expect(204);
    const visitors = await admin.siteVisit.groupBy({ by: ["visitorId"], where: { path, kind: "PAGEVIEW" } });
    expect(visitors).toHaveLength(1);
  });

  it("só a plataforma vê o tráfego, nos períodos de 7, 30 ou 90 dias", async () => {
    await request(app.getHttpServer()).get("/api/platform/traffic").set("Authorization", `Bearer ${userToken}`).expect(403);
    await request(app.getHttpServer()).get("/api/platform/traffic?days=5").set("Authorization", `Bearer ${superToken}`).expect(422);

    const { body } = await request(app.getHttpServer()).get("/api/platform/traffic?days=7").set("Authorization", `Bearer ${superToken}`).expect(200);
    expect(body.days).toBe(7);
    expect(body.daily).toHaveLength(7);
    expect(body.hours).toHaveLength(24);
    expect(body.totals.pageviews).toBeGreaterThanOrEqual(2);
    expect(body.totals.ctaClicks).toBeGreaterThanOrEqual(1);
    expect(body.daily.at(-1).pageviews).toBeGreaterThanOrEqual(2);
    expect(body.insights.length).toBeGreaterThan(0);
    const page = body.pages.find((row: { path: string }) => row.path === path);
    if (page) expect(page).toEqual({ path, pageviews: 2, visitors: 1 });
  });

  it("dá nome às origens conhecidas e separa celular, tablet e computador", () => {
    expect(siteSource("ig", undefined)).toBe("Instagram");
    expect(siteSource("newsletter", "https://google.com/")).toBe("newsletter");
    expect(siteSource(undefined, "https://www.google.com.br/search")).toBe("Google");
    expect(siteSource(undefined, "https://wa.me/5586")).toBe("WhatsApp");
    expect(siteSource(undefined, "https://blog.exemplo.com/post")).toBe("blog.exemplo.com");
    expect(siteSource(undefined, "https://dishdesk.com.br/")).toBeNull();
    expect(siteSource(undefined, "não é url")).toBeNull();
    expect(deviceOf(IPHONE)).toBe("MOBILE");
    expect(deviceOf("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe("TABLET");
    expect(deviceOf("Mozilla/5.0 (Linux; Android 15; SM-X710) Safari/537.36")).toBe("TABLET");
    expect(deviceOf(DESKTOP)).toBe("DESKTOP");
  });
});
