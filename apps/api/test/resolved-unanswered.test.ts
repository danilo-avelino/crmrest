import type { MessageContent } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { misconductText } from "../src/notifications/admin-notifications.service.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp, startMockGraph } from "./helpers.js";

type SentText = { to: string; text: { body: string } };
type Row = { direction: "INBOUND" | "OUTBOUND"; text?: string; type?: "TEXT" | "STICKER" | "AUDIO"; content?: MessageContent };

describe("resolver com o cliente sem resposta é má conduta", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let token: string;

  beforeAll(async () => {
    graph = await startMockGraph();
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", META_GRAPH_URL: graph.url });
    fx = await createChannelFixture();
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    await admin.tenantModule.create({ data: { tenantId: fx.tenant.id, module: "AI" } });
    await admin.tenant.update({
      where: { id: fx.tenant.id },
      data: { settings: { adminNotifications: { phones: ["+5511955554444"], misconduct: true, weeklyReport: false } } },
    });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await graph?.close();
  });

  const api = (method: "get" | "patch", path: string) => request(app.getHttpServer())[method](`/api${path}`).set("Authorization", `Bearer ${token}`);
  const sentTo = (phone: string) =>
    graph.requests.filter((req) => req.method === "POST" && (req.body as SentText | null)?.to === phone).map((req) => (req.body as SentText).text.body);

  /** Conversa aberta com as mensagens na ordem de entrada. */
  async function chat(name: string, rows: Row[], tags: string[] = []) {
    const contact = await admin.contact.create({ data: { tenantId: fx.tenant.id, name, tags } });
    const conversation = await admin.conversation.create({
      data: { tenantId: fx.tenant.id, contactId: contact.id, channelId: fx.whatsapp.id, status: "OPEN", teamInvolved: true },
    });
    for (const row of rows) {
      await admin.message.create({
        data: {
          tenantId: fx.tenant.id,
          conversationId: conversation.id,
          channelId: fx.whatsapp.id,
          direction: row.direction,
          type: row.type ?? "TEXT",
          status: row.direction === "INBOUND" ? "DELIVERED" : "SENT",
          content: row.content ?? (row.text ? { text: row.text } : {}),
        },
      });
    }
    return conversation.id;
  }
  const alertsOf = (conversationId: string) =>
    admin.message.findMany({ where: { conversationId, content: { path: ["event"], equals: "resolved_unanswered" } } });
  /** O painel avisa antes (`unanswered`) e, resolvida, quantos alertas a conversa ganhou. */
  async function resolve(conversationId: string) {
    const before = (await api("get", `/conversations/${conversationId}/messages`).expect(200)).body.unanswered as boolean;
    await api("patch", `/conversations/${conversationId}`).send({ status: "RESOLVED" }).expect(200);
    return { before, alerts: await alertsOf(conversationId) };
  }

  it("cliente sem resposta: alerta na conversa, nas Avaliações e no WhatsApp do gestor", async () => {
    const id = await chat("Carla Dias", [
      { direction: "INBOUND", text: "Quero uma coca também" },
      { direction: "OUTBOUND", text: "Claro! Qual refrigerante?", content: { text: "Claro! Qual refrigerante?", aiReply: true } },
      { direction: "INBOUND", text: "Alguém pode falar comigo, por favor??" },
      { direction: "INBOUND", text: "ok" },
    ]);
    const { before, alerts } = await resolve(id);
    expect(before).toBe(true);
    expect(alerts).toMatchObject([
      {
        direction: "INTERNAL",
        type: "SYSTEM",
        sentByUserId: fx.user.id,
        content: {
          event: "resolved_unanswered",
          text: "Má conduta: Atendente resolveu a conversa sem responder ao cliente",
          misconduct: "Resolveu a conversa sem responder ao cliente",
          original: "Alguém pode falar comigo, por favor??",
        },
      },
    ]);
    // A marca de resolvida continua sendo a última (a prévia da lista).
    const last = await admin.message.findFirstOrThrow({ where: { conversationId: id }, orderBy: { id: "desc" } });
    expect((last.content as MessageContent).event).toBe("resolved");
    // Resolvida, o painel não avisa mais; resolver de novo não repete o alerta.
    expect((await api("get", `/conversations/${id}/messages`).expect(200)).body.unanswered).toBe(false);
    await api("patch", `/conversations/${id}`).send({ status: "RESOLVED" }).expect(200);
    expect(await alertsOf(id)).toHaveLength(1);

    await vi.waitFor(() => expect(sentTo("5511955554444")).toHaveLength(1), { timeout: 15_000, interval: 100 });
    const [text] = sentTo("5511955554444");
    expect(text).toContain("🚨 *Alerta de má conduta · Dish Desk*");
    expect(text).toContain("*Atendente Pipeline* resolveu a conversa do cliente *Carla Dias* sem responder a ele.");
    expect(text).toContain('📝 *Última mensagem do cliente:* "Alguém pode falar comigo, por favor??"');

    const report = await api("get", `/reports/ratings?tenantId=${fx.tenant.id}&period=today`).expect(200);
    expect(report.body.ai.misconduct).toContainEqual({
      kind: "unanswered",
      messageId: alerts[0]!.id,
      tenantId: fx.tenant.id,
      conversationId: id,
      contactName: "Carla Dias",
      agentName: "Atendente Pipeline",
      original: "Alguém pode falar comigo, por favor??",
      reason: "Resolveu a conversa sem responder ao cliente",
      createdAt: alerts[0]!.createdAt.toISOString(),
    });
  });

  it("áudio sem resposta também conta", async () => {
    const id = await chat("Davi Lima", [{ direction: "INBOUND", type: "AUDIO", content: { media: { mimeType: "audio/ogg" } } }]);
    const { before, alerts } = await resolve(id);
    expect(before).toBe(true);
    expect(alerts).toMatchObject([{ content: { original: "[áudio]" } }]);
  });

  it("não é má conduta: respondido, só encerramento, figurinha, funcionário, bot ou sem mensagem do cliente", async () => {
    const cases = [
      await chat("Respondido pela equipe", [
        { direction: "INBOUND", text: "Meu pedido não chegou" },
        { direction: "OUTBOUND", text: "Já saiu, chega em 10 min" },
      ]),
      await chat("Respondido por automação", [
        { direction: "INBOUND", text: "Oi" },
        { direction: "OUTBOUND", content: { text: "Escolha uma opção", automation: "menu" } },
      ]),
      await chat("Só agradeceu", [
        { direction: "INBOUND", text: "Cadê meu pedido?" },
        { direction: "OUTBOUND", text: "Saiu agora" },
        { direction: "INBOUND", text: "Mt obrigadaa, boa noite" },
        { direction: "INBOUND", text: "👍" },
        { direction: "INBOUND", type: "STICKER", content: { media: { mimeType: "image/webp" } } },
      ]),
      await chat("Funcionário", [{ direction: "INBOUND", text: "Chego às 18h amanhã" }], ["Funcionário"]),
      await chat("Bot", [{ direction: "INBOUND", text: "Promoção imperdível" }], ["Bot"]),
      await chat("Sem mensagem", [{ direction: "OUTBOUND", text: "Seu pedido saiu" }]),
    ];
    for (const id of cases) {
      const { before, alerts } = await resolve(id);
      expect({ id, before, alerts: alerts.length }).toEqual({ id, before: false, alerts: 0 });
    }
  });
});

describe("texto do alerta de conversa sem resposta", () => {
  it("diz quem resolveu, o cliente e a última mensagem dele", () => {
    const text = misconductText({
      restaurant: "Mobydick",
      agent: null,
      contact: null,
      original: "Qual o sabor?",
      reason: "Resolveu a conversa sem responder ao cliente",
      at: new Date("2026-11-24T22:10:00Z"),
      unanswered: true,
    });
    expect(text).toContain("*um atendente* resolveu a conversa do cliente *sem nome* sem responder a ele.");
    expect(text).toContain('📝 *Última mensagem do cliente:* "Qual o sabor?"');
    expect(text).toContain("🕐 24/11 às 19:10");
    expect(text).not.toContain("A IA bloqueou");
  });
});
