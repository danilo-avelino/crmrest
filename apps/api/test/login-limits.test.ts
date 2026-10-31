import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthFixture, createTestApp, PASSWORD } from "./helpers.js";

describe("limites de tentativas no login", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;

  // Cada chamada vem de um IP novo, para o limite por IP não se misturar com a trava por e-mail.
  let lastIp = 0;
  const from = (ip = `203.0.113.${++lastIp}`) => request(app.getHttpServer()).post("/api/auth/login").set("X-Forwarded-For", ip);
  const wrong = (email: string) => from().send({ email, password: "errada" });

  beforeAll(async () => {
    // Como na Railway: a borda dela põe o IP do visitante no X-Forwarded-For.
    [app, fx] = await Promise.all([createTestApp({ TRUST_PROXY_HOPS: "1" }), createAuthFixture()]);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("o limite por IP vale para cada visitante, não para todos somados", async () => {
    for (let i = 0; i < 10; i++) {
      await from("198.51.100.1").send({ email: `ip-${i}@teste.local`, password: "errada" }).expect(401);
    }
    const { body } = await from("198.51.100.1").send({ email: "ip-10@teste.local", password: "errada" }).expect(429);
    expect(body.message).toBe("Muitas tentativas. Aguarde alguns minutos e tente de novo.");
    await from("198.51.100.2").send({ email: "ip-11@teste.local", password: "errada" }).expect(401);
  });

  it("o login certo zera as senhas erradas", async () => {
    for (let i = 0; i < 4; i++) await wrong(fx.user.email).expect(401);
    await from().send({ email: fx.user.email, password: PASSWORD }).expect(200);
    for (let i = 0; i < 4; i++) await wrong(fx.user.email).expect(401);
    await from().send({ email: fx.user.email, password: PASSWORD }).expect(200);
  });

  it("5 senhas erradas, mesmo de IPs diferentes, travam o e-mail e recusam até a senha certa", async () => {
    for (let i = 0; i < 5; i++) await wrong(fx.user.email.toUpperCase()).expect(401);
    const { body } = await from().send({ email: fx.user.email, password: PASSWORD }).expect(429);
    expect(body.message).toBe(
      "Muitas tentativas com este e-mail. Aguarde 15 minutos ou use o “Esqueceu?” para criar uma nova senha.",
    );
  });

  it("e-mail sem conta trava do mesmo jeito: a resposta não revela quais contas existem", async () => {
    for (let i = 0; i < 5; i++) await wrong("ninguem-travado@teste.local").expect(401);
    const locked = await wrong("ninguem-travado@teste.local").expect(429);
    const real = await from().send({ email: fx.user.email, password: PASSWORD }).expect(429);
    expect(locked.body.message).toBe(real.body.message);
  });
});
