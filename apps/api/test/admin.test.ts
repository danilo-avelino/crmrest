import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

const PASSWORD = "senha-do-painel-de-filas";

describe("painel das filas (Bull Board)", () => {
  let app: INestApplication;
  let disabled: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ BULL_BOARD_PASSWORD: PASSWORD });
    disabled = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await disabled.close();
  });

  it("não existe sem BULL_BOARD_PASSWORD", async () => {
    await request(disabled.getHttpServer()).get("/api/admin/filas").expect(404);
  });

  it("exige usuário e senha", async () => {
    await request(app.getHttpServer()).get("/api/admin/filas").expect(401).expect("WWW-Authenticate", /Basic/);
    await request(app.getHttpServer()).get("/api/admin/filas").auth("admin", "senha-errada-qualquer").expect(401);
  });

  it("mostra as filas para quem tem a senha", async () => {
    await request(app.getHttpServer()).get("/api/admin/filas").auth("admin", PASSWORD).expect(200);
    const { body } = await request(app.getHttpServer()).get("/api/admin/filas/api/queues").auth("admin", PASSWORD).expect(200);
    const names = (body as { queues: { name: string }[] }).queues.map((queue) => queue.name);
    expect(names.sort()).toEqual(["automations", "cardapio-web", "channels", "ifood", "inbound", "outbound"]);
  });
});
