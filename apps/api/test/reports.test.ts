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
    await admin.rating.create({ data: { tenantId: fx.tenant.id, conversationId: first.id, score: 4, createdAt: new Date(now - 50 * MINUTE) } });

    // Atendimento 2: ninguém da equipe respondeu; a nota 2 fica sem atendente.
    const second = await conversation();
    await handoff(second.id, now - 30 * MINUTE);
    await admin.rating.create({ data: { tenantId: fx.tenant.id, conversationId: second.id, score: 2, createdAt: new Date(now - 20 * MINUTE) } });

    // Atendimento 3, há 10 dias: só entra nos últimos 30 dias (resposta em 1 min).
    const old = await conversation();
    await handoff(old.id, now - 10 * DAY);
    await reply(old.id, bruna.id, now - 10 * DAY + MINUTE);
  });

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
    expect(month.summary).toMatchObject({ handoffs: 3, answered: 2, averageResponseSeconds: 90 });
  });
});
