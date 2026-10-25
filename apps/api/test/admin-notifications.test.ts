import type { RatingsReportDto } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AdminNotificationsService, misconductText, weeklyReportText } from "../src/notifications/admin-notifications.service.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp, startMockGraph } from "./helpers.js";

type SentText = { to: string; text: { body: string } };

describe("notificações ao administrador pelo WhatsApp do restaurante", () => {
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

  const settings = (method: "put" | "post", path: string) =>
    request(app.getHttpServer())[method](`/api/settings/${fx.tenant.id}${path}`).set("Authorization", `Bearer ${token}`);
  /** Mensagens que o WhatsApp do restaurante mandou a um número. */
  const sentTo = (phone: string) =>
    graph.requests.filter((req) => req.method === "POST" && (req.body as SentText | null)?.to === phone).map((req) => (req.body as SentText).text.body);

  it("salva os números em E.164, sem repetidos, e recusa número inválido", async () => {
    const { body } = await settings("put", "/admin-notifications")
      .send({ phones: ["(11) 98765-4321", "+55 11 98765-4321", "86 99973-1647"], misconduct: true, weeklyReport: true })
      .expect(200);
    expect(body.adminNotifications).toEqual({ phones: ["+5511987654321", "+5586999731647"], misconduct: true, weeklyReport: true });
    expect(body.notificationChannel).toBe("WHATSAPP");

    await settings("put", "/admin-notifications").send({ phones: ["123"], misconduct: true, weeklyReport: true }).expect(400);
  });

  it("relatório de teste: vai para cada número, pelo WhatsApp do restaurante, identificado como do Dish Desk", async () => {
    const { body } = await settings("post", "/admin-notifications/test").expect(200);
    expect(body).toEqual({ sent: 2 });
    await vi.waitFor(() => expect(sentTo("5511987654321")).toHaveLength(1), { timeout: 15_000, interval: 100 });
    await vi.waitFor(() => expect(sentTo("5586999731647")).toHaveLength(1), { timeout: 15_000, interval: 100 });
    const [report] = sentTo("5511987654321");
    expect(report).toContain("📊 *Relatório semanal · Dish Desk*");
    expect(report).toContain("🍽️ *Restaurante Pipeline*");
    expect(report).toContain("Configurações → Notificações");
  });

  it("relatório de teste sem número salvo: recusa e explica", async () => {
    await settings("put", "/admin-notifications").send({ phones: [], misconduct: true, weeklyReport: true }).expect(200);
    const { body } = await settings("post", "/admin-notifications/test").expect(422);
    expect(body.message).toBe("Cadastre e salve pelo menos um número.");
  });

  it("alerta de má conduta: vai para os números com o alerta ligado; desligado, não vai", async () => {
    const contact = await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Ana Souza" } });
    const conversation = await admin.conversation.create({
      data: { tenantId: fx.tenant.id, contactId: contact.id, channelId: fx.whatsapp.id, status: "OPEN" },
    });
    const blocked = await admin.message.create({
      data: {
        tenantId: fx.tenant.id,
        conversationId: conversation.id,
        channelId: fx.whatsapp.id,
        direction: "INTERNAL",
        type: "TEXT",
        sentByUserId: fx.user.id,
        content: { original: "cala a boca vc", misconduct: "Mandou o cliente calar a boca", aiReview: "blocked" },
      },
    });
    const notifications = app.get(AdminNotificationsService);

    await settings("put", "/admin-notifications").send({ phones: ["11 91234-5678"], misconduct: false, weeklyReport: true }).expect(200);
    await notifications.misconduct(fx.tenant.id, blocked.id);
    await settings("put", "/admin-notifications").send({ phones: ["11 91234-5678"], misconduct: true, weeklyReport: true }).expect(200);
    await notifications.misconduct(fx.tenant.id, blocked.id);

    await vi.waitFor(() => expect(sentTo("5511912345678")).toHaveLength(1), { timeout: 15_000, interval: 100 });
    const [alert] = sentTo("5511912345678");
    expect(alert).toContain("🚨 *Alerta de má conduta · Dish Desk*");
    expect(alert).toContain("A IA bloqueou uma resposta de *Atendente Pipeline* ao cliente *Ana Souza*");
    expect(alert).toContain('📝 *Mensagem:* "cala a boca vc"');
    expect(alert).toContain("❗ *Motivo:* Mandou o cliente calar a boca");
  });
});

describe("textos das notificações", () => {
  const report = (ai: Partial<NonNullable<RatingsReportDto["ai"]>> | null): RatingsReportDto => ({
    summary: { ratings: 4, averageScore: 4.5, answered: 10, averageResponseSeconds: 200, handoffs: 12 },
    unanswered: [{ conversationId: "c1", contactName: null, calledAt: "", afterHours: false }],
    agents: [],
    recent: [],
    ai: ai && {
      evaluations: 20,
      averageScore: 4.25,
      resolved: 18,
      reacted: 0,
      satisfied: 0,
      lowScores: 0,
      onlyAi: 15,
      teamReasons: [],
      waiting: { closed: 0, full_auto: 0, offline: 0 },
      reviews: [],
      rewriteExample: null,
      agents: [],
      recent: [],
      misconduct: [],
      ...ai,
    },
  });
  const from = new Date("2026-10-19T12:00:00Z");
  const to = new Date("2026-10-26T12:00:00Z");

  it("relatório semanal: números, tempo, motivos com % e barra, avaliações e má conduta", () => {
    const text = weeklyReportText(
      "Mobydick",
      248,
      report({
        teamReasons: [
          { reason: "atraso", count: 6 },
          { reason: "problema_pedido", count: 3 },
          { reason: "outro", count: 1 },
        ],
        misconduct: [{ messageId: "m", conversationId: "c", contactName: null, agentName: null, original: "", reason: "", createdAt: "" }],
      }),
      from,
      to,
    );
    expect(text).toContain("📅 19/10 a 26/10 (últimos 7 dias)");
    expect(text).toContain("• *248* conversas");
    expect(text).toContain("• *12* chamados para a equipe");
    expect(text).toContain("• 🤖 *75%* dos atendimentos só com a IA");
    expect(text).toContain("• Média da equipe: *3 min*");
    expect(text).toContain("• ⚠️ *1* chamado ficou sem resposta");
    expect(text).toContain("Reclamação de atraso\n▰▰▰▰▰▰▱▱▱▱ *60%* (6)");
    expect(text).toContain("Problema no pedido\n▰▰▰▱▱▱▱▱▱▱ *30%* (3)");
    expect(text).toContain("• Clientes: *4,5* de 5 (4 notas)");
    expect(text).toContain("• IA: *4,3* de 5 (20 atendimentos)");
    expect(text).toContain("• ✅ *90%* dos problemas resolvidos");
    expect(text).toContain("🚨 *1* alerta de má conduta na semana");
  });

  it("restaurante sem o módulo de IA: sem motivos, sem IA e sem má conduta", () => {
    const text = weeklyReportText("Mobydick", 1, report(null), from, to);
    expect(text).toContain("• *1* conversa");
    expect(text).not.toContain("MOTIVOS");
    expect(text).not.toContain("🤖");
    expect(text).not.toContain("• IA:");
    expect(text).not.toContain("má conduta");
  });

  it("alerta de má conduta corta mensagens longas", () => {
    const text = misconductText({ restaurant: "Mobydick", agent: null, contact: null, original: "a".repeat(400), reason: "Ofensa", at: to });
    expect(text).toContain("A IA bloqueou uma resposta de *um atendente* ao cliente *sem nome*");
    expect(text).toContain(`"${"a".repeat(300)}…"`);
  });
});
