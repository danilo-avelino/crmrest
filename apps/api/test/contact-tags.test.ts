import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurveyService } from "../src/automations/survey.service.js";
import { refreshContactTags } from "../src/contacts/contact-tags.service.js";
import { DatabaseService } from "../src/core/database.service.js";
import { admin, createChannelFixture, createTestApp, drainQueues } from "./helpers.js";

const DAY = 24 * 60 * 60_000;

// Sempre por restaurante: o banco é o mesmo do desenvolvimento, e o job de todos mexeria nos cadastros de lá.
describe("tags automáticas dos clientes", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let other: { id: string };
  const now = new Date();
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

  const contact = (name: string, data: { tags?: string[]; deletedAt?: Date } = {}) =>
    admin.contact.create({ data: { tenantId: fx.tenant.id, name, ...data } });
  const order = (contactId: string, placedAt: Date, status: "DELIVERED" | "CANCELED" = "DELIVERED") =>
    admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId,
        channelId: fx.ifood.id,
        externalOrderId: randomUUID(),
        status,
        subtotal: "50.00",
        deliveryFee: "0",
        total: "50.00",
        placedAt,
        raw: {},
      },
    });
  const chat = (contactId: string) =>
    admin.conversation.create({ data: { tenantId: fx.tenant.id, contactId, channelId: fx.whatsapp.id, status: "RESOLVED" } });
  const rate = (conversationId: string, score: number, createdAt: Date) =>
    admin.rating.create({ data: { tenantId: fx.tenant.id, conversationId, score, createdAt } });
  const refresh = () => app.get(DatabaseService).withTenants({ tenantIds: [fx.tenant.id] }, (tx) => refreshContactTags(tx, now));
  const tagsOf = async (id: string) => (await admin.contact.findUniqueOrThrow({ where: { id } })).tags;

  let fiel: { id: string };
  let chateada: { id: string };
  let chateadaChat: { id: string };

  beforeAll(async () => {
    [app, fx] = await Promise.all([createTestApp(), createChannelFixture()]);
    other = await admin.tenant.create({ data: { name: "Outro Restaurante", slug: `outro-${randomUUID()}` } });
  });

  afterAll(async () => {
    await admin.tenant.deleteMany({ where: { id: other.id } });
    await fx?.cleanup();
    await app?.close();
  });

  it("calcula VIP, Recorrente, Novo, Sumido e Insatisfeito, mantém as manuais e tira o resto", async () => {
    // 9 clientes com pedido: os 10% com mais pedidos são 1 cliente.
    fiel = await contact("Fiel");
    for (const days of [200, 80, 40, 10]) await order(fiel.id, daysAgo(days));
    const novo = await contact("Novo");
    await order(novo.id, daysAgo(5));
    const sumido = await contact("Sumido");
    await order(sumido.id, daysAgo(100));
    // O pedido cancelado não conta: não é a primeira compra nem tira o cliente de Sumido.
    await order(sumido.id, daysAgo(2), "CANCELED");
    const comuns = await Promise.all(["A", "B", "C", "D", "E", "F"].map((letter) => contact(`Comum ${letter}`)));
    for (const comum of comuns) await order(comum.id, daysAgo(45));

    const soCancelou = await contact("Só cancelou");
    await order(soCancelou.id, daysAgo(1), "CANCELED");
    const semPedido = await contact("Sem pedido", { tags: ["sem glúten", "Entregador"] });
    chateada = await contact("Chateada", { tags: ["Cancelamento recorrente"] });
    chateadaChat = await chat(chateada.id);
    await rate(chateadaChat.id, 5, daysAgo(20));
    await rate(chateadaChat.id, 2, daysAgo(3)); // vale a última nota
    // Anonimizado: mesmo com mais pedidos que todos, não entra na conta dos VIPs.
    const anonimizado = await contact("", { deletedAt: daysAgo(1) });
    for (const days of [50, 40, 30, 20, 10]) await order(anonimizado.id, daysAgo(days));
    const deFora = await admin.contact.create({ data: { tenantId: other.id, name: "De fora", tags: ["manual"] } });

    await refresh();

    expect(await tagsOf(fiel.id)).toEqual(["VIP", "Recorrente"]);
    expect(await tagsOf(novo.id)).toEqual(["Novo"]);
    expect(await tagsOf(sumido.id)).toEqual(["Sumido"]);
    expect(await tagsOf(comuns[0]!.id)).toEqual([]);
    expect(await tagsOf(soCancelou.id)).toEqual([]);
    expect(await tagsOf(semPedido.id)).toEqual(["Entregador"]);
    expect(await tagsOf(chateada.id)).toEqual(["Cancelamento recorrente", "Insatisfeito"]);
    expect(await tagsOf(anonimizado.id)).toEqual([]);
    expect(await tagsOf(deFora.id)).toEqual(["manual"]); // outro restaurante
  });

  it("VIP nunca passa dos 10%: clientes empatados entram todos ou nenhum", async () => {
    const empatado = await contact("Empatado");
    for (const days of [300, 250, 200, 150]) await order(empatado.id, daysAgo(days));
    await refresh();
    // 10 clientes com pedido: cabe 1 VIP, e dois têm 4 pedidos.
    expect(await tagsOf(fiel.id)).toEqual(["Recorrente"]);
    expect(await tagsOf(empatado.id)).toEqual(["Sumido"]);

    await order(fiel.id, daysAgo(1));
    await refresh();
    expect(await tagsOf(fiel.id)).toEqual(["VIP", "Recorrente"]);
  });

  it("a nota da pesquisa põe e tira Insatisfeito na hora", async () => {
    const survey = app.get(SurveyService);
    const answer = async (text: string) => {
      await admin.conversation.update({ where: { id: chateadaChat.id }, data: { automationState: { survey: "awaiting_rating" } } });
      const channel = { id: fx.whatsapp.id, tenantId: fx.tenant.id, type: "WHATSAPP" as const };
      await survey.handleAnswer({ channel, conversationId: chateadaChat.id, previousStatus: "RESOLVED", newAttendance: false, text });
      await drainQueues(app);
    };

    await answer("5");
    expect(await tagsOf(chateada.id)).toEqual(["Cancelamento recorrente"]);
    await answer("1");
    expect(await tagsOf(chateada.id)).toEqual(["Cancelamento recorrente", "Insatisfeito"]);
  });

  it("o job lista só os restaurantes ativos", async () => {
    await admin.tenant.update({ where: { id: other.id }, data: { status: "SUSPENDED" } });
    const rows = await admin.$queryRaw<{ id: string }[]>`SELECT id FROM app.active_tenants()`;
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(fx.tenant.id);
    expect(ids).not.toContain(other.id);
  });
});
