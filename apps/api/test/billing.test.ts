import { createHmac, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createTestApp, PASSWORD, startMockGraph } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_SECRET = "whsec_teste";
const CHECKOUT_URL = "https://checkout.stripe.test/c/pay/cs_test_1";
const PORTAL_URL = "https://billing.stripe.test/p/session/bps_test_1";

describe("cadastro pelo site, teste grátis e assinatura", () => {
  let app: INestApplication;
  let stripe: Awaited<ReturnType<typeof startMockGraph>>;
  const suffix = randomUUID().slice(0, 8);
  const emails: string[] = [];
  // Dona da Cantina (cadastro 1) e dono da segunda Cantina (cadastro 2), cada um com a sessão do próprio cadastro.
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let cantina: string;
  let segunda: string;
  // Assinaturas que a Stripe simulada devolve para qualquer cliente.
  let subscriptions: string[] = [];

  const signupBody = (email: string) => ({
    restaurantName: `Cantina Teste ${suffix}`,
    name: "Bruna Lima",
    phone: "(86) 99817-9385",
    taxId: "66.832.307/0001-67",
    email,
    password: PASSWORD,
  });

  const tenant = (id: string) => admin.tenant.findUniqueOrThrow({ where: { id } });
  const calls = () => stripe.requests.map((call) => `${call.method} ${call.path}`);
  const form = (index: number) => Object.fromEntries(new URLSearchParams(String(stripe.requests[index]!.body)));

  const postStripe = (event: unknown, secret = WEBHOOK_SECRET) => {
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
    return request(app.getHttpServer())
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", `t=${timestamp},v1=${signature}`)
      .send(raw);
  };

  const sessionEvent = (object: Record<string, unknown>) => ({
    type: "checkout.session.completed",
    data: { object: { payment_status: "paid", customer: null, created: Math.floor(Date.now() / 1000), ...object } },
  });

  beforeAll(async () => {
    stripe = await startMockGraph();
    stripe.reply((call) => {
      if (call.method === "GET") return { status: 200, body: { data: subscriptions.map((id) => ({ id })) } };
      if (call.method === "DELETE") return { status: 200, body: {} };
      return { status: 200, body: { url: call.path === "/v1/billing_portal/sessions" ? PORTAL_URL : CHECKOUT_URL } };
    });
    app = await createTestApp({ STRIPE_SECRET_KEY: "sk_test_chave", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_URL: stripe.url });
    owner = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
  });

  afterAll(async () => {
    await admin.tenant.deleteMany({ where: { members: { some: { user: { email: { in: emails } } } } } });
    await admin.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
    await stripe?.close();
  });

  it("cria o restaurante em teste e quem se cadastrou já entra como administrador", async () => {
    const email = `dona-${suffix}@teste.local`;
    emails.push(email);
    const response = await owner.post("/api/auth/signup").send(signupBody(email.toUpperCase())).expect(201);

    expect(String(response.headers["set-cookie"])).toMatch(/dishdesk_session=.+HttpOnly/);
    expect(response.body.user).toMatchObject({ name: "Bruna Lima", email, isSuperAdmin: false });
    expect(response.body.context).toMatchObject({ mode: "tenant", tenants: [{ name: `Cantina Teste ${suffix}`, role: "ADMIN" }] });
    expect(response.body.tenants).toMatchObject([{ blockedBy: null, billing: { plan: null, trustUntil: null, trustAvailable: false } }]);
    cantina = response.body.context.tenants[0].id;
    await request(app.getHttpServer()).get("/api/auth/me").set("Authorization", `Bearer ${response.body.accessToken}`).expect(200);

    const created = await tenant(cantina);
    expect(created).toMatchObject({
      slug: `cantina-teste-${suffix}`,
      status: "ACTIVE",
      contactPhone: "+5586998179385",
      taxId: "66832307000167",
      paidUntil: null,
    });
    const trialMs = created.trialEndsAt!.getTime() - Date.now();
    expect(trialMs).toBeGreaterThan(15 * DAY_MS - 60_000);
    expect(trialMs).toBeLessThanOrEqual(15 * DAY_MS);
  });

  it("recusa e-mail que já tem conta e dados inválidos; nome repetido ganha outro endereço", async () => {
    const repeated = await request(app.getHttpServer()).post("/api/auth/signup").send(signupBody(emails[0]!)).expect(409);
    expect(repeated.body.message).toBe("Já existe uma conta com este e-mail. Entre no sistema.");
    await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({ ...signupBody(`invalido-${suffix}@teste.local`), taxId: "123.456.789-00" })
      .expect(400);
    expect(await admin.user.count({ where: { email: `invalido-${suffix}@teste.local` } })).toBe(0);

    const email = `dono-${suffix}@teste.local`;
    emails.push(email);
    const response = await other.post("/api/auth/signup").send({ ...signupBody(email), taxId: "123.456.789-09" }).expect(201);
    segunda = response.body.context.tenants[0].id;
    expect((await tenant(segunda)).slug).toMatch(new RegExp(`^cantina-teste-${suffix}-[0-9a-f]{8}$`));
  });

  it("fim do teste sem pagamento: o restaurante aparece bloqueado e não recebe token", async () => {
    await admin.tenant.update({ where: { id: cantina }, data: { trialEndsAt: new Date(Date.now() - 60_000) } });

    const refreshed = await owner.post("/api/auth/refresh").expect(200);
    expect(refreshed.body).toMatchObject({ context: null, accessToken: null, tenants: [{ id: cantina, blockedBy: "trial" }] });
    await owner.post("/api/auth/context").send({ mode: "tenant", tenantId: cantina }).expect(402);
    // A liberação por confiança é só para assinatura vencida: quem nunca pagou não estica o teste.
    expect(refreshed.body.tenants[0].billing.trustAvailable).toBe(false);
    await owner.post("/api/auth/billing/trust").send({ tenantId: cantina }).expect(409);
  });

  it("checkout: mensal no cartão e anual em qualquer meio, só para o administrador do restaurante", async () => {
    const checkout = (agent: ReturnType<typeof request.agent>, tenantId: string, plan: string) =>
      agent.post("/api/auth/billing/checkout").send({ tenantId, plan });

    await request(app.getHttpServer()).post("/api/auth/billing/checkout").send({ tenantId: cantina, plan: "monthly" }).expect(401);
    await checkout(other, cantina, "monthly").expect(403); // não é da equipe

    const agentEmail = `atendente-${suffix}@teste.local`;
    emails.push(agentEmail);
    await admin.user.create({
      data: { name: "Atendente", email: agentEmail, passwordHash: await hash(PASSWORD), memberships: { create: { tenantId: cantina, role: "AGENT" } } },
    });
    const agent = request.agent(app.getHttpServer());
    await agent.post("/api/auth/login").send({ email: agentEmail, password: PASSWORD }).expect(200);
    await checkout(agent, cantina, "monthly").expect(403);
    expect(stripe.requests).toEqual([]);

    const monthly = await checkout(owner, cantina, "monthly").expect(200);
    expect(monthly.body).toEqual({ url: CHECKOUT_URL });
    expect(stripe.requests).toHaveLength(1);
    expect(stripe.requests[0]).toMatchObject({ method: "POST", path: "/v1/checkout/sessions", authorization: "Bearer sk_test_chave" });
    expect(form(0)).toEqual({
      mode: "subscription",
      "payment_method_types[0]": "card",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "brl",
      "line_items[0][price_data][unit_amount]": "9900",
      "line_items[0][price_data][product_data][name]": "Dish Desk · plano mensal",
      "line_items[0][price_data][recurring][interval]": "month",
      client_reference_id: cantina,
      "metadata[restaurante]": `Cantina Teste ${suffix}`,
      "metadata[cpf_cnpj]": "66832307000167",
      locale: "pt-BR",
      success_url: `http://localhost:3000/assinatura?restaurante=${cantina}&pago=1`,
      cancel_url: `http://localhost:3000/assinatura?restaurante=${cantina}`,
      customer_email: emails[0],
    });

    await checkout(owner, cantina, "annual").expect(200);
    expect(form(1)).toMatchObject({ mode: "payment", "line_items[0][price_data][unit_amount]": "99900" });
    expect(String(stripe.requests[1]!.body)).not.toContain("recurring");
    // Sem meio de pagamento fixo: a Stripe mostra os que estão ativos no painel.
    expect(String(stripe.requests[1]!.body)).not.toContain("payment_method_types");

    // Ainda no teste grátis, pela aba Pagamento: assina na hora e volta para as configurações.
    await checkout(other, segunda, "monthly").expect(200);
    expect(form(2)).toMatchObject({
      mode: "subscription",
      success_url: "http://localhost:3000/configuracoes/pagamento?pago=1",
      cancel_url: "http://localhost:3000/configuracoes/pagamento",
    });
  });

  it("webhook recusa assinatura errada e ignora pagamento ainda não confirmado", async () => {
    const event = sessionEvent({ id: `cs_${suffix}_pix`, mode: "payment", client_reference_id: cantina, amount_total: 99_900 });
    await postStripe(event, "whsec_outro").expect(401);
    await postStripe(sessionEvent({ ...event.data.object, payment_status: "unpaid" })).expect(200);
    expect((await tenant(cantina)).paidUntil).toBeNull();
  });

  it("Pix do plano anual libera o restaurante por um ano; o evento reenviado não conta de novo", async () => {
    const event = sessionEvent({ id: `cs_${suffix}_pix`, mode: "payment", client_reference_id: cantina, amount_total: 99_900 });
    await postStripe(event).expect(200);

    const paidUntil = (await tenant(cantina)).paidUntil!;
    const year = new Date();
    year.setFullYear(year.getFullYear() + 1);
    expect(Math.abs(paidUntil.getTime() - year.getTime())).toBeLessThan(60_000);
    expect(await admin.billingPayment.findMany({ where: { tenantId: cantina } })).toMatchObject([
      { id: `cs_${suffix}_pix`, plan: "ANNUAL", amountCents: 99_900 },
    ]);

    await postStripe(event).expect(200);
    expect((await tenant(cantina)).paidUntil).toEqual(paidUntil);

    const refreshed = await owner.post("/api/auth/refresh").expect(200);
    expect(refreshed.body.tenants).toMatchObject([{ id: cantina, blockedBy: null, billing: { plan: "ANNUAL", accessUntil: paidUntil.toISOString() } }]);
    await owner.post("/api/auth/context").send({ mode: "tenant", tenantId: cantina }).expect(200);

    // Com o plano anual em vigor o mensal não é oferecido; outro ano pode ser pago pela aba Pagamento.
    stripe.requests.length = 0;
    await owner.post("/api/auth/billing/checkout").send({ tenantId: cantina, plan: "monthly" }).expect(409);
    await owner.post("/api/auth/billing/checkout").send({ tenantId: cantina, plan: "annual" }).expect(200);
    expect(calls()).toEqual(["POST /v1/checkout/sessions"]);
    expect(form(0).success_url).toBe("http://localhost:3000/configuracoes/pagamento?pago=1");
  });

  it("mensalidade: o primeiro pagamento libera um mês e cada renovação estende até o fim do período pago", async () => {
    const customer = `cus_${suffix}`;
    const now = Math.floor(Date.now() / 1000);
    await admin.tenant.update({ where: { id: segunda }, data: { trialEndsAt: new Date(Date.now() - 60_000) } });
    await postStripe(
      sessionEvent({ id: `cs_${suffix}_cartao`, mode: "subscription", client_reference_id: segunda, customer, invoice: `in_${suffix}_1`, amount_total: 9_900 }),
    ).expect(200);

    const first = await tenant(segunda);
    expect(first.stripeCustomerId).toBe(customer);
    const days = (date: Date | null) => (date!.getTime() - Date.now()) / DAY_MS;
    // Um mês mais a folga de 1 dia para a cobrança da renovação.
    expect(days(first.paidUntil)).toBeGreaterThan(28);
    expect(days(first.paidUntil)).toBeLessThan(33);

    const invoice = (id: string, periodEnd: number) => ({
      type: "invoice.paid",
      data: { object: { id, customer, amount_paid: 9_900, lines: { data: [{ period: { start: now, end: periodEnd } }] } } },
    });
    // A fatura do primeiro pagamento também chega como invoice.paid: é o mesmo pagamento.
    await postStripe(invoice(`in_${suffix}_1`, now + 30 * 86_400)).expect(200);
    expect((await tenant(segunda)).paidUntil).toEqual(first.paidUntil);

    await postStripe(invoice(`in_${suffix}_2`, now + 61 * 86_400)).expect(200);
    expect((await tenant(segunda)).paidUntil).toEqual(new Date((now + 62 * 86_400) * 1000));
    expect(await admin.billingPayment.count({ where: { tenantId: segunda } })).toBe(2);

    // Fatura de um cliente da Stripe que não é de nenhum restaurante: ignorada.
    await postStripe({ ...invoice(`in_${suffix}_x`, now), data: { object: { ...invoice("x", now).data.object, customer: "cus_desconhecido" } } }).expect(200);
    expect(await admin.billingPayment.count({ where: { id: "x" } })).toBe(0);
  });

  it("quem assina o mensal e está em dia troca o cartão no portal da Stripe, sem outra assinatura", async () => {
    subscriptions = ["sub_atual"];
    stripe.requests.length = 0;
    const response = await other.post("/api/auth/billing/checkout").send({ tenantId: segunda, plan: "monthly" }).expect(200);
    expect(response.body).toEqual({ url: PORTAL_URL });
    expect(calls()).toEqual([`GET /v1/subscriptions?customer=cus_${suffix}`, "POST /v1/billing_portal/sessions"]);
    expect(form(1)).toEqual({
      customer: `cus_${suffix}`,
      locale: "pt-BR",
      return_url: "http://localhost:3000/configuracoes/pagamento",
      "flow_data[type]": "payment_method_update",
      "flow_data[after_completion][type]": "redirect",
      "flow_data[after_completion][redirect][return_url]": "http://localhost:3000/configuracoes/pagamento?cartao=1",
    });
  });

  it("pagamento pendente: bloqueia, libera por confiança uma vez por atraso e mostra o prazo", async () => {
    await admin.tenant.update({ where: { id: segunda }, data: { paidUntil: new Date(Date.now() - 60_000) } });
    const blocked = await other.post("/api/auth/refresh").expect(200);
    expect(blocked.body.tenants).toMatchObject([{ id: segunda, blockedBy: "payment", billing: { trustUntil: null, trustAvailable: true } }]);

    await owner.post("/api/auth/billing/trust").send({ tenantId: segunda }).expect(403); // não é da equipe
    await request(app.getHttpServer()).post("/api/auth/billing/trust").send({ tenantId: segunda }).expect(401);
    await other.post("/api/auth/billing/trust").send({ tenantId: segunda }).expect(204);

    const released = await other.post("/api/auth/refresh").expect(200);
    expect(released.body.tenants).toMatchObject([{ id: segunda, blockedBy: null, billing: { plan: "MONTHLY", trustAvailable: false } }]);
    const trustMs = new Date(released.body.tenants[0].billing.trustUntil).getTime() - Date.now();
    expect(trustMs).toBeGreaterThan(3 * DAY_MS - 60_000);
    expect(trustMs).toBeLessThanOrEqual(3 * DAY_MS);
    await other.post("/api/auth/context").send({ mode: "tenant", tenantId: segunda }).expect(200);
    await other.post("/api/auth/billing/trust").send({ tenantId: segunda }).expect(409);

    // Os 3 dias passam sem pagamento: bloqueia de novo e a liberação deste atraso já foi usada.
    await admin.tenant.update({ where: { id: segunda }, data: { trustUntil: new Date(Date.now() - 60_000) } });
    const expired = await other.post("/api/auth/refresh").expect(200);
    expect(expired.body.tenants).toMatchObject([{ id: segunda, blockedBy: "payment", billing: { trustUntil: null, trustAvailable: false } }]);
    await other.post("/api/auth/billing/trust").send({ tenantId: segunda }).expect(409);
  });

  it("pagamento novo com a assinatura vencida: cobra na hora, cancela a antiga e devolve a liberação por confiança", async () => {
    subscriptions = ["sub_antiga"];
    stripe.requests.length = 0;
    await other.post("/api/auth/billing/checkout").send({ tenantId: segunda, plan: "monthly" }).expect(200);
    // A assinatura antiga só é cancelada quando o pagamento novo é confirmado.
    expect(calls()).toEqual(["POST /v1/checkout/sessions"]);
    expect(form(0)).toMatchObject({
      customer: `cus_${suffix}`,
      success_url: `http://localhost:3000/assinatura?restaurante=${segunda}&pago=1`,
    });
    expect(form(0)).not.toHaveProperty("customer_email");

    subscriptions = ["sub_antiga", "sub_nova"];
    stripe.requests.length = 0;
    await postStripe(
      sessionEvent({
        id: `cs_${suffix}_novo`,
        mode: "subscription",
        client_reference_id: segunda,
        customer: `cus_${suffix}`,
        subscription: "sub_nova",
        invoice: `in_${suffix}_novo`,
        amount_total: 9_900,
      }),
    ).expect(200);
    expect(calls()).toEqual([`GET /v1/subscriptions?customer=cus_${suffix}`, "DELETE /v1/subscriptions/sub_antiga"]);

    expect((await tenant(segunda)).trustUntil).toBeNull();
    const paid = await other.post("/api/auth/refresh").expect(200);
    expect(paid.body.tenants).toMatchObject([{ id: segunda, blockedBy: null, billing: { trustUntil: null, trustAvailable: false } }]);

    // Num atraso futuro, a liberação por confiança volta a valer.
    await admin.tenant.update({ where: { id: segunda }, data: { paidUntil: new Date(Date.now() - 60_000) } });
    const again = await other.post("/api/auth/refresh").expect(200);
    expect(again.body.tenants[0].billing.trustAvailable).toBe(true);
  });

  it("plano anual pago por quem assinava o mensal cancela a assinatura", async () => {
    subscriptions = ["sub_nova"];
    stripe.requests.length = 0;
    await postStripe(
      sessionEvent({ id: `cs_${suffix}_anual`, mode: "payment", client_reference_id: segunda, customer: `cus_${suffix}`, amount_total: 99_900 }),
    ).expect(200);
    expect(calls()).toEqual([`GET /v1/subscriptions?customer=cus_${suffix}`, "DELETE /v1/subscriptions/sub_nova"]);
    expect(await tenant(segunda)).toMatchObject({ billingPlan: "ANNUAL", trustUntil: null });
  });
});
