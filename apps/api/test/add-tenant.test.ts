import { createHmac, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createAuthFixture, createTestApp, PASSWORD, startMockGraph } from "./helpers.js";

const WEBHOOK_SECRET = "whsec_teste";
const CHECKOUT_URL = "https://checkout.stripe.test/c/pay/cs_test_1";

describe("adicionar restaurante na escolha de restaurante", () => {
  let app: INestApplication;
  let stripe: Awaited<ReturnType<typeof startMockGraph>>;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  const suffix = randomUUID().slice(0, 8);
  const created: string[] = [];
  const users: string[] = [];
  // Administrador de B (e atendente de A), atendente só de A e super admin sem restaurante nenhum.
  let owner: ReturnType<typeof request.agent>;
  let agentOnly: ReturnType<typeof request.agent>;
  let superAdmin: ReturnType<typeof request.agent>;
  let superAdminId: string;
  let filial: string;

  const login = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
    return agent;
  };
  const newUser = async (data: { email: string; isSuperAdmin?: boolean; tenantId?: string }) => {
    const user = await admin.user.create({
      data: {
        name: "Usuário Teste",
        email: data.email,
        passwordHash: await hash(PASSWORD),
        isSuperAdmin: data.isSuperAdmin ?? false,
        ...(data.tenantId && { memberships: { create: { tenantId: data.tenantId, role: "AGENT" } } }),
      },
      select: { id: true },
    });
    users.push(user.id);
    return user.id;
  };

  beforeAll(async () => {
    stripe = await startMockGraph();
    stripe.reply(() => ({ status: 200, body: { url: CHECKOUT_URL } }));
    app = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_chave", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_URL: stripe.url });
    fx = await createAuthFixture();
    owner = await login(fx.user.email);
    await newUser({ email: `atendente-${suffix}@teste.local`, tenantId: fx.a.id });
    agentOnly = await login(`atendente-${suffix}@teste.local`);
    superAdminId = await newUser({ email: `plataforma-${suffix}@teste.local`, isSuperAdmin: true });
    superAdmin = await login(`plataforma-${suffix}@teste.local`);
  });

  afterAll(async () => {
    await admin.auditLog.deleteMany({ where: { tenantId: null, userId: superAdminId } });
    await admin.tenant.deleteMany({ where: { id: { in: created } } });
    await admin.user.deleteMany({ where: { id: { in: users } } });
    await fx?.cleanup();
    await app?.close();
    await stripe?.close();
  });

  it("administrador adiciona um restaurante que nasce sem teste grátis, esperando o primeiro pagamento", async () => {
    await request(app.getHttpServer()).post("/api/auth/tenants").send({ name: "Filial", taxId: "123.456.789-09" }).expect(401);

    const { body } = await owner.post("/api/auth/tenants").send({ name: `Filial Centro ${suffix}`, taxId: "123.456.789-09" }).expect(201);
    filial = body.tenantId;
    created.push(filial);

    const tenant = await admin.tenant.findUniqueOrThrow({ where: { id: filial }, include: { members: true } });
    expect(tenant).toMatchObject({ slug: `filial-centro-${suffix}`, taxId: "12345678909", paidUntil: null, status: "ACTIVE" });
    expect(tenant.trialEndsAt).toEqual(tenant.createdAt);
    expect(tenant.members).toMatchObject([{ userId: fx.user.id, role: "ADMIN", isActive: true }]);

    const refreshed = await owner.post("/api/auth/refresh").expect(200);
    expect(refreshed.body.tenants.find((t: { id: string }) => t.id === filial)).toMatchObject({
      role: "ADMIN",
      blockedBy: "unpaid",
      billing: { plan: null, trustUntil: null, trustAvailable: false },
    });
    // Os outros restaurantes do administrador continuam abertos.
    expect(refreshed.body.tenants.find((t: { id: string }) => t.id === fx.b.id).blockedBy).toBeNull();
    await owner.post("/api/auth/context").send({ mode: "tenant", tenantId: filial }).expect(402);
    await owner.post("/api/auth/billing/trust").send({ tenantId: filial }).expect(409);
  });

  it("o pagamento é do restaurante novo, num cliente novo da Stripe, e o libera", async () => {
    const { body } = await owner.post("/api/auth/billing/checkout").send({ tenantId: filial, plan: "monthly" }).expect(200);
    expect(body).toEqual({ url: CHECKOUT_URL });
    expect(Object.fromEntries(new URLSearchParams(String(stripe.requests.at(-1)!.body)))).toMatchObject({
      mode: "subscription",
      "line_items[0][price_data][unit_amount]": "9900",
      client_reference_id: filial,
      "metadata[cpf_cnpj]": "12345678909",
      customer_email: fx.user.email,
      cancel_url: `http://localhost:3000/assinatura?restaurante=${filial}`,
    });

    const raw = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${suffix}_anual`,
          mode: "payment",
          payment_status: "paid",
          client_reference_id: filial,
          customer: null,
          amount_total: 99_900,
          created: Math.floor(Date.now() / 1000),
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest("hex");
    await request(app.getHttpServer())
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", `t=${timestamp},v1=${signature}`)
      .send(raw)
      .expect(200);

    const year = new Date();
    year.setFullYear(year.getFullYear() + 1);
    const { paidUntil } = await admin.tenant.findUniqueOrThrow({ where: { id: filial } });
    expect(Math.abs(paidUntil!.getTime() - year.getTime())).toBeLessThan(60_000);
    await owner.post("/api/auth/context").send({ mode: "tenant", tenantId: filial }).expect(200);
  });

  it("só o super admin cria restaurante de teste; atendente não adiciona restaurante", async () => {
    const count = () => admin.tenant.count({ where: { name: { contains: suffix } } });
    const before = await count();
    const test = await owner.post("/api/auth/tenants").send({ name: `Teste ${suffix}`, test: true }).expect(403);
    expect(test.body.message).toBe("Só a equipe da plataforma cria restaurantes de teste.");
    const agent = await agentOnly.post("/api/auth/tenants").send({ name: `Outro ${suffix}`, taxId: "123.456.789-09" }).expect(403);
    expect(agent.body.message).toBe("Só o administrador de um restaurante pode adicionar outro.");
    await owner.post("/api/auth/tenants").send({ name: `Sem CPF ${suffix}` }).expect(400);
    expect(await count()).toBe(before);
  });

  it("restaurante de teste do super admin não tem cobrança e fica na auditoria da plataforma", async () => {
    const { body } = await superAdmin.post("/api/auth/tenants").send({ name: `Teste ${suffix}`, test: true }).expect(201);
    created.push(body.tenantId);

    expect(await admin.tenant.findUniqueOrThrow({ where: { id: body.tenantId } })).toMatchObject({ trialEndsAt: null, taxId: null });
    const refreshed = await superAdmin.post("/api/auth/refresh").expect(200);
    expect(refreshed.body.tenants).toMatchObject([{ id: body.tenantId, role: "ADMIN", blockedBy: null, billing: null }]);
    await superAdmin.post("/api/auth/context").send({ mode: "tenant", tenantId: body.tenantId }).expect(200);
    expect(await admin.auditLog.findMany({ where: { tenantId: null, userId: superAdminId } })).toMatchObject([
      { action: "tenant.create", entityId: body.tenantId },
    ]);
  });
});
