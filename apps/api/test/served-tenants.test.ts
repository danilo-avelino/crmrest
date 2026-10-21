import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp, drainQueues, metaPayload, postMetaWebhook } from "./helpers.js";

/**
 * WhatsApp de um grupo: o número do restaurante A atende também a unidade B (Configurações → Integrações). O cliente que
 * pergunta pelo pedido feito na B acha o pedido; a C, em que o usuário é só atendente, não pode ser escolhida.
 */
describe("canal que atende outros restaurantes", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let unitB: { id: string; name: string };
  let unitC: { id: string; name: string };
  let ifoodB: { id: string };
  let ifoodC: { id: string };
  let token: string;
  const suffix = randomUUID().slice(0, 8);

  const say = async (waId: string, id: string, body: string) => {
    await postMetaWebhook(
      app,
      metaPayload(fx.whatsapp.externalId, {
        contacts: [{ profile: { name: "Carla Souza" }, wa_id: waId }],
        messages: [{ from: waId, id: `${id}-${suffix}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
      }),
    ).expect(200);
    await drainQueues(app);
  };
  const conversationOf = (waId: string) =>
    admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, channelId: fx.whatsapp.id, contact: { identities: { some: { channelType: "WHATSAPP", externalId: waId } } } },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  type Content = { text?: string; automation?: string; event?: string };
  const contents = async (waId: string) => (await conversationOf(waId)).messages.map((m) => m.content as Content);

  /** Pedido do iFood numa unidade, de um cliente com o mesmo telefone do WhatsApp. */
  const orderIn = async (tenantId: string, channelId: string, code: string, phone: string, placedAt = new Date()) => {
    const contact = await admin.contact.create({ data: { tenantId, name: "Carla Souza", phone } });
    return admin.order.create({
      data: {
        tenantId,
        contactId: contact.id,
        channelId,
        externalOrderId: `grupo-${code}-${suffix}`,
        displayCode: code,
        status: "PREPARING",
        subtotal: "40.00",
        deliveryFee: "0.00",
        total: "40.00",
        placedAt,
        raw: {},
        items: { create: { tenantId, name: "Pizza Calabresa", quantity: 1, unitPrice: "40.00" } },
      },
    });
  };

  beforeAll(async () => {
    // Com o chat do iFood na Inbox: o aviso do entregador vai para o chat do pedido.
    app = await createTestApp({ IFOOD_CHAT_BRIDGE: "true" });
    fx = await createChannelFixture();
    // O usuário administra A e B; na C é só atendente.
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    const unit = async (label: string, role: "ADMIN" | "AGENT") =>
      admin.tenant.create({
        data: { name: `Unidade ${label} ${suffix}`, slug: `unidade-${label.toLowerCase()}-${suffix}`, members: { create: { userId: fx.user.id, role } } },
        select: { id: true, name: true },
      });
    [unitB, unitC] = await Promise.all([unit("B", "ADMIN"), unit("C", "AGENT")]);
    const ifood = (tenantId: string) =>
      admin.channel.create({
        data: { tenantId, type: "IFOOD", name: "iFood", externalId: randomUUID(), credentials: Buffer.from("-"), status: "CONNECTED" },
        select: { id: true },
      });
    [ifoodB, ifoodC] = await Promise.all([ifood(unitB.id), ifood(unitC.id)]);
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    await admin.tenant.deleteMany({ where: { id: { in: [unitB?.id, unitC?.id].filter(Boolean) } } });
    await fx?.cleanup();
    await app?.close();
  });

  const api = () => request(app.getHttpServer());

  it("sem a escolha, o pedido da outra unidade não é achado", async () => {
    await orderIn(unitB.id, ifoodB.id, "7001", "+5511970000201");
    await say("5511970000201", "wamid.G1", "Oi");
    await say("5511970000201", "wamid.G2", "1");
    expect((await contents("5511970000201")).at(-1)?.automation).toBe("order_number_request");
  });

  it("Integrações lista só as unidades que o usuário administra; a escolha vale para WhatsApp e Instagram", async () => {
    const { body } = await api().get(`/api/integrations?tenantId=${fx.tenant.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(body.servableTenants).toEqual([unitB]);
    expect(body.integrations.find((item: { id: string }) => item.id === fx.whatsapp.id).servedTenantIds).toEqual([]);

    const serve = (channelId: string, tenantIds: string[]) =>
      api().patch(`/api/integrations/${fx.tenant.id}/${channelId}/served-tenants`).set("Authorization", `Bearer ${token}`).send({ tenantIds });
    await serve(fx.whatsapp.id, [unitC.id]).expect(403);
    await serve(fx.ifood.id, [unitB.id]).expect(404);
    const saved = await serve(fx.whatsapp.id, [unitB.id, fx.tenant.id]).expect(200);
    expect(saved.body.servedTenantIds).toEqual([unitB.id]);
  });

  it("com a unidade escolhida, o atendimento acha o pedido dela e não une os cadastros", async () => {
    const order = await orderIn(unitB.id, ifoodB.id, "7002", "+5511970000202");
    await say("5511970000202", "wamid.G3", "Oi");
    await say("5511970000202", "wamid.G4", "1");
    let conversation = await conversationOf("5511970000202");
    expect(conversation.automationState).toMatchObject({ triage: "awaiting_order_confirmation", foundOrderId: order.id, autoFound: true });
    const contactBefore = conversation.contactId;

    await say("5511970000202", "wamid.G5", "1");
    conversation = await conversationOf("5511970000202");
    expect(conversation.contactId).toBe(contactBefore);
    const content = conversation.messages.map((m) => m.content as Content);
    expect(content).toContainEqual({ event: "order_other_restaurant", text: `O pedido #7002 (iFood) é do restaurante ${unitB.name}` });
    expect(content.at(-1)?.automation).toBe("order_confirmed");

    // Card na conversa e painel do cliente: o pedido aparece com o nome da unidade.
    const messages = await api().get(`/api/conversations/${conversation.id}/messages`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(messages.body.orders[order.id]).toMatchObject({ displayCode: "7002", restaurantName: unitB.name });
    const current = await api().get(`/api/orders/current?conversationId=${conversation.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(current.body.current.order).toMatchObject({ id: order.id, restaurantName: unitB.name });
    await api().get(`/api/orders/${order.id}/forecast?conversationId=${conversation.id}`).set("Authorization", `Bearer ${token}`).expect(200);
  });

  describe("entregador", () => {
    const courierWa = "5511970000299";
    const courierSay = async (id: string, body: string, settle: () => Promise<void> = () => drainQueues(app)) => {
      await postMetaWebhook(
        app,
        metaPayload(fx.whatsapp.externalId, {
          contacts: [{ profile: { name: "João" }, wa_id: courierWa }],
          messages: [{ from: courierWa, id: `${id}-${suffix}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
        }),
      ).expect(200);
      await settle();
    };

    beforeAll(async () => {
      await admin.contact.create({
        data: {
          tenantId: fx.tenant.id,
          name: "João Entregador",
          tags: ["Entregador"],
          identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: courierWa } },
        },
      });
    });

    it("avisa que chegou com o pedido da outra unidade: o aviso vai para o chat do iFood dela", async () => {
      const order = await orderIn(unitB.id, ifoodB.id, "7101", "+5511970000210");
      await courierSay("wamid.E1", "Oi");
      await courierSay("wamid.E2", "1");
      // O aviso no chat do iFood fica agendado à espera da extensão do painel: a fila não esvazia sozinha.
      const outbound = app.get<Queue>(getQueueToken(QUEUES.outbound));
      await courierSay("wamid.E3", "7101", () =>
        vi.waitFor(
          async () => {
            expect((await contents(courierWa)).at(-1)?.automation).toBe("courier_arrival_confirmed");
            const counts = await outbound.getJobCounts("waiting", "active", "prioritized");
            expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(0);
          },
          { timeout: 15_000, interval: 100 },
        ),
      );
      await outbound.drain(true);
      // O entregador recebe a confirmação e a conversa dele se encerra sozinha.
      expect(await conversationOf(courierWa)).toMatchObject({ status: "RESOLVED", unreadCount: 0, awaitingAgentSince: null });

      expect((await contents(courierWa)).at(-1)).toEqual({
        automation: "courier_arrival_confirmed",
        text: "Pronto! Avisamos o cliente do pedido #7101 que você chegou.",
      });
      const chat = await admin.conversation.findFirstOrThrow({
        where: { tenantId: unitB.id, channelId: ifoodB.id, contactId: order.contactId },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
      expect(chat.messages.map((m) => m.content)).toContainEqual({ automation: "courier_arrival", text: "O entregador nos avisou que está na sua porta! 🛵" });
    });

    it("problema com o pedido da outra unidade: o card fica na conversa com o nome dela", async () => {
      const order = await orderIn(unitB.id, ifoodB.id, "7102", "+5511970000211");
      // Depois do aviso de chegada, a próxima mensagem começa um atendimento novo, com o menu do entregador.
      await courierSay("wamid.E4", "Oi");
      expect((await contents(courierWa)).at(-1)?.automation).toBe("courier_menu");
      expect((await conversationOf(courierWa)).status).toBe("OPEN");
      await courierSay("wamid.E5", "2");
      await courierSay("wamid.E6", "7102");

      const conversation = await conversationOf(courierWa);
      expect(conversation.messages.map((m) => m.content)).toContainEqual({ event: "order", orderId: order.id, customerChat: true });
      const messages = await api().get(`/api/conversations/${conversation.id}/messages`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(messages.body.orders[order.id]).toMatchObject({ displayCode: "7102", restaurantName: unitB.name });
    });
  });

  it("painel master: o pedido de um restaurante que o canal não atende fica de fora", async () => {
    const served = await orderIn(unitB.id, ifoodB.id, "7003", "+5511970000203", new Date(Date.now() - 60_000));
    // Mais recente, mas na unidade C, que o WhatsApp não atende.
    await orderIn(unitC.id, ifoodC.id, "7004", "+5511970000203");
    await say("5511970000203", "wamid.G6", "Oi");
    const conversation = await conversationOf("5511970000203");

    const master = await accessTokenFor(app, fx.user.email, "master");
    const current = await api().get(`/api/orders/current?conversationId=${conversation.id}`).set("Authorization", `Bearer ${master}`).expect(200);
    expect(current.body.current.order).toMatchObject({ id: served.id, restaurantName: unitB.name });
  });
});
