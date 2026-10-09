import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp, PASSWORD } from "./helpers.js";

describe("painel da plataforma (Super Admin)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let superAdmin: { id: string; email: string }; // membro só de A; C fica para o acesso de suporte
  let superToken: string;
  let userToken: string; // usuário comum: admin em B
  const createdSlugs: string[] = [];
  const createdEmails: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    superAdmin = await admin.user.create({
      data: {
        name: "Equipe Plataforma",
        email: `plataforma-${fx.a.id}@teste.local`,
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
    await admin.auditLog.deleteMany({ where: { tenantId: null, userId: superAdmin?.id } });
    await admin.tenant.deleteMany({ where: { slug: { in: createdSlugs } } });
    await admin.user.deleteMany({ where: { email: { in: createdEmails } } });
    await admin.user.deleteMany({ where: { id: superAdmin?.id } });
    await fx?.cleanup();
    await app?.close();
  });

  const api = (method: "get" | "post" | "patch", path: string, token: string) =>
    request(app.getHttpServer())[method](`/api/platform/${path}`).set("Authorization", `Bearer ${token}`);

  it("só a equipe da plataforma acessa", async () => {
    await api("get", "tenants", userToken).expect(403);
    await api("get", "audit", userToken).expect(403);
    await api("patch", `tenants/${fx.c.id}`, userToken).send({ status: "SUSPENDED" }).expect(403);
    await api("post", "tenants", userToken)
      .send({ name: "Invasor", slug: `invasor-${fx.a.id}`, adminName: "X", adminEmail: "x@teste.local", adminPassword: PASSWORD })
      .expect(403);
    expect(await admin.tenant.count({ where: { slug: `invasor-${fx.a.id}` } })).toBe(0);
  });

  it("lista todos os restaurantes com o uso, inclusive os de que não é membro", async () => {
    const { body } = await api("get", "tenants", superToken).expect(200);
    const c = body.find((t: { id: string }) => t.id === fx.c.id);
    expect(c).toMatchObject({ name: "Teste C", status: "ACTIVE", activeMembers: 0, connectedChannels: 0, messagesLast30Days: 0 });
    expect(body.find((t: { id: string }) => t.id === fx.b.id)).toMatchObject({ activeMembers: 1 });
  });

  it("cria um restaurante com o primeiro administrador, que já consegue entrar", async () => {
    const slug = `novo-${randomUUID()}`;
    const adminEmail = `admin-${slug}@teste.local`;
    createdSlugs.push(slug);
    createdEmails.push(adminEmail);
    const body = { name: "Grupo Teste", slug, adminName: "Dona do Grupo", adminEmail, adminPassword: PASSWORD };

    const { body: list } = await api("post", "tenants", superToken).send(body).expect(201);
    const created = list.find((t: { slug: string }) => t.slug === slug);
    expect(created).toMatchObject({ name: "Grupo Teste", status: "ACTIVE", activeMembers: 1 });
    await accessTokenFor(app, adminEmail, created.id);

    await api("post", "tenants", superToken).send(body).expect(409);
  });

  it("o super admin pode ser o administrador do restaurante que cria", async () => {
    const slug = `proprio-${randomUUID()}`;
    createdSlugs.push(slug);
    const { body: list } = await api("post", "tenants", superToken)
      .send({ name: "Do Próprio Grupo", slug, adminName: "Ignorado", adminEmail: superAdmin.email, adminPassword: PASSWORD })
      .expect(201);
    const created = list.find((t: { slug: string }) => t.slug === slug);
    const member = await admin.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: created.id, userId: superAdmin.id } } });
    expect(member).toMatchObject({ role: "ADMIN", isActive: true });
  });

  it("suspende e reativa: a equipe do restaurante perde e recupera o acesso", async () => {
    await api("patch", `tenants/${fx.b.id}`, superToken).send({ status: "SUSPENDED" }).expect(200);
    const agent = request.agent(app.getHttpServer());
    await agent.post("/api/auth/login").send({ email: fx.user.email, password: PASSWORD }).expect(200);
    await agent.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.b.id }).expect(403);

    await api("patch", `tenants/${fx.b.id}`, superToken).send({ status: "ACTIVE" }).expect(200);
    await agent.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.b.id }).expect(200);
    await api("patch", `tenants/${randomUUID()}`, superToken).send({ status: "ACTIVE" }).expect(404);
  });

  it("acesso de suporte: entra como administrador num restaurante de que não é membro, com auditoria", async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post("/api/auth/login").send({ email: superAdmin.email, password: PASSWORD }).expect(200);
    expect(login.body.user.isSuperAdmin).toBe(true);

    const { body } = await agent.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.c.id }).expect(200);
    expect(body.context).toEqual({ mode: "tenant", support: true, tenants: [{ id: fx.c.id, name: "Teste C", role: "ADMIN" }] });
    await request(app.getHttpServer())
      .get(`/api/settings/${fx.c.id}/members`)
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(200);

    // O refresh mantém o contexto de suporte sem registrar outra entrada.
    const refreshed = await agent.post("/api/auth/refresh").expect(200);
    expect(refreshed.body.context).toMatchObject({ support: true, tenants: [{ id: fx.c.id }] });

    const { body: audit } = await api("get", "audit", superToken).expect(200);
    const entries = audit.filter((e: { action: string; tenantId: string }) => e.action === "tenant.support_access" && e.tenantId === fx.c.id);
    expect(entries).toEqual([expect.objectContaining({ userName: "Equipe Plataforma", tenantName: "Teste C" })]);

    // Usuário comum continua sem acesso a restaurantes de que não é membro.
    const other = request.agent(app.getHttpServer());
    await other.post("/api/auth/login").send({ email: fx.user.email, password: PASSWORD }).expect(200);
    await other.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.c.id }).expect(403);
  });

  it("restaurante suspenso não aceita acesso de suporte", async () => {
    await api("patch", `tenants/${fx.c.id}`, superToken).send({ status: "SUSPENDED" }).expect(200);
    const agent = request.agent(app.getHttpServer());
    await agent.post("/api/auth/login").send({ email: superAdmin.email, password: PASSWORD }).expect(200);
    await agent.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.c.id }).expect(403);
  });
});
