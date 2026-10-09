import { createPrismaClient, withTenants } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp, PASSWORD } from "./helpers.js";

describe("Configurações → usuários do restaurante", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let colleague: { id: string; email: string }; // atendente em A e em B
  let agentToken: string; // o usuário do fixture é atendente em A
  let adminToken: string; // e administrador em B
  const createdEmails: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    colleague = await admin.user.create({
      data: {
        name: "Colega",
        email: `colega-${fx.b.id}@teste.local`,
        passwordHash: await hash(PASSWORD),
        memberships: { create: [{ tenantId: fx.a.id, role: "AGENT" }, { tenantId: fx.b.id, role: "AGENT" }] },
      },
      select: { id: true, email: true },
    });
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { email: { in: createdEmails } } });
    await admin.user.deleteMany({ where: { id: colleague?.id } });
    await fx?.cleanup();
    await app?.close();
  });

  const api = (method: "get" | "patch" | "post", tenantId: string, token: string, userId = "") =>
    request(app.getHttpServer())[method](`/api/settings/${tenantId}/members${userId && `/${userId}`}`).set("Authorization", `Bearer ${token}`);

  it("a equipe vê quem tem acesso ao restaurante", async () => {
    const { body } = await api("get", fx.a.id, agentToken).expect(200);
    expect(body).toEqual([
      { userId: fx.user.id, name: "Atendente Teste", email: fx.user.email, role: "AGENT", isActive: true, isYou: true },
      { userId: colleague.id, name: "Colega", email: colleague.email, role: "AGENT", isActive: true, isYou: false },
    ].sort((x, y) => x.name.localeCompare(y.name)));
    await api("get", fx.c.id, agentToken).expect(403);
  });

  it("admin cria usuários administradores e atendimento pela configuração", async () => {
    const adminEmail = `novo-admin-${fx.b.id}@teste.local`;
    const agentEmail = `novo-atendimento-${fx.b.id}@teste.local`;
    createdEmails.push(adminEmail, agentEmail);

    const withAdmin = await api("post", fx.b.id, adminToken)
      .send({ name: "Nova Admin", email: adminEmail, password: PASSWORD, role: "ADMIN" })
      .expect(201);
    expect(withAdmin.body.find((m: { email: string }) => m.email === adminEmail)).toMatchObject({
      name: "Nova Admin",
      role: "ADMIN",
      isActive: true,
      isYou: false,
    });
    await accessTokenFor(app, adminEmail, fx.b.id);

    const withAgent = await api("post", fx.b.id, adminToken)
      .send({ name: "Novo Atendimento", email: agentEmail, password: PASSWORD, role: "AGENT" })
      .expect(201);
    expect(withAgent.body.find((m: { email: string }) => m.email === agentEmail)).toMatchObject({
      name: "Novo Atendimento",
      role: "AGENT",
      isActive: true,
      isYou: false,
    });
    await accessTokenFor(app, agentEmail, fx.b.id);

    await api("post", fx.a.id, agentToken)
      .send({ name: "Sem Permissão", email: `sem-permissao-${fx.a.id}@teste.local`, password: PASSWORD, role: "AGENT" })
      .expect(403);
  });

  it("admin muda o papel e desativa; quem foi desativado não entra mais no restaurante", async () => {
    const promoted = await api("patch", fx.b.id, adminToken, colleague.id).send({ role: "ADMIN" }).expect(200);
    expect(promoted.body.find((m: { userId: string }) => m.userId === colleague.id)).toMatchObject({ role: "ADMIN" });

    await api("patch", fx.b.id, adminToken, colleague.id).send({ isActive: false }).expect(200);
    await expect(accessTokenFor(app, colleague.email, fx.b.id)).rejects.toThrow();
    await accessTokenFor(app, colleague.email, fx.a.id); // continua em A

    await api("patch", fx.b.id, adminToken, colleague.id).send({ isActive: true, role: "AGENT" }).expect(200);
    await accessTokenFor(app, colleague.email, fx.b.id);
  });

  it("ninguém altera o próprio acesso; atendente e restaurante de fora não alteram", async () => {
    const self = await api("patch", fx.b.id, adminToken, fx.user.id).send({ role: "AGENT" }).expect(403);
    expect(self.body.message).toBe("Peça a outro administrador para alterar o seu acesso.");
    await api("patch", fx.a.id, agentToken, colleague.id).send({ isActive: false }).expect(403);
    await api("patch", fx.c.id, adminToken, colleague.id).send({ isActive: false }).expect(403);
    await api("patch", fx.b.id, adminToken, colleague.id).send({}).expect(400);
  });

  it("no banco, só o administrador ativo altera, e só papel e status", async () => {
    const db = createPrismaClient(process.env.DATABASE_URL ?? "");
    try {
      const asUser = (tenantId: string, data: object) =>
        withTenants(db, { tenantIds: [tenantId], userId: fx.user.id }, (tx) =>
          tx.tenantMember.updateMany({ where: { tenantId, userId: colleague.id }, data }),
        );
      expect(await asUser(fx.a.id, { isActive: false })).toEqual({ count: 0 }); // atendente em A
      expect(await asUser(fx.b.id, { isActive: true })).toEqual({ count: 1 });
      await expect(asUser(fx.b.id, { createdAt: new Date() })).rejects.toThrow(/permission denied/);
      await expect(
        withTenants(db, { tenantIds: [fx.b.id], userId: fx.user.id }, (tx) =>
          tx.tenantMember.create({ data: { tenantId: fx.b.id, userId: colleague.id, role: "ADMIN" } }),
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.$disconnect();
    }
  });
});
