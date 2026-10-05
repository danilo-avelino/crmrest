import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

describe("Configurações → respostas rápidas", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let agentToken: string; // atendente em A
  let adminToken: string; // administrador em B

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const api = (method: "post" | "patch" | "delete", tenantId: string, token: string, id = "") =>
    request(app.getHttpServer())
      [method](`/api/settings/${tenantId}/quick-replies${id && `/${id}`}`)
      .set("Authorization", `Bearer ${token}`);
  const list = async (token: string) =>
    (await request(app.getHttpServer()).get("/api/quick-replies").set("Authorization", `Bearer ${token}`).expect(200)).body;

  it("admin cria, edita e apaga; o atalho vale sem a barra e sem maiúsculas", async () => {
    const { body: created } = await api("post", fx.b.id, adminToken)
      .send({ shortcut: "/Atraso", content: "Já estamos verificando seu pedido." })
      .expect(201);
    expect(created).toMatchObject({ tenantId: fx.b.id, shortcut: "atraso", content: "Já estamos verificando seu pedido." });

    const { body: updated } = await api("patch", fx.b.id, adminToken, created.id)
      .send({ shortcut: "atraso", content: "Seu pedido já saiu!" })
      .expect(200);
    expect(updated.content).toBe("Seu pedido já saiu!");
    expect(await list(adminToken)).toEqual([updated]);

    await api("delete", fx.b.id, adminToken, created.id).expect(204);
    expect(await list(adminToken)).toEqual([]);
  });

  it("recusa atalho repetido, com espaço ou resposta vazia", async () => {
    await api("post", fx.b.id, adminToken).send({ shortcut: "pix", content: "Nossa chave Pix é o CNPJ." }).expect(201);
    const repeated = await api("post", fx.b.id, adminToken).send({ shortcut: "PIX", content: "Outra" }).expect(409);
    expect(repeated.body.message).toBe("Já existe uma resposta com o atalho /pix.");
    await api("post", fx.b.id, adminToken).send({ shortcut: "dois termos", content: "x" }).expect(400);
    await api("post", fx.b.id, adminToken).send({ shortcut: "vazio", content: "  " }).expect(400);
  });

  it("atendente e restaurante de fora não alteram", async () => {
    await api("post", fx.a.id, agentToken).send({ shortcut: "oi", content: "Olá!" }).expect(403);
    await api("post", fx.c.id, adminToken).send({ shortcut: "oi", content: "Olá!" }).expect(403);
    const other = await admin.quickReply.create({ data: { tenantId: fx.a.id, shortcut: "de-a", content: "A" } });
    await api("delete", fx.b.id, adminToken, other.id).expect(404); // id de outro restaurante pela rota de B
    expect(await admin.quickReply.findUnique({ where: { id: other.id } })).not.toBeNull();
  });
});
