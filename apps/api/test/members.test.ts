import { createPrismaClient, withTenants } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp, PASSWORD, startMockGraph } from "./helpers.js";

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
      { userId: fx.user.id, name: "Atendente Teste", email: fx.user.email, role: "AGENT", isActive: true, invitePending: false, isYou: true },
      { userId: colleague.id, name: "Colega", email: colleague.email, role: "AGENT", isActive: true, invitePending: false, isYou: false },
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

describe("Configurações → usuários: convite por e-mail", () => {
  let app: INestApplication;
  let noSupabase: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let supabase: Awaited<ReturnType<typeof startMockGraph>>;
  let adminToken: string; // o usuário do fixture é administrador em B
  let agentToken: string; // e atendente em A
  let inviteStatus = 200;
  let linkEmail = ""; // dono do token que o link do e-mail entrega (GET /auth/v1/user)
  const createdEmails: string[] = [];
  const calls = () => supabase.requests.map((call) => `${call.method} ${call.path}`);
  const redirect = encodeURIComponent("https://painel.teste/redefinir-senha");

  beforeAll(async () => {
    supabase = await startMockGraph();
    // Supabase falso: o convite responde inviteStatus (422 = o e-mail já tem cópia no Supabase).
    supabase.reply((call) =>
      call.path.startsWith("/auth/v1/invite")
        ? { status: inviteStatus, body: {} }
        : call.path === "/auth/v1/user"
          ? { status: 200, body: { email: linkEmail } }
          : { status: 200, body: {} },
    );
    [app, noSupabase, fx] = await Promise.all([
      createTestApp({ SUPABASE_URL: supabase.url, SUPABASE_SECRET_KEY: "sb_secret_teste", WEB_ORIGIN: "https://painel.teste" }),
      createTestApp(), // sem SUPABASE_URL e SUPABASE_SECRET_KEY (o .env de teste e o CI não têm)
      createAuthFixture(),
    ]);
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
  });

  beforeEach(() => {
    supabase.requests.length = 0;
    inviteStatus = 200;
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { email: { in: createdEmails } } });
    await fx?.cleanup();
    await Promise.all([app?.close(), noSupabase?.close()]);
    await supabase?.close();
  });

  const create = (body: object, server = app) =>
    request(server.getHttpServer()).post(`/api/settings/${fx.b.id}/members`).set("Authorization", `Bearer ${adminToken}`).send(body);

  it("sem senha: cria a conta sem senha conhecida e manda o convite com o retorno em /redefinir-senha", async () => {
    const email = `convidada-${fx.b.id}@teste.local`;
    createdEmails.push(email);
    const { body } = await create({ name: "Convidada", email, role: "AGENT" }).expect(201);
    expect(body.find((m: { email: string }) => m.email === email)).toMatchObject({ name: "Convidada", role: "AGENT", isActive: true });
    expect(calls()).toEqual([`POST /auth/v1/invite?redirect_to=${redirect}`]);
    expect(supabase.requests[0]!.body).toEqual({ email });
    // Ninguém entra antes de criar a senha pelo link.
    await request(app.getHttpServer()).post("/api/auth/login").send({ email, password: PASSWORD }).expect(401);
  });

  it("e-mail que já tem cópia no Supabase: vai o link de recuperação no lugar do convite", async () => {
    const email = `ja-no-supabase-${fx.b.id}@teste.local`;
    createdEmails.push(email);
    inviteStatus = 422;
    await create({ name: "Já no Supabase", email, role: "AGENT" }).expect(201);
    expect(calls()).toEqual([
      `POST /auth/v1/invite?redirect_to=${redirect}`,
      "POST /auth/v1/admin/users",
      `POST /auth/v1/recover?redirect_to=${redirect}`,
    ]);
  });

  it("quem já tem conta no Dish Desk recebe o convite e só entra depois de abrir o link do e-mail", async () => {
    // A conta pode ter sido criada por outra pessoa: o cadastro não confere o e-mail.
    const colleague = await admin.user.create({
      data: { name: "Colega Antigo", email: `antigo-${fx.b.id}@teste.local`, passwordHash: await hash(PASSWORD) },
      select: { id: true, email: true },
    });
    createdEmails.push(colleague.email);
    const { body } = await create({ name: "Colega Antigo", email: colleague.email, role: "ADMIN", password: "outra-senha-123" }).expect(201);
    expect(body.find((m: { email: string }) => m.email === colleague.email)).toMatchObject({ isActive: false, invitePending: true });
    expect(calls()).toEqual([`POST /auth/v1/invite?redirect_to=${redirect}`]);

    // Com a senha da conta, entra, mas não no restaurante; a senha que o admin digitou não vale.
    const agent = request.agent(app.getHttpServer());
    await agent.post("/api/auth/login").send({ email: colleague.email, password: PASSWORD }).expect(200);
    await agent.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.b.id }).expect(403);
    await request(app.getHttpServer()).post("/api/auth/login").send({ email: colleague.email, password: "outra-senha-123" }).expect(401);

    // O admin não libera no lugar dela; adicionar de novo não libera.
    const patch = (data: object) =>
      request(app.getHttpServer()).patch(`/api/settings/${fx.b.id}/members/${colleague.id}`).set("Authorization", `Bearer ${adminToken}`).send(data);
    expect((await patch({ isActive: true }).expect(422)).body.message).toBe(
      'Esta pessoa ainda não aceitou o convite. Use "Enviar convite" para mandar o e-mail de novo.',
    );
    const db = createPrismaClient(process.env.DATABASE_URL ?? "");
    try {
      // Nem direto no banco.
      await expect(
        withTenants(db, { tenantIds: [fx.b.id], userId: fx.user.id }, (tx) =>
          tx.tenantMember.updateMany({ where: { tenantId: fx.b.id, userId: colleague.id }, data: { isActive: true } }),
        ),
      ).rejects.toThrow(/não aceitou o convite/);
    } finally {
      await db.$disconnect();
    }
    await create({ name: "Colega Antigo", email: colleague.email, role: "AGENT" }).expect(201);
    expect(await admin.tenantMember.findFirst({ where: { tenantId: fx.b.id, userId: colleague.id } })).toMatchObject({
      role: "AGENT",
      isActive: false,
      invitePending: true,
    });

    // O link do e-mail prova que ela é a dona: troca a senha e libera o acesso.
    linkEmail = colleague.email;
    await request(app.getHttpServer()).post("/api/auth/reset-password").send({ accessToken: "token-do-link", password: "senha-nova-123" }).expect(204);
    expect(await admin.tenantMember.findFirst({ where: { tenantId: fx.b.id, userId: colleague.id } })).toMatchObject({
      isActive: true,
      invitePending: false,
    });
    const login = request.agent(app.getHttpServer());
    await login.post("/api/auth/login").send({ email: colleague.email, password: "senha-nova-123" }).expect(200);
    await login.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.b.id }).expect(200);
  });

  it("convite pendente cancelado: o link do e-mail não libera mais o acesso", async () => {
    const colleague = await admin.user.create({
      data: { name: "Colega Cancelado", email: `cancelado-${fx.b.id}@teste.local`, passwordHash: await hash(PASSWORD) },
      select: { id: true, email: true },
    });
    createdEmails.push(colleague.email);
    await create({ name: "Colega Cancelado", email: colleague.email, role: "AGENT" }).expect(201);
    const { body } = await request(app.getHttpServer())
      .patch(`/api/settings/${fx.b.id}/members/${colleague.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isActive: false })
      .expect(200);
    expect(body.find((m: { email: string }) => m.email === colleague.email)).toMatchObject({ isActive: false, invitePending: false });

    linkEmail = colleague.email;
    await request(app.getHttpServer()).post("/api/auth/reset-password").send({ accessToken: "token-do-link", password: "senha-nova-123" }).expect(204);
    expect(await admin.tenantMember.findFirst({ where: { tenantId: fx.b.id, userId: colleague.id } })).toMatchObject({ isActive: false });
  });

  it("convite que não sai: o usuário fica criado e o admin vê o motivo", async () => {
    const email = `sem-email-${fx.b.id}@teste.local`;
    createdEmails.push(email);
    inviteStatus = 500;
    const { body } = await create({ name: "Sem E-mail", email, role: "AGENT" }).expect(503);
    expect(body.message).toBe('Sem E-mail foi adicionado, mas o e-mail do convite não saiu. Use "Enviar convite" na lista em alguns minutos.');
    expect(await admin.user.count({ where: { email } })).toBe(1);
  });

  it("reenvia o convite a quem está no restaurante; atendente não reenvia", async () => {
    const member = await admin.user.findFirstOrThrow({ where: { email: `convidada-${fx.b.id}@teste.local` }, select: { id: true } });
    const invite = (tenantId: string, token: string, userId = member.id) =>
      request(app.getHttpServer()).post(`/api/settings/${tenantId}/members/${userId}/invite`).set("Authorization", `Bearer ${token}`);
    await invite(fx.b.id, adminToken).expect(204);
    expect(calls()).toEqual([`POST /auth/v1/invite?redirect_to=${redirect}`]);
    await invite(fx.a.id, agentToken).expect(403);
    await invite(fx.b.id, adminToken, "00000000-0000-4000-8000-000000000000").expect(404);
  });

  it("sem o Supabase configurado: pede a senha temporária e não cria ninguém", async () => {
    const email = `sem-supabase-${fx.b.id}@teste.local`;
    const token = await accessTokenFor(noSupabase, fx.user.email, fx.b.id);
    const { body } = await request(noSupabase.getHttpServer())
      .post(`/api/settings/${fx.b.id}/members`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Sem Supabase", email, role: "AGENT" })
      .expect(503);
    expect(body.message).toBe("O convite por e-mail ainda não está disponível. Defina uma senha temporária.");
    expect(await admin.user.count({ where: { email } })).toBe(0);
  });
});
