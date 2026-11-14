import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

describe("Conversas do dia (início da Inbox)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let tenantToken: string;
  let masterToken: string;

  beforeAll(async () => {
    [app, fx] = await Promise.all([createTestApp(), createAuthFixture()]);
    const { a, b } = fx;
    const channel = (tenantId: string) =>
      admin.channel.create({
        data: { tenantId, type: "WHATSAPP", name: "WhatsApp", externalId: `hoje-${tenantId}`, credentials: new Uint8Array(), status: "CONNECTED" },
      });
    const [waA, waB] = await Promise.all([channel(a.id), channel(b.id)]);

    type Msg = { direction: "INBOUND" | "OUTBOUND" | "INTERNAL"; type?: "TEXT" | "SYSTEM"; content?: object; at?: Date; byUser?: boolean };
    const chat = async (tenantId: string, channelId: string, status: "OPEN" | "RESOLVED", messages: Msg[], teamOnly = false, score = 0, legacy = false) => {
      const contact = await admin.contact.create({ data: { tenantId, name: "Cliente" } });
      const conversation = await admin.conversation.create({ data: { tenantId, contactId: contact.id, channelId, status, teamOnly } });
      if (score) {
        await admin.conversationEvaluation.create({
          data: { tenantId, conversationId: conversation.id, resolved: true, score, legacy, model: "jev" },
        });
      }
      await admin.message.createMany({
        data: messages.map((m) => ({
          tenantId,
          conversationId: conversation.id,
          channelId,
          direction: m.direction,
          type: m.type ?? "TEXT",
          content: m.content ?? { text: "oi" },
          sentByUserId: m.byUser ? fx.user.id : null,
          createdAt: m.at ?? secondsAgo(5),
        })),
      });
    };
    const inbound: Msg = { direction: "INBOUND" };
    const handoff: Msg = { direction: "INTERNAL", type: "SYSTEM", content: { event: "handoff", text: "IA passou" }, at: secondsAgo(10) };

    await Promise.all([
      // Resolvida só com a IA: sem a equipe. Nota da IA 90%.
      chat(a.id, waA.id, "RESOLVED", [inbound, { direction: "OUTBOUND" }], false, 90),
      // A equipe respondeu pelo painel, pelo celular ou recebeu o atendimento: com a equipe.
      // A passagem respondida um minuto depois entra no tempo de resposta. Nota da IA 70%.
      chat(
        a.id,
        waA.id,
        "RESOLVED",
        [inbound, { ...handoff, at: secondsAgo(65) }, { direction: "OUTBOUND", byUser: true }],
        false,
        70,
      ),
      // Avaliação antiga (nota de 1 a 5): fica de fora da média.
      chat(a.id, waA.id, "RESOLVED", [inbound, { direction: "OUTBOUND", content: { text: "ok", fromPhone: true } }], false, 2, true),
      chat(a.id, waA.id, "RESOLVED", [inbound, handoff]),
      // Ainda aberta.
      chat(a.id, waA.id, "OPEN", [inbound]),
      // Cliente escreveu ontem e a equipe respondeu ontem; hoje só a IA: conta como hoje, sem a equipe.
      chat(a.id, waA.id, "RESOLVED", [
        { direction: "OUTBOUND", byUser: true, at: secondsAgo(26 * 3600) },
        inbound,
        { direction: "OUTBOUND" },
      ]),
      // Fora do dia: o cliente só escreveu ontem.
      chat(a.id, waA.id, "RESOLVED", [{ direction: "INBOUND", at: secondsAgo(26 * 3600) }]),
      // Só da equipe (alerta de fraude): fica de fora.
      chat(a.id, waA.id, "RESOLVED", [inbound], true),
      // Outro restaurante.
      chat(b.id, waB.id, "RESOLVED", [inbound]),
    ]);

    [tenantToken, masterToken] = await Promise.all([accessTokenFor(app, fx.user.email, a.id), accessTokenFor(app, fx.user.email, "master")]);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const get = (path: string, token: string) => request(app.getHttpServer()).get(`/api${path}`).set("Authorization", `Bearer ${token}`);

  it("conta as conversas em que o cliente escreveu hoje e as resolvidas sem a equipe", async () => {
    expect((await get("/conversations/today", tenantToken).expect(200)).body).toEqual({
      opened: 6,
      resolved: 5,
      resolvedWithoutTeam: 2,
      calledTeam: 2,
      averageResponseSeconds: expect.closeTo(60, 0), // a passagem sem resposta não entra na média
      evaluations: 2,
      aiScore: 80,
    });
  });

  it("no painel master junta os restaurantes e filtra por um deles", async () => {
    expect((await get("/conversations/today", masterToken).expect(200)).body).toMatchObject({ opened: 7, resolved: 6, resolvedWithoutTeam: 3 });
    expect((await get(`/conversations/today?tenantId=${fx.b.id}`, masterToken).expect(200)).body).toEqual({
      opened: 1,
      resolved: 1,
      resolvedWithoutTeam: 1,
      calledTeam: 0,
      averageResponseSeconds: null,
      evaluations: 0,
      aiScore: null,
    });
    await get(`/conversations/today?tenantId=${fx.c.id}`, masterToken).expect(403);
  });
});
