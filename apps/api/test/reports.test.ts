import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createChannelFixture, createTestApp } from "./helpers.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("aba Avaliações: notas e tempo de resposta por atendente", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let bruna: { id: string };

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createChannelFixture();
    bruna = await admin.user.create({
      data: {
        name: "Bruna Teste",
        email: `bruna-${fx.tenant.id}@teste.local`,
        passwordHash: "x",
        memberships: { create: { tenantId: fx.tenant.id, role: "AGENT" } },
      },
      select: { id: true },
    });

    const now = Date.now();
    const contact = await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Carlos Mendes" } });
    const conversation = () =>
      admin.conversation.create({ data: { tenantId: fx.tenant.id, contactId: contact.id, channelId: fx.whatsapp.id, status: "RESOLVED" } });
    const base = { tenantId: fx.tenant.id, channelId: fx.whatsapp.id };
    const handoff = (conversationId: string, at: number) =>
      admin.message.create({
        data: { ...base, conversationId, direction: "INTERNAL", type: "SYSTEM", content: { event: "handoff" }, createdAt: new Date(at) },
      });
    const reply = (conversationId: string, userId: string, at: number) =>
      admin.message.create({
        data: { ...base, conversationId, direction: "OUTBOUND", type: "TEXT", content: { text: "Oi!" }, status: "READ", sentByUserId: userId, createdAt: new Date(at) },
      });

    // Atendimento 1: a Bruna responde em 2 min; o atendente responde por último e recebe a nota 4.
    const first = await conversation();
    await handoff(first.id, now - 60 * MINUTE);
    await reply(first.id, bruna.id, now - 58 * MINUTE);
    await reply(first.id, fx.user.id, now - 55 * MINUTE);
    await admin.rating.create({ data: { tenantId: fx.tenant.id, conversationId: first.id, score: 4, channelType: "WHATSAPP", createdAt: new Date(now - 50 * MINUTE) } });

    // Atendimento 2: ninguém da equipe respondeu; a nota 2 fica sem atendente.
    const second = await conversation();
    await handoff(second.id, now - 30 * MINUTE);
    await admin.rating.create({ data: { tenantId: fx.tenant.id, conversationId: second.id, score: 2, channelType: "WHATSAPP", createdAt: new Date(now - 20 * MINUTE) } });

    // Atendimento 3, há 10 dias: só entra nos últimos 30 dias (resposta em 1 min).
    const old = await conversation();
    await handoff(old.id, now - 10 * DAY);
    await reply(old.id, bruna.id, now - 10 * DAY + MINUTE);

    // Há 2 dias, chegou fora do horário e ninguém respondeu: sem resposta no fim do dia (não conta como passagem à equipe).
    afterHours = await conversation();
    await admin.message.create({
      data: { ...base, conversationId: afterHours.id, direction: "OUTBOUND", type: "TEXT", content: { automation: "after_hours", text: "Fechados" }, status: "READ", createdAt: new Date(now - 2 * DAY) },
    });

    // Há 20 dias, passado à equipe às 23h e respondido só às 9h do dia seguinte: também ficou sem resposta no dia.
    late = await conversation();
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(now - 20 * DAY));
    const lateAt = Date.parse(`${day}T23:00:00-03:00`);
    await handoff(late.id, lateAt);
    await reply(late.id, bruna.id, lateAt + 10 * 60 * MINUTE);
  });
  let afterHours: { id: string };
  let late: { id: string };

  afterAll(async () => {
    await fx?.cleanup();
    if (bruna) await admin.user.deleteMany({ where: { id: bruna.id } });
    await app?.close();
  });

  const report = (token: string, period: string) =>
    request(app.getHttpServer()).get(`/api/reports/ratings?tenantId=${fx.tenant.id}&period=${period}`).set("Authorization", `Bearer ${token}`);

  it("atendente não vê o relatório", async () => {
    const token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    await report(token, "7d").expect(403);
  });

  it("administrador: tempo até a 1ª resposta e nota de quem respondeu por último", async () => {
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    const token = await accessTokenFor(app, fx.user.email, fx.tenant.id);

    const { body } = await report(token, "7d").expect(200);
    expect(body.summary).toEqual({ ratings: 2, averageScore: 3, handoffs: 2, answered: 1, averageResponseSeconds: 120 });
    expect(body.scoreCounts).toEqual([0, 1, 0, 1, 0]);
    expect(body.agents).toEqual([
      { userId: fx.user.id, name: "Atendente Pipeline", ratings: 1, averageScore: 4, answered: 0, averageResponseSeconds: null },
      { userId: bruna.id, name: "Bruna Teste", ratings: 0, averageScore: null, answered: 1, averageResponseSeconds: 120 },
      { userId: null, name: "Sem resposta da equipe", ratings: 1, averageScore: 2, answered: 0, averageResponseSeconds: null },
    ]);
    expect(body.recent.map((r: { score: number; agentName: string | null; contactName: string }) => [r.score, r.agentName, r.contactName])).toEqual([
      [2, null, "Carlos Mendes"],
      [4, "Atendente Pipeline", "Carlos Mendes"],
    ]);

    const month = (await report(token, "30d").expect(200)).body;
    expect(month.summary).toMatchObject({ handoffs: 4, answered: 3, averageResponseSeconds: (120 + 60 + 36_000) / 3 });
  });

  it("sem resposta no fim do dia: chamadas que ninguém da equipe respondeu até 23:59", async () => {
    const token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const week = (await report(token, "7d").expect(200)).body;
    // O atendimento 2 (sem resposta) e o que chegou fora do horário; o atendimento 1 foi respondido no mesmo dia.
    expect(week.unanswered.map((u: { afterHours: boolean; contactName: string }) => [u.afterHours, u.contactName])).toEqual([
      [false, "Carlos Mendes"],
      [true, "Carlos Mendes"],
    ]);
    expect(week.unanswered[1].conversationId).toBe(afterHours.id);

    const month = (await report(token, "30d").expect(200)).body;
    expect(month.unanswered).toHaveLength(3);
    expect(month.unanswered[2]).toMatchObject({ conversationId: late.id, afterHours: false });
  });

  it("todos os restaurantes (painel master): junta os que a pessoa administra, cada linha com o restaurante", async () => {
    const other = await admin.tenant.create({ data: { name: "Outro Restaurante", slug: `outro-${fx.tenant.id}` } });
    const agentOnly = await admin.tenant.create({ data: { name: "Só Atendente", slug: `atendente-${fx.tenant.id}` } });
    try {
      await admin.tenantMember.createMany({
        data: [
          { tenantId: other.id, userId: fx.user.id, role: "ADMIN" },
          { tenantId: agentOnly.id, userId: fx.user.id, role: "AGENT" },
        ],
      });
      const rated = async (tenantId: string, score: number) => {
        const contact = await admin.contact.create({ data: { tenantId, name: `Cliente ${score}` } });
        const channel = await admin.channel.create({ data: { tenantId, type: "WHATSAPP", name: "WhatsApp", externalId: `wa-${tenantId}`, credentials: Buffer.from("x"), status: "CONNECTED" } });
        const conversation = await admin.conversation.create({ data: { tenantId, contactId: contact.id, channelId: channel.id, status: "RESOLVED" } });
        await admin.rating.create({ data: { tenantId, conversationId: conversation.id, score, channelType: "WHATSAPP" } });
      };
      await rated(other.id, 5);
      await rated(agentOnly.id, 1); // só atendente ali: fica de fora

      const token = await accessTokenFor(app, fx.user.email, "master");
      const all = (await request(app.getHttpServer()).get("/api/reports/ratings?tenantId=all&period=7d").set("Authorization", `Bearer ${token}`).expect(200)).body;
      expect(all.summary).toMatchObject({ ratings: 3, handoffs: 2 });
      expect(all.recent.map((r: { tenantId: string; score: number }) => [r.tenantId, r.score])).toEqual([
        [other.id, 5],
        [fx.tenant.id, 2],
        [fx.tenant.id, 4],
      ]);
      expect(all.unanswered.every((u: { tenantId: string }) => u.tenantId === fx.tenant.id)).toBe(true);
    } finally {
      await admin.tenant.deleteMany({ where: { id: { in: [other.id, agentOnly.id] } } });
    }
  });

  it("todos os restaurantes sem administrar nenhum: recusa", async () => {
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "AGENT" } });
    const token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    await request(app.getHttpServer()).get("/api/reports/ratings?tenantId=all&period=7d").set("Authorization", `Bearer ${token}`).expect(403);
  });
});
