import type { TenantSettingsDto } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createChannelFixture, createTestApp, drainQueues, metaPayload, postMetaWebhook, startMockGraph } from "./helpers.js";

describe("Dish Desk pausado", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let token: string;

  beforeAll(async () => {
    graph = await startMockGraph();
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", META_GRAPH_URL: graph.url });
    fx = await createChannelFixture();
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await graph?.close();
  });

  const pause = (paused: boolean) =>
    request(app.getHttpServer()).put(`/api/settings/${fx.tenant.id}/pause`).set("Authorization", `Bearer ${token}`).send({ paused });
  const say = async (waId: string, id: string, body: string) => {
    await postMetaWebhook(
      app,
      metaPayload(fx.whatsapp.externalId, {
        contacts: [{ profile: { name: "Carlos M" }, wa_id: waId }],
        messages: [{ from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
      }),
    ).expect(200);
    await drainQueues(app);
  };
  const conversationOf = (waId: string) =>
    admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, contact: { identities: { some: { channelType: "WHATSAPP", externalId: waId } } } },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  const automations = async (waId: string) =>
    (await conversationOf(waId)).messages.flatMap((m) => {
      const { automation } = m.content as { automation?: string };
      return automation ? [automation] : [];
    });
  const sends = () => graph.requests.filter((req) => req.method === "POST").length;

  it("o administrador pausa e a lista de configurações mostra", async () => {
    expect((await pause(true).expect(200)).body).toMatchObject({ tenantId: fx.tenant.id, paused: true });
    const { body } = await request(app.getHttpServer()).get("/api/settings").set("Authorization", `Bearer ${token}`).expect(200);
    expect((body as TenantSettingsDto[]).find((item) => item.tenantId === fx.tenant.id)?.paused).toBe(true);
    await pause("sim" as unknown as boolean).expect(400);
  });

  it("pausado: a mensagem chega não lida, sem menu nem outra automação", async () => {
    const before = sends();
    await say("5511970000101", "wamid.P1", "Oi");
    await say("5511970000101", "wamid.P2", "1");
    const conversation = await conversationOf("5511970000101");
    expect(conversation).toMatchObject({ status: "OPEN", unreadCount: 2, awaitingAgentSince: null });
    expect(await automations("5511970000101")).toEqual([]);
    expect(sends()).toBe(before);
  });

  it("pausado: resolver não pede a nota", async () => {
    const { id } = await conversationOf("5511970000101");
    await request(app.getHttpServer()).patch(`/api/conversations/${id}`).set("Authorization", `Bearer ${token}`).send({ status: "RESOLVED" }).expect(200);
    await drainQueues(app);
    expect(await automations("5511970000101")).toEqual([]);
  });

  it("retomado: o próximo atendimento recebe o menu", async () => {
    expect((await pause(false).expect(200)).body).toMatchObject({ paused: false });
    await say("5511970000102", "wamid.P3", "Oi");
    expect(await automations("5511970000102")).toEqual(["menu"]);
  });
});
