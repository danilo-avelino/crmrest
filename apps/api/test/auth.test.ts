import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthFixture, createTestApp, PASSWORD } from "./helpers.js";

describe("autenticação", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;

  beforeAll(async () => {
    [app, fx] = await Promise.all([createTestApp(), createAuthFixture()]);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const login = (agent: ReturnType<typeof request.agent>) =>
    agent.post("/api/auth/login").send({ email: fx.user.email.toUpperCase(), password: PASSWORD }).expect(200);

  it("recusa senha errada e e-mail inexistente com a mesma resposta", async () => {
    const wrong = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: fx.user.email, password: "errada" })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "ninguem@teste.local", password: "errada" })
      .expect(401);
    expect(wrong.body.message).toBe("E-mail ou senha inválidos.");
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it("login cria a sessão em cookie httpOnly e lista os restaurantes, ainda sem access token", async () => {
    const response = await login(request.agent(app.getHttpServer()));
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toMatch(/dishdesk_session=.+; Max-Age=\d+; Path=\/api\/auth; .*HttpOnly/);
    expect(response.body.accessToken).toBeNull();
    expect(response.body.context).toBeNull();
    const roles = Object.fromEntries(response.body.tenants.map((t: { id: string; role: string }) => [t.id, t.role]));
    expect(roles).toEqual({ [fx.a.id]: "AGENT", [fx.b.id]: "ADMIN" });
  });

  it("rota protegida exige access token", async () => {
    await request(app.getHttpServer()).get("/api/auth/me").expect(401);
    await request(app.getHttpServer()).get("/api/auth/me").set("Authorization", "Bearer invalido").expect(401);
  });

  it("escolher um restaurante emite token só para ele", async () => {
    const agent = request.agent(app.getHttpServer());
    await login(agent);
    const { body } = await agent.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.a.id }).expect(200);
    expect(body.context).toMatchObject({ mode: "tenant", tenants: [{ id: fx.a.id, role: "AGENT" }] });

    const me = await agent.get("/api/auth/me").set("Authorization", `Bearer ${body.accessToken}`).expect(200);
    expect(me.body).toEqual({ userId: fx.user.id, mode: "tenant", tenants: [{ id: fx.a.id, role: "AGENT" }] });
  });

  it("painel master emite token para todos os restaurantes do usuário e nenhum outro", async () => {
    const agent = request.agent(app.getHttpServer());
    await login(agent);
    const { body } = await agent.post("/api/auth/context").send({ mode: "master" }).expect(200);
    const me = await agent.get("/api/auth/me").set("Authorization", `Bearer ${body.accessToken}`).expect(200);
    expect(me.body.mode).toBe("master");
    expect(me.body.tenants.map((t: { id: string }) => t.id).sort()).toEqual([fx.a.id, fx.b.id].sort());
  });

  it("não emite token para restaurante sem vínculo nem sem sessão", async () => {
    const agent = request.agent(app.getHttpServer());
    await login(agent);
    await agent.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.c.id }).expect(403);
    await request(app.getHttpServer()).post("/api/auth/context").send({ mode: "master" }).expect(401);
  });

  it("refresh devolve o contexto salvo; logout encerra a sessão", async () => {
    const agent = request.agent(app.getHttpServer());
    await login(agent);
    await agent.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.b.id }).expect(200);

    const refreshed = await agent.post("/api/auth/refresh").expect(200);
    expect(refreshed.body.context).toMatchObject({ mode: "tenant", tenants: [{ id: fx.b.id, role: "ADMIN" }] });
    expect(typeof refreshed.body.accessToken).toBe("string");

    await agent.post("/api/auth/logout").expect(204);
    await agent.post("/api/auth/refresh").expect(401);
  });
});
