import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createChannelFixture, createTestApp, drainQueues, startMockGraph } from "./helpers.js";

/**
 * Conta de demonstração: nada sai do Dish Desk (mensagens, avisos, integrações, cobrança), o reset é idempotente e
 * roda sob a RLS, e a simulação grava a conversa em tempo real. Outro restaurante não alcança a demo.
 */
describe("conta de demonstração", () => {
  let app: INestApplication;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let demo: Awaited<ReturnType<typeof createChannelFixture>>;
  let other: Awaited<ReturnType<typeof createAuthFixture>>;
  let token: string;

  beforeAll(async () => {
    graph = await startMockGraph();
    // Envio real ligado e a Graph falsa: se algo da demo sair, a requisição aparece aqui.
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", META_GRAPH_URL: graph.url });
    demo = await createChannelFixture();
    other = await createAuthFixture();
    await admin.tenant.update({ where: { id: demo.tenant.id }, data: { settings: { demo: true } } });
    // O reset age como o administrador da demo.
    await admin.tenantMember.updateMany({ where: { tenantId: demo.tenant.id }, data: { role: "ADMIN" } });
    token = await accessTokenFor(app, demo.user.email, demo.tenant.id);
  });

  afterAll(async () => {
    await app?.close();
    await graph?.close();
    await demo?.cleanup();
    await other?.cleanup();
  });

  const reset = () => request(app.getHttpServer()).post(`/api/demo/${demo.tenant.id}/reset`).set("Authorization", `Bearer ${token}`);
  const count = async () => ({
    conversations: await admin.conversation.count({ where: { tenantId: demo.tenant.id } }),
    orders: await admin.order.count({ where: { tenantId: demo.tenant.id } }),
    contacts: await admin.contact.count({ where: { tenantId: demo.tenant.id } }),
    messages: await admin.message.count({ where: { tenantId: demo.tenant.id } }),
  });

  it("o reset recria os dados sob a RLS e rodar de novo não duplica nada", async () => {
    const first = await reset().expect(200);
    expect(first.body.conversations).toBeGreaterThan(200);
    expect(first.body.ordersToday).toBeGreaterThan(20);
    const before = await count();
    expect(before.conversations).toBe(first.body.conversations);
    await reset().expect(200);
    expect(await count()).toEqual(before);
    // Pedidos em todos os status e conversas em todos os status.
    const statuses = await admin.order.groupBy({ by: ["status"], where: { tenantId: demo.tenant.id } });
    expect(statuses.map((row) => row.status).sort()).toEqual(["CANCELED", "CONFIRMED", "DELIVERED", "DISPATCHED", "PLACED", "PREPARING", "READY"]);
    const conversationStatuses = await admin.conversation.groupBy({ by: ["status"], where: { tenantId: demo.tenant.id } });
    expect(conversationStatuses.map((row) => row.status).sort()).toEqual(["OPEN", "PENDING", "RESOLVED"]);
    expect(await admin.contact.count({ where: { tenantId: demo.tenant.id, tags: { has: "Entregador" } } })).toBe(5);
  });

  it("a foto enviada a um item do cardápio continua depois do reset", async () => {
    const url = "https://cdn.exemplo.com/tenants/demo/photo/margherita.jpg";
    await admin.menuItem.updateMany({ where: { tenantId: demo.tenant.id, name: "Margherita" }, data: { photoUrl: url } });
    await reset().expect(200);
    const items = await admin.menuItem.findMany({ where: { tenantId: demo.tenant.id }, select: { name: true, photoUrl: true } });
    expect(items.find((item) => item.name === "Margherita")?.photoUrl).toBe(url);
    expect(items.filter((item) => item.photoUrl).length).toBe(1);
  });

  it("a resposta da equipe aparece como lida e nada chega ao WhatsApp", async () => {
    const conversation = await admin.conversation.findFirstOrThrow({
      where: { tenantId: demo.tenant.id, status: "OPEN", teamOnly: false, channel: { type: "WHATSAPP" }, contact: { NOT: { tags: { hasSome: ["Entregador", "Funcionário"] } } } },
    });
    await request(app.getHttpServer())
      .post(`/api/conversations/${conversation.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Já estou verificando!" })
      .expect(201);
    await drainQueues(app);
    const sent = await admin.message.findFirstOrThrow({ where: { conversationId: conversation.id, direction: "OUTBOUND" }, orderBy: { createdAt: "desc" } });
    expect(sent).toMatchObject({ status: "READ", content: { text: "Já estou verificando!" } });
    expect(graph.requests).toEqual([]);
  });

  it("integrações, cobrança e convites são recusados na demo", async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${token}` };
    const blocked = { message: "Indisponível na conta de demonstração." };
    await request(server).post(`/api/integrations/${demo.tenant.id}`).set(auth).send({ type: "WHATSAPP" }).expect(422).expect((res) => expect(res.body).toMatchObject(blocked));
    await request(server).post(`/api/integrations/${demo.tenant.id}/whatsapp/qr`).set(auth).send({}).expect(422);
    await request(server).post("/api/auth/billing/checkout").send({ tenantId: demo.tenant.id, plan: "MONTHLY" }).expect(422);
    await request(server).post(`/api/settings/${demo.tenant.id}/admin-notifications/test`).set(auth).expect(422);
    expect(graph.requests).toEqual([]);
  });

  it("a simulação abre uma conversa e as respostas chegam pelo roteiro", async () => {
    const { body } = await request(app.getHttpServer())
      .post(`/api/demo/${demo.tenant.id}/simulate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ scenario: "duvida" })
      .expect(200);
    await vi.waitFor(
      async () => {
        const messages = await admin.message.findMany({ where: { conversationId: body.conversationId }, orderBy: { createdAt: "asc" } });
        expect(messages.map((message) => message.direction)).toEqual(["INBOUND", "OUTBOUND"]);
        expect(messages[1]!.content).toMatchObject({ aiReply: true });
      },
      { timeout: 8_000, interval: 250 },
    );
    expect(graph.requests).toEqual([]);
  });

  it("outro restaurante não alcança a demo, e um restaurante comum não tem as ações da demo", async () => {
    const outsider = await accessTokenFor(app, other.user.email, other.b.id);
    await request(app.getHttpServer()).post(`/api/demo/${demo.tenant.id}/reset`).set("Authorization", `Bearer ${outsider}`).expect(403);
    await request(app.getHttpServer()).post(`/api/demo/${other.b.id}/reset`).set("Authorization", `Bearer ${outsider}`).expect(403);
    const { body } = await request(app.getHttpServer()).get(`/api/conversations?tenantId=${demo.tenant.id}`).set("Authorization", `Bearer ${outsider}`);
    expect(JSON.stringify(body)).not.toContain(demo.tenant.id);
  });
});
