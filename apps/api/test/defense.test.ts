import type { DefenseEventDto } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUTH_SUSPECT, NOT_FOUND_LIMIT, neverBanList } from "../src/defense/defense.rules.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp, PASSWORD, startMockGraph } from "./helpers.js";

describe("defesa da API", () => {
  let app: INestApplication;
  let jev: Awaited<ReturnType<typeof startMockGraph>>;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let superAdmin: { id: string; email: string };
  let superToken: string;
  let userToken: string;

  const from = (ip: string) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set("X-Real-IP", ip),
    login: (email: string) => request(app.getHttpServer()).post("/api/auth/login").set("X-Real-IP", ip).send({ email, password: "errada" }),
  });
  const platform = (method: "get" | "post", path: string, token = superToken) =>
    request(app.getHttpServer())[method](`/api/platform/${path}`).set("Authorization", `Bearer ${token}`);
  const events = async (): Promise<DefenseEventDto[]> => (await platform("get", "defense").expect(200)).body;
  const eventOf = async (ip: string) => (await events()).find((event) => event.ip === ip);

  beforeAll(async () => {
    // Jev falso: o abuso de login fica em dúvida; o resto é ataque.
    jev = await startMockGraph();
    jev.reply((req) => {
      const auth = (req.body as { state: { regra_que_disparou: string } }).state.regra_que_disparou === "Abuso de autenticação";
      return {
        status: 200,
        body: {
          model: "typesafe/jev-1.14-20261101",
          answers: {
            category: { type: "choice", choice: auth ? "auth_abuse" : "sensitive_probe", confidence: 0.9, probabilities: {} },
            attack: { type: "noul", noul: auth ? 0.5 : 0.97 },
          },
        },
      };
    });
    app = await createTestApp({
      DEFENSE_MODE: "ban",
      DEFENSE_ALLOW_IPS: "198.51.100.0/24, 2001:db8::7",
      JEV_API_KEY: "chave-de-teste",
      JEV_URL: `${jev.url}/api/alpha/decisions`,
    });
    fx = await createAuthFixture();
    superAdmin = await admin.user.create({
      data: {
        name: "Equipe Plataforma",
        email: `defesa-${fx.a.id}@teste.local`,
        passwordHash: await hash(PASSWORD),
        isSuperAdmin: true,
        memberships: { create: { tenantId: fx.a.id, role: "ADMIN" } },
      },
      select: { id: true, email: true },
    });
    superToken = await accessTokenFor(app, superAdmin.email, fx.a.id);
    userToken = await accessTokenFor(app, fx.user.email, fx.b.id);
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: superAdmin?.id } });
    await fx?.cleanup();
    await app?.close();
    await jev?.close();
  });

  it("só a equipe da plataforma vê e mexe nos casos", async () => {
    await platform("get", "defense", userToken).expect(403);
    await platform("post", `defense/${fx.a.id}/unban`, userToken).expect(403);
  });

  it("nunca bane a rede interna (o Next e a Railway chamam a API sem X-Real-IP)", async () => {
    await request(app.getHttpServer()).get("/.env").expect(404);
    await request(app.getHttpServer()).get("/api/health/live").expect(200);
    await from("10.0.0.5").get("/.git/config").expect(404);
    await from("10.0.0.5").get("/api/health/live").expect(200);
  });

  it("nunca bane a Fastly (IP de muita gente) nem os IPs da DEFENSE_ALLOW_IPS", async () => {
    for (const ip of ["151.101.1.140", "2a04:4e42::1", "198.51.100.99", "2001:db8::7"]) {
      await from(ip).get("/.env").expect(404);
      await from(ip).get("/api/health/live").expect(200);
    }
    expect((await events()).filter((event) => ["151.101.1.140", "198.51.100.99"].includes(event.ip))).toEqual([]);
  });

  it("uma entrada inválida na DEFENSE_ALLOW_IPS impede a API de subir", () => {
    expect(() => neverBanList("200.1.2.3, escritorio")).toThrow('DEFENSE_ALLOW_IPS: "escritorio"');
    expect(() => neverBanList("200.1.2.0/abc")).toThrow("DEFENSE_ALLOW_IPS");
  });

  it("quem sonda um .env é banido na hora; o Jev confirma o ataque e o banimento passa a 7 dias", async () => {
    await from("203.0.113.10").get("/.env").expect(404);
    await vi.waitFor(() => from("203.0.113.10").get("/api/health/live").expect(403));
    await from("203.0.113.11").get("/api/health/live").expect(200);

    await vi.waitFor(async () => expect((await eventOf("203.0.113.10"))?.analysis.state).toBe("done"));
    const event = (await eventOf("203.0.113.10"))!;
    expect(event).toMatchObject({
      reason: "sensitive_probe",
      action: "banned",
      active: true,
      method: "GET",
      path: "/.env",
      analysis: { state: "done", category: "sensitive_probe", conclusion: "attack", attack: 0.97, reused: false },
    });
    expect(new Date(event.bannedUntil!).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);

    // O Jev recebe as rotas e a regra, nunca o IP.
    const sent = JSON.stringify(jev.requests.at(-1)?.body);
    expect(sent).toContain("/.env");
    expect(sent).not.toContain("203.0.113.10");
    expect(jev.requests.at(-1)?.authorization).toBe("Bearer chave-de-teste");
  });

  it("o mesmo padrão de outro IP reaproveita a conclusão, sem chamar o Jev de novo", async () => {
    const calls = jev.requests.length;
    await from("203.0.113.20").get("/.env").expect(404);
    await vi.waitFor(async () => expect((await eventOf("203.0.113.20"))?.analysis.state).toBe("done"));
    expect((await eventOf("203.0.113.20"))?.analysis).toMatchObject({ conclusion: "attack", reused: true });
    expect(jev.requests.length).toBe(calls);
  });

  it("muitas rotas inexistentes diferentes banem; o 404 do mesmo recurso repetido não conta", async () => {
    for (let i = 0; i < NOT_FOUND_LIMIT + 5; i++) {
      await from("203.0.113.30").get(`/api/inexistente/0198a1b2-c3d4-7e5f-8a9b-${String(i).padStart(12, "0")}`).expect(404);
    }
    await from("203.0.113.30").get("/api/health/live").expect(200);

    for (let i = 0; i < NOT_FOUND_LIMIT; i++) await from("203.0.113.31").get(`/api/rota-${i}`);
    await vi.waitFor(() => from("203.0.113.31").get("/api/health/live").expect(403));
    expect((await eventOf("203.0.113.31"))?.reason).toBe("endpoint_enumeration");
  });

  it("abuso de login vira suspeita (sem banir); a plataforma bane e desbane pelo painel", async () => {
    for (let i = 0; i < AUTH_SUSPECT; i++) await from("203.0.113.40").login(`alvo-${i}@teste.local`);
    await vi.waitFor(async () => expect((await eventOf("203.0.113.40"))?.analysis.state).toBe("done"));
    const event = (await eventOf("203.0.113.40"))!;
    expect(event).toMatchObject({ reason: "auth_abuse", action: "suspected", active: false, bannedUntil: null });
    expect(event.analysis).toMatchObject({ category: "auth_abuse", conclusion: "uncertain" });
    expect(JSON.stringify(jev.requests.at(-1)?.body)).not.toContain("alvo-");
    await from("203.0.113.40").get("/api/health/live").expect(200);

    const banned = (await platform("post", `defense/${event.id}/ban`).expect(201)).body as DefenseEventDto;
    expect(banned).toMatchObject({ action: "banned", active: true });
    await from("203.0.113.40").get("/api/health/live").expect(403);

    const unbanned = (await platform("post", `defense/${event.id}/unban`).expect(201)).body as DefenseEventDto;
    expect(unbanned.active).toBe(false);
    expect(unbanned.unbannedAt).not.toBeNull();
    await from("203.0.113.40").get("/api/health/live").expect(200);
  });
});

describe("defesa da API em DEFENSE_MODE=watch (o padrão)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let superAdmin: { id: string };
  let superToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    superAdmin = await admin.user.create({
      data: {
        name: "Equipe Plataforma",
        email: `defesa-watch-${fx.a.id}@teste.local`,
        passwordHash: await hash(PASSWORD),
        isSuperAdmin: true,
        memberships: { create: { tenantId: fx.a.id, role: "ADMIN" } },
      },
      select: { id: true },
    });
    superToken = await accessTokenFor(app, `defesa-watch-${fx.a.id}@teste.local`, fx.a.id);
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: superAdmin?.id } });
    await fx?.cleanup();
    await app?.close();
  });

  it("só registra o que banaria: o IP segue entrando e a plataforma bane à mão", async () => {
    const from = (path: string) => request(app.getHttpServer()).get(path).set("X-Real-IP", "203.0.113.50");
    const list = async (): Promise<DefenseEventDto[]> =>
      (await request(app.getHttpServer()).get("/api/platform/defense").set("Authorization", `Bearer ${superToken}`).expect(200)).body;

    await from("/.env").expect(404);
    await from("/.git/config").expect(404);
    await vi.waitFor(async () => expect((await list()).filter((event) => event.ip === "203.0.113.50")).toHaveLength(1));
    const [event] = (await list()).filter((item) => item.ip === "203.0.113.50");
    expect(event).toMatchObject({ reason: "sensitive_probe", action: "watched", active: false, bannedUntil: null, analysis: { state: "off" } });
    await from("/api/health/live").expect(200);

    await request(app.getHttpServer()).post(`/api/platform/defense/${event!.id}/ban`).set("Authorization", `Bearer ${superToken}`).expect(201);
    await from("/api/health/live").expect(403);
  });
});
