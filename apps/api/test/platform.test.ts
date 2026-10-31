import { randomUUID } from "node:crypto";
import { createPrismaClient, withTenants } from "@dishdesk/database";
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

  const api = (method: "get" | "post" | "patch" | "put", path: string, token: string) =>
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

  it("liga e desliga módulos, com auditoria; o restaurante não liga sozinho", async () => {
    const on = await api("put", `tenants/${fx.b.id}/modules/CAMPAIGNS`, superToken).send({ enabled: true }).expect(200);
    expect(on.body.find((t: { id: string }) => t.id === fx.b.id).modules).toEqual(["CAMPAIGNS"]);
    await api("put", `tenants/${fx.b.id}/modules/CAMPAIGNS`, superToken).send({ enabled: true }).expect(200); // já ligado

    await api("put", `tenants/${fx.b.id}/modules/CAMPAIGNS`, userToken).send({ enabled: false }).expect(403);
    await api("put", `tenants/${fx.b.id}/modules/INEXISTENTE`, superToken).send({ enabled: true }).expect(404);
    const db = createPrismaClient(process.env.DATABASE_URL ?? "");
    try {
      // O administrador de B vê os módulos de B, mas não grava (só a plataforma, por app.set_tenant_module).
      const asAdmin = <T>(fn: Parameters<typeof withTenants<T>>[2]) => withTenants(db, { tenantIds: [fx.b.id], userId: fx.user.id }, fn);
      expect(await asAdmin((tx) => tx.tenantModule.count())).toBe(1);
      await expect(asAdmin((tx) => tx.tenantModule.deleteMany({}))).rejects.toThrow(/permission denied/);
      await expect(asAdmin((tx) => tx.$executeRaw`SELECT app.set_tenant_module(${fx.b.id}::uuid, 'CAMPAIGNS', false)`)).rejects.toThrow(
        /Só a equipe da plataforma/,
      );
    } finally {
      await db.$disconnect();
    }

    const off = await api("put", `tenants/${fx.b.id}/modules/CAMPAIGNS`, superToken).send({ enabled: false }).expect(200);
    expect(off.body.find((t: { id: string }) => t.id === fx.b.id).modules).toEqual([]);
    const { body: audit } = await api("get", "audit", superToken).expect(200);
    const entries = audit.filter((e: { tenantId: string; action: string }) => e.tenantId === fx.b.id && e.action.startsWith("tenant.module"));
    expect(entries.map((e: { action: string; data: unknown }) => [e.action, e.data])).toEqual([
      ["tenant.module_off", { module: "CAMPAIGNS" }],
      ["tenant.module_on", { module: "CAMPAIGNS" }],
    ]);
  });

  it("libera o acesso até uma data a quem se cadastrou pelo site, e o restaurante bloqueado volta a entrar", async () => {
    // B como cadastro do site com o teste grátis vencido: bloqueado até pagar.
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await admin.tenant.update({ where: { id: fx.b.id }, data: { trialEndsAt: past, trustUntil: past } });
    await expect(accessTokenFor(app, fx.user.email, fx.b.id)).rejects.toThrow();

    const until = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { body } = await api("patch", `tenants/${fx.b.id}/access`, superToken).send({ plan: "ANNUAL", paidUntil: until }).expect(200);
    expect(body.find((t: { id: string }) => t.id === fx.b.id)).toMatchObject({
      billingPlan: "ANNUAL",
      paidUntil: new Date(`${until}T23:59:59.999-03:00`).toISOString(),
    });
    expect((await admin.tenant.findUniqueOrThrow({ where: { id: fx.b.id } })).trustUntil).toBeNull(); // a confiança volta a valer
    await accessTokenFor(app, fx.user.email, fx.b.id);

    const { body: audit } = await api("get", "audit", superToken).expect(200);
    const grant = audit.find((e: { tenantId: string; action: string }) => e.tenantId === fx.b.id && e.action === "tenant.access_grant");
    expect(grant.data.plan).toBe("ANNUAL");
    expect(new Date(grant.data.paidUntil).toISOString()).toBe(new Date(`${until}T23:59:59.999-03:00`).toISOString());

    await api("patch", `tenants/${fx.b.id}/access`, superToken).send({ plan: "MONTHLY", paidUntil: "2020-01-01" }).expect(422);
    const free = await api("patch", `tenants/${fx.c.id}/access`, superToken).send({ plan: "MONTHLY", paidUntil: until }).expect(422);
    expect(free.body.message).toBe("Este restaurante não tem cobrança pelo sistema.");
    await api("patch", `tenants/${fx.b.id}/access`, userToken).send({ plan: "MONTHLY", paidUntil: until }).expect(403);
  });

  it("gastos com o Claude: o total do mês e os restaurantes de quem gastou mais; o mês vazio vem zerado", async () => {
    await api("get", "ai-usage", userToken).expect(403);
    await api("get", "ai-usage?month=2026-13", superToken).expect(422);
    // 31/10 às 23h em Brasília ainda é outubro; 01/11 às 00h30 já é novembro.
    await admin.aiUsage.createMany({
      data: [
        { tenantId: fx.b.id, model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 200, costMicroUsd: 200, createdAt: new Date("2026-10-31T23:00:00-03:00") },
        { tenantId: fx.c.id, model: "claude-haiku-5-5", inputTokens: 3000, outputTokens: 600, costMicroUsd: 600, createdAt: new Date("2026-10-05T12:00:00-03:00") },
        { tenantId: fx.c.id, model: "claude-haiku-5-5", inputTokens: 3000, outputTokens: 600, costMicroUsd: 600, createdAt: new Date("2026-10-06T12:00:00-03:00") },
        { tenantId: fx.b.id, model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 200, costMicroUsd: 200, createdAt: new Date("2026-11-01T00:30:00-03:00") },
      ],
    });
    try {
      const { body } = await api("get", "ai-usage?month=2026-10", superToken).expect(200);
      const ours = body.tenants.filter((t: { tenantId: string }) => [fx.b.id, fx.c.id].includes(t.tenantId));
      expect(ours).toEqual([
        { tenantId: fx.c.id, tenantName: "Teste C", calls: 2, inputTokens: 6000, outputTokens: 1200, costUsd: 0.0012 },
        { tenantId: fx.b.id, tenantName: "Teste B", calls: 1, inputTokens: 1000, outputTokens: 200, costUsd: 0.0002 },
      ]);
      expect(body.month).toBe("2026-10");
      expect(body.costUsd).toBeGreaterThanOrEqual(0.0014);
      const { body: empty } = await api("get", "ai-usage?month=1999-01", superToken).expect(200);
      expect(empty).toEqual({ month: "1999-01", costUsd: 0, calls: 0, tenants: [] });
    } finally {
      await admin.aiUsage.deleteMany({ where: { tenantId: { in: [fx.b.id, fx.c.id] } } });
    }
  });
});
