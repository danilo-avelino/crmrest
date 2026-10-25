import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

type Steps = { step: string; status: string; detail: string | null }[];

describe("assistente de configuração (E30)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    token = await accessTokenFor(app, fx.user.email, fx.b.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const api = () => request(app.getHttpServer());
  const statuses = (steps: Steps) => Object.fromEntries(steps.map((item) => [item.step, item.status]));
  const mark = (step: string, value: string | null) =>
    api().put(`/api/onboarding/${fx.b.id}/steps/${step}`).set("Authorization", `Bearer ${token}`).send({ mark: value });

  it("restaurante novo: tudo a fazer, e o assistente abre sozinho", async () => {
    const { body } = await api().get(`/api/onboarding/${fx.b.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(body).toMatchObject({ tenantId: fx.b.id, completed: false, autoOpen: true });
    expect(body.steps.map((item: Steps[number]) => item.step)).toEqual([
      "whatsapp",
      "instagram",
      "ifood",
      "cardapio_web",
      "business_hours",
      "personality",
      "order_links",
      "members",
      "first_message",
    ]);
    expect(new Set(Object.values(statuses(body.steps)))).toEqual(new Set(["todo"]));
  });

  it("só o administrador vê o assistente", async () => {
    const agent = await accessTokenFor(app, fx.user.email, fx.a.id);
    await api().get(`/api/onboarding/${fx.a.id}`).set("Authorization", `Bearer ${agent}`).expect(403);
  });

  it("o progresso vem do que o restaurante tem e do que o admin respondeu", async () => {
    await mark("whatsapp", "skipped").expect(200);
    await mark("ifood", "in_progress").expect(200);
    await mark("personality", "confirmed").expect(200);
    await mark("members", "skipped").expect(200);
    // Integração não "mantém o padrão", e a primeira mensagem não se marca.
    await mark("instagram", "confirmed").expect(422);
    await mark("first_message", "skipped").expect(422);
    await mark("passo-que-nao-existe", "skipped").expect(400);

    await admin.channel.create({
      data: { tenantId: fx.b.id, type: "CARDAPIO_WEB", name: "Loja Centro", externalId: `cw-${fx.b.id}`, credentials: new Uint8Array(), status: "CONNECTED" },
    });
    await admin.channel.create({
      data: { tenantId: fx.b.id, type: "INSTAGRAM", name: "@restaurante", externalId: `ig-${fx.b.id}`, credentials: new Uint8Array(), status: "ERROR" },
    });
    await admin.tenant.update({ where: { id: fx.b.id }, data: { settings: { ...(await settingsOf(fx.b.id)), orderLinks: [{ label: "Site", url: "https://exemplo.com" }] } } });

    const { body } = await api().get(`/api/onboarding/${fx.b.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(statuses(body.steps)).toEqual({
      whatsapp: "skipped",
      instagram: "error",
      ifood: "in_progress",
      cardapio_web: "done",
      business_hours: "todo",
      personality: "done",
      order_links: "done",
      members: "skipped",
      first_message: "todo",
    });
    expect(body.steps.find((item: Steps[number]) => item.step === "cardapio_web").detail).toBe("Loja Centro");
    expect(body.completed).toBe(false);
  });

  it("desfazer uma resposta reabre o passo; abrir o assistente tira a abertura automática", async () => {
    const { body: reopened } = await mark("whatsapp", null).expect(200);
    expect(statuses(reopened.steps).whatsapp).toBe("todo");

    const { body } = await api().post(`/api/onboarding/${fx.b.id}/opened`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(body.autoOpen).toBe(false);
  });

  it("termina quando nada fica a fazer e a primeira mensagem do cliente chega", async () => {
    await mark("whatsapp", "skipped").expect(200);
    await mark("business_hours", "confirmed").expect(200);
    await admin.channel.updateMany({ where: { tenantId: fx.b.id, type: "INSTAGRAM" }, data: { status: "CONNECTED" } });
    const { body: waiting } = await api().get(`/api/onboarding/${fx.b.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(waiting.completed).toBe(false);

    const channel = await admin.channel.findFirstOrThrow({ where: { tenantId: fx.b.id, type: "INSTAGRAM" } });
    const contact = await admin.contact.create({ data: { tenantId: fx.b.id, name: "Primeiro Cliente" } });
    const conversation = await admin.conversation.create({ data: { tenantId: fx.b.id, contactId: contact.id, channelId: channel.id, status: "OPEN" } });
    await admin.message.create({
      data: { tenantId: fx.b.id, conversationId: conversation.id, channelId: channel.id, direction: "INBOUND", type: "TEXT", content: { text: "Oi" } },
    });

    const { body } = await api().get(`/api/onboarding/${fx.b.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(statuses(body.steps).first_message).toBe("done");
    expect(body).toMatchObject({ completed: true, autoOpen: false, firstMessage: { text: "Oi", channelType: "INSTAGRAM" } });
  });
});

async function settingsOf(tenantId: string) {
  const { settings } = await admin.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
  return settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
}
