import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthFixture, createTestApp, PASSWORD } from "./helpers.js";

describe("trava do login por e-mail", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;

  const attempt = (email: string, password: string) => request(app.getHttpServer()).post("/api/auth/login").send({ email, password });

  beforeAll(async () => {
    fx = await createAuthFixture();
  });

  // Um app por teste: o limite por IP (10 por minuto, na memória de cada app) não soma as tentativas dos testes.
  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await fx?.cleanup();
  });

  it("o login certo zera as senhas erradas", async () => {
    for (let i = 0; i < 4; i++) await attempt(fx.user.email, "errada").expect(401);
    await attempt(fx.user.email, PASSWORD).expect(200);
    for (let i = 0; i < 4; i++) await attempt(fx.user.email, "errada").expect(401);
    await attempt(fx.user.email, PASSWORD).expect(200);
  });

  it("5 senhas erradas travam o e-mail e recusam até a senha certa", async () => {
    for (let i = 0; i < 5; i++) await attempt(fx.user.email.toUpperCase(), "errada").expect(401);
    const { body } = await attempt(fx.user.email, PASSWORD).expect(429);
    expect(body.message).toBe(
      "Muitas tentativas com este e-mail. Aguarde 15 minutos ou use o “Esqueceu?” para criar uma nova senha.",
    );
  });

  it("e-mail sem conta trava do mesmo jeito: a resposta não revela quais contas existem", async () => {
    for (let i = 0; i < 5; i++) await attempt("ninguem-travado@teste.local", "errada").expect(401);
    const locked = await attempt("ninguem-travado@teste.local", "errada").expect(429);
    expect(locked.body.message).toBe(
      "Muitas tentativas com este e-mail. Aguarde 15 minutos ou use o “Esqueceu?” para criar uma nova senha.",
    );
  });
});
