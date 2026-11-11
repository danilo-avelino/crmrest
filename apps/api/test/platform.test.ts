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

  it("gastos com IA: o total do mês, cada provedor e os restaurantes de quem gastou mais; o mês vazio vem zerado", async () => {
    await api("get", "ai-usage", userToken).expect(403);
    await api("get", "ai-usage?month=2026-13", superToken).expect(422);
    // 31/10 às 23h em Brasília ainda é outubro; 01/11 às 00h30 já é novembro.
    await admin.aiUsage.createMany({
      data: [
        { tenantId: fx.b.id, provider: "CLAUDE", model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 200, costMicroUsd: 200, createdAt: new Date("2026-10-31T23:00:00-03:00") },
        { tenantId: fx.b.id, provider: "JEV", model: "typesafe/jev-1.14", inputTokens: 2000, outputTokens: 10, costMicroUsd: 84, createdAt: new Date("2026-10-31T22:00:00-03:00") },
        { tenantId: fx.b.id, provider: "LOCAL", model: "gemma4:12b", inputTokens: 5000, outputTokens: 300, costMicroUsd: 0, createdAt: new Date("2026-10-20T12:00:00-03:00") },
        { tenantId: fx.c.id, provider: "CLAUDE", model: "claude-haiku-5-5", inputTokens: 3000, outputTokens: 600, costMicroUsd: 600, createdAt: new Date("2026-10-05T12:00:00-03:00") },
        { tenantId: fx.c.id, provider: "CLAUDE", model: "claude-haiku-5-5", inputTokens: 3000, outputTokens: 600, costMicroUsd: 600, createdAt: new Date("2026-10-06T12:00:00-03:00") },
        { tenantId: fx.b.id, provider: "CLAUDE", model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 200, costMicroUsd: 200, createdAt: new Date("2026-11-01T00:30:00-03:00") },
        // Ontem: entra na previsão dos próximos 30 dias (a média dos últimos 14 × 30).
        { tenantId: fx.b.id, provider: "CLAUDE", model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 200, costMicroUsd: 1400, createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      ],
    });
    // A defesa da API: sem restaurante, na linha da plataforma.
    await admin.platformAiUsage.create({
      data: { provider: "JEV", model: "typesafe/jev-1.14", inputTokens: 900, outputTokens: 5, costMicroUsd: 38, createdAt: new Date("1998-12-15T12:00:00-03:00") },
    });
    const db = createPrismaClient(process.env.DATABASE_URL ?? "");
    try {
      const { body } = await api("get", "ai-usage?month=2026-10", superToken).expect(200);
      const ours = body.tenants.filter((t: { tenantId: string }) => [fx.b.id, fx.c.id].includes(t.tenantId));
      expect(ours).toEqual([
        {
          tenantId: fx.c.id,
          tenantName: "Teste C",
          calls: 2,
          inputTokens: 6000,
          outputTokens: 1200,
          costUsd: 0.0012,
          providers: { CLAUDE: { calls: 2, inputTokens: 6000, outputTokens: 1200, costUsd: 0.0012 } },
        },
        {
          tenantId: fx.b.id,
          tenantName: "Teste B",
          calls: 3,
          inputTokens: 8000,
          outputTokens: 510,
          costUsd: 0.000284,
          providers: {
            CLAUDE: { calls: 1, inputTokens: 1000, outputTokens: 200, costUsd: 0.0002 },
            JEV: { calls: 1, inputTokens: 2000, outputTokens: 10, costUsd: 0.000084 },
            LOCAL: { calls: 1, inputTokens: 5000, outputTokens: 300, costUsd: 0 },
          },
        },
      ]);
      expect(body.month).toBe("2026-10");
      // Dia a dia, do dia 1 ao 31; 31/10 às 23h em Brasília fica no dia 31.
      expect(body.days).toHaveLength(31);
      expect(body.days[0].date).toBe("2026-10-01");
      const last = body.days[30];
      expect(last.date).toBe("2026-10-31");
      expect(last.providers.CLAUDE.costUsd).toBeGreaterThanOrEqual(0.0002);
      expect(last.providers.JEV.costUsd).toBeGreaterThanOrEqual(0.000084);
      expect(body.days[4].providers.CLAUDE.calls).toBeGreaterThanOrEqual(1);
      // Por modelo.
      const haiku = body.models.find((m: { model: string }) => m.model === "claude-haiku-5-5");
      expect(haiku).toMatchObject({ provider: "CLAUDE" });
      expect(haiku.calls).toBeGreaterThanOrEqual(3);
      expect(body.models.find((m: { model: string }) => m.model === "typesafe/jev-1.14")).toMatchObject({ provider: "JEV" });
      // A previsão: 1400 milionésimos ontem → 1400 × 30 / 14 = 3000.
      expect(body.forecast.basisDays).toBe(14);
      expect(body.forecast.providers.CLAUDE).toBeGreaterThanOrEqual(0.003);
      expect(body.forecast.costUsd).toBeGreaterThanOrEqual(body.forecast.providers.CLAUDE);
      expect(body.costUsd).toBeGreaterThanOrEqual(0.001484);
      expect(body.providers.JEV.calls).toBeGreaterThanOrEqual(1);
      expect(body.providers.LOCAL.inputTokens).toBeGreaterThanOrEqual(5000);
      // O mês vazio vem zerado.
      const { body: empty } = await api("get", "ai-usage?month=1999-01", superToken).expect(200);
      const none = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      const providers = { CLAUDE: none, JEV: none, LOCAL: none };
      expect(empty).toMatchObject({ month: "1999-01", ...none, providers, models: [], tenants: [] });
      expect(empty.days).toHaveLength(31);
      expect(empty.days.every((day: { providers: unknown }) => JSON.stringify(day.providers) === JSON.stringify(providers))).toBe(true);
      // O Jev da defesa vem na linha da plataforma, que nenhum restaurante lê.
      const { body: platform } = await api("get", "ai-usage?month=1998-12", superToken).expect(200);
      expect(platform.tenants).toEqual([
        {
          tenantId: null,
          tenantName: "Plataforma (defesa da API)",
          calls: 1,
          inputTokens: 900,
          outputTokens: 5,
          costUsd: 0.000038,
          providers: { JEV: { calls: 1, inputTokens: 900, outputTokens: 5, costUsd: 0.000038 } },
        },
      ]);
      expect(await withTenants(db, { tenantIds: [fx.b.id], userId: fx.user.id }, (tx) => tx.platformAiUsage.count())).toBe(0);
    } finally {
      await db.$disconnect();
      await admin.aiUsage.deleteMany({ where: { tenantId: { in: [fx.b.id, fx.c.id] } } });
      await admin.platformAiUsage.deleteMany({ where: { createdAt: { lt: new Date("1999-01-01") } } });
    }
  });

  // Um app só para os logins destes testes: o limite por IP (10 por minuto, na memória de cada app) já foi gasto acima.
  describe("usuário adicionado pela plataforma", () => {
    let loginApp: INestApplication;
    beforeAll(async () => {
      loginApp = await createTestApp();
    });
    afterAll(async () => {
      await loginApp?.close();
    });

    it("adiciona um usuário nos restaurantes escolhidos, já com acesso e sem convite, com auditoria", async () => {
      const email = `nova-${fx.a.id}@teste.local`;
      createdEmails.push(email);
      const body = { name: "Nova Pessoa", email, password: PASSWORD, role: "AGENT", tenantIds: [fx.a.id, fx.b.id] };
      await api("post", "members", userToken).send(body).expect(403);
      expect(await admin.user.count({ where: { email } })).toBe(0);

      await api("post", "members", superToken).send(body).expect(201);
      const memberships = await admin.tenantMember.findMany({ where: { user: { email } }, orderBy: { tenantId: "asc" } });
      expect(memberships.map((m) => m.tenantId).sort()).toEqual([fx.a.id, fx.b.id].sort());
      for (const m of memberships) expect(m).toMatchObject({ role: "AGENT", isActive: true, invitePending: false });
      await accessTokenFor(loginApp, email, fx.a.id);
      await accessTokenFor(loginApp, email, fx.b.id);

      const { body: audit } = await api("get", "audit", superToken).expect(200);
      const entries = audit.filter((e: { action: string; data: { email?: string } }) => e.action === "tenant.member_add" && e.data?.email === email);
      expect(entries.map((e: { tenantId: string }) => e.tenantId).sort()).toEqual([fx.a.id, fx.b.id].sort());
    });

    it("conta que já existia, com convite pendente: ganha o acesso na hora e mantém a senha atual", async () => {
      const existing = await admin.user.create({
        data: {
          name: "Conta Antiga",
          email: `antiga-${fx.a.id}@teste.local`,
          passwordHash: await hash(PASSWORD),
          memberships: { create: { tenantId: fx.b.id, role: "ADMIN", isActive: false, invitePending: true } },
        },
        select: { id: true, email: true },
      });
      createdEmails.push(existing.email);
      await api("post", "members", superToken)
        .send({ name: "Ignorado", email: existing.email, password: "outra-senha-123", role: "ADMIN", tenantIds: [fx.a.id, fx.b.id] })
        .expect(201);
      const memberships = await admin.tenantMember.findMany({ where: { userId: existing.id } });
      expect(memberships).toHaveLength(2);
      for (const m of memberships) expect(m).toMatchObject({ role: "ADMIN", isActive: true, invitePending: false });
      await accessTokenFor(loginApp, existing.email, fx.b.id); // com a senha de antes
      await request(loginApp.getHttpServer()).post("/api/auth/login").send({ email: existing.email, password: "outra-senha-123" }).expect(401);
    });

    it("sem senha, a conta nova não tem senha conhecida; restaurante inexistente não cria nada", async () => {
      const email = `sem-senha-${fx.a.id}@teste.local`;
      createdEmails.push(email);
      await api("post", "members", superToken)
        .send({ name: "Sem Senha", email, role: "AGENT", tenantIds: [fx.a.id, randomUUID()] })
        .expect(404);
      expect(await admin.user.count({ where: { email } })).toBe(0);

      await api("post", "members", superToken).send({ name: "Sem Senha", email, role: "AGENT", tenantIds: [] }).expect(400);
      await api("post", "members", superToken).send({ name: "Sem Senha", email, role: "AGENT", tenantIds: [fx.a.id] }).expect(201);
      expect(await admin.tenantMember.findFirst({ where: { tenantId: fx.a.id, user: { email } } })).toMatchObject({ isActive: true });
      await request(loginApp.getHttpServer()).post("/api/auth/login").send({ email, password: PASSWORD }).expect(401);
    });
  });
});
