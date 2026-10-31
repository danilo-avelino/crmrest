import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthFixture, createTestApp, PASSWORD, startMockGraph } from "./helpers.js";

const NEW_PASSWORD = "senha-nova-456";

/** Token no formato do Supabase (só o payload importa: quem valida é o Supabase falso). */
const token = (method: string) =>
  ["e30", Buffer.from(JSON.stringify({ amr: [{ method, timestamp: 1 }] })).toString("base64url"), "assinatura"].join(".");

describe("recuperação de senha pelo Supabase Auth", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let supabase: Awaited<ReturnType<typeof startMockGraph>>;
  // Token que o Supabase falso aceita em GET /user; qualquer outro recebe 401.
  let validToken = "";

  const calls = () => supabase.requests.map((call) => `${call.method} ${call.path}`);
  const login = (password: string) =>
    request(app.getHttpServer()).post("/api/auth/login").send({ email: fx.user.email, password });

  beforeAll(async () => {
    supabase = await startMockGraph();
    supabase.reply((call) => {
      if (call.path === "/auth/v1/user") {
        return call.authorization === `Bearer ${validToken}`
          ? { status: 200, body: { email: fx.user.email } }
          : { status: 401, body: { msg: "invalid JWT" } };
      }
      return { status: 200, body: {} };
    });
    [app, fx] = await Promise.all([
      createTestApp({
        SUPABASE_URL: supabase.url,
        SUPABASE_SECRET_KEY: "sb_secret_teste",
        WEB_ORIGIN: "https://painel.teste",
        TRUST_PROXY_HOPS: "1",
      }),
      createAuthFixture(),
    ]);
  });

  beforeEach(() => {
    supabase.requests.length = 0;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await supabase?.close();
  });

  it("manda o link para o e-mail cadastrado, com o retorno na página de redefinição", async () => {
    await request(app.getHttpServer()).post("/api/auth/forgot-password").send({ email: fx.user.email.toUpperCase() }).expect(204);
    await vi.waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()).toEqual([
      "POST /auth/v1/admin/users",
      `POST /auth/v1/recover?redirect_to=${encodeURIComponent("https://painel.teste/redefinir-senha")}`,
    ]);
    expect(supabase.requests[0]!.body).toEqual({ email: fx.user.email, email_confirm: true });
    expect(supabase.requests[1]!.body).toEqual({ email: fx.user.email });
  });

  it("responde igual para e-mail sem conta, sem chamar o Supabase", async () => {
    await request(app.getHttpServer()).post("/api/auth/forgot-password").send({ email: "ninguem@teste.local" }).expect(204);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls()).toEqual([]);
  });

  it("recusa token que o Supabase não reconhece (expirado ou já usado)", async () => {
    validToken = token("otp");
    const { body } = await request(app.getHttpServer())
      .post("/api/auth/reset-password")
      .send({ accessToken: token("recovery"), password: NEW_PASSWORD })
      .expect(400);
    expect(body.message).toBe("Este link expirou ou já foi usado. Peça um novo na tela de login.");
    await login(PASSWORD).expect(200);
  });

  it("troca a senha, encerra as sessões abertas e o token do link", async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post("/api/auth/login").send({ email: fx.user.email, password: PASSWORD }).expect(200);

    // O link do e-mail emite o token como "otp": vale do mesmo jeito.
    validToken = token("otp");
    await request(app.getHttpServer())
      .post("/api/auth/reset-password")
      .send({ accessToken: validToken, password: NEW_PASSWORD })
      .expect(204);

    expect(calls()).toEqual(["GET /auth/v1/user", "POST /auth/v1/logout"]);
    await agent.post("/api/auth/refresh").expect(401);
    await login(PASSWORD).expect(401);
    await login(NEW_PASSWORD).expect(200);
  });

  it("a senha nova libera o e-mail travado por senhas erradas", async () => {
    // Um IP por tentativa: o limite por IP fica de fora.
    const from = (ip: string) => request(app.getHttpServer()).post("/api/auth/login").set("X-Forwarded-For", ip);
    for (let i = 0; i < 5; i++) await from(`198.51.100.${i}`).send({ email: fx.user.email, password: "errada" }).expect(401);
    await from("198.51.100.5").send({ email: fx.user.email, password: NEW_PASSWORD }).expect(429);

    validToken = token("recovery");
    await request(app.getHttpServer())
      .post("/api/auth/reset-password")
      .send({ accessToken: validToken, password: PASSWORD })
      .expect(204);
    await from("198.51.100.6").send({ email: fx.user.email, password: PASSWORD }).expect(200);
  });

  it("sem o Supabase configurado, responde 503", async () => {
    const bare = await createTestApp();
    try {
      await request(bare.getHttpServer()).post("/api/auth/forgot-password").send({ email: fx.user.email }).expect(503);
    } finally {
      await bare.close();
    }
  });
});
