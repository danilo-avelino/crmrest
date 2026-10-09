import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createChannelFixture, createTestApp } from "./helpers.js";

const MINUTE = 60_000;
const clock = (date: Date) =>
  new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(
    new Date(Math.ceil(date.getTime() / (5 * MINUTE)) * 5 * MINUTE),
  );

describe("previsão de saída do pedido (E26)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let token: string;
  let contactId: string;
  let sequence = 0;

  /** Pedido do iFood confirmado há `confirmedAgo` minutos; com `tookMinutes`, já saiu do restaurante. */
  const order = async (confirmedAgo: number, tookMinutes?: number) => {
    const now = Date.now();
    const confirmedAt = new Date(now - confirmedAgo * MINUTE);
    sequence += 1;
    return admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId,
        channelId: fx.ifood.id,
        externalOrderId: `previsao-${sequence}-${now}`,
        displayCode: String(1000 + sequence),
        status: tookMinutes ? "DISPATCHED" : "PREPARING",
        subtotal: "30.00",
        deliveryFee: "0.00",
        total: "30.00",
        placedAt: new Date(confirmedAt.getTime() - MINUTE),
        dispatchedAt: tookMinutes ? new Date(confirmedAt.getTime() + tookMinutes * MINUTE) : null,
        raw: {},
        events: { create: { tenantId: fx.tenant.id, externalEventId: `cfm-${sequence}`, code: "CONFIRMED", occurredAt: confirmedAt } },
      },
    });
  };
  const forecast = async (id: string) =>
    (await request(app.getHttpServer()).get(`/api/orders/${id}/forecast`).set("Authorization", `Bearer ${token}`).expect(200)).body.text as
      | string
      | null;

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createChannelFixture();
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    contactId = (await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Carlos Mendes" } })).id;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("sem pedidos que já saíram, não há base para prever", async () => {
    const pending = await order(5);
    expect(await forecast(pending.id)).toBeNull();
    await admin.order.delete({ where: { id: pending.id } });
  });

  it("no prazo: confirmação + mediana dos últimos pedidos que saíram, com a fila na frente", async () => {
    // Já saíram (confirmado → saída): 10, 12, 14, 30 e 40 min. Mediana: 14 min.
    for (const took of [10, 12, 14, 30, 40]) await order(120 + took, took);
    await order(8); // na cozinha, feito antes: fica na frente
    const current = await order(5);
    const expected = new Date(Date.now() - 5 * MINUTE + 14 * MINUTE);
    expect(await forecast(current.id)).toBe(
      [`⏱️ Previsão de saída do restaurante: por volta das ${clock(expected)}.`, "Há 1 pedido na sua frente na cozinha."].join("\n"),
    );
  });

  it("atrasado: pede desculpas e usa só os pedidos que demoraram mais que ele", async () => {
    const late = await order(20); // já passou dos 14 min; mais demorados: 30 e 40 → 35 min
    const text = await forecast(late.id);
    expect(text).toMatch(/^Pedimos desculpas pela demora! 🙏/);
    expect(text).toContain(`Nova previsão de saída do restaurante: por volta das ${clock(new Date(Date.now() - 20 * MINUTE + 35 * MINUTE))}.`);
  });

  it("com horário prometido pelo iFood: só pede desculpas se a previsão passar da promessa", async () => {
    const promise = (minutes: number) => ({ delivery: { deliveryDateTime: new Date(Date.now() + minutes * MINUTE).toISOString() } });
    // Mais lento que o normal (20 min > 14), mas a saída prevista (+15 min) fica antes da entrega prometida (+30 min).
    const slow = await order(20);
    await admin.order.update({ where: { id: slow.id }, data: { raw: promise(30) } });
    expect(await forecast(slow.id)).toMatch(/^⏱️ Previsão de saída do restaurante: por volta das \d{2}:\d{2}\./);

    // A saída prevista (+15 min) passa da entrega prometida (+5 min): desculpas.
    const late = await order(20);
    await admin.order.update({ where: { id: late.id }, data: { raw: promise(5) } });
    expect(await forecast(late.id)).toMatch(/^Pedimos desculpas pela demora! 🙏/);
  });

  it("mais atrasado que todos: agora + 10 min (nunca um horário que já passou)", async () => {
    const veryLate = await order(60);
    const text = await forecast(veryLate.id);
    expect(text).toContain(`por volta das ${clock(new Date(Date.now() + 10 * MINUTE))}.`);
  });

  it("pedido sem sair há mais de 4 h (status não atualizado na plataforma): sem previsão", async () => {
    const stale = await order(5 * 60);
    expect(await forecast(stale.id)).toBeNull();
  });

  it("sem a fila quando o restaurante desliga", async () => {
    await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: { orderForecast: { showQueue: false } } } });
    const current = await order(3);
    expect(await forecast(current.id)).not.toContain("na sua frente");
  });

  it("pedido que já saiu: diz quando saiu e há quanto tempo; entregue, nada a dizer", async () => {
    const dispatched = await order(30, 17); // saiu há 13 minutos
    const departedAt = new Date(Date.now() - 13 * MINUTE);
    const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(departedAt);
    expect(await forecast(dispatched.id)).toBe(`🛵 Seu pedido já saiu para entrega às ${time} (13 minutos atrás).`);

    await admin.order.update({ where: { id: dispatched.id }, data: { status: "DELIVERED" } });
    expect(await forecast(dispatched.id)).toBeNull();
  });

  it("painel da Inbox: acha o pedido pelo cadastro da conversa, com observações, entrega prometida e previsão", async () => {
    const conversation = await admin.conversation.create({
      data: { tenantId: fx.tenant.id, contactId, channelId: fx.whatsapp.id, status: "OPEN" },
    });
    const promised = new Date(Date.now() + 40 * MINUTE);
    const latest = await order(2);
    await admin.order.update({
      where: { id: latest.id },
      data: {
        raw: { extraInfo: "Sem cebola, por favor", delivery: { deliveryDateTime: promised.toISOString(), observations: "Portão azul" } },
        items: { create: { tenantId: fx.tenant.id, name: "Pizza Margherita G", quantity: 1, unitPrice: "30.00", notes: "Borda recheada" } },
      },
    });

    const { body } = await request(app.getHttpServer())
      .get(`/api/orders/current?conversationId=${conversation.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(body.current).toMatchObject({
      order: { id: latest.id, items: [{ name: "Pizza Margherita G", notes: "Borda recheada" }] },
      notes: ["Sem cebola, por favor", "Portão azul"],
      promisedAt: promised.toISOString(),
      forecast: { late: false, departAt: expect.any(String) },
    });
    // O andamento conta da confirmação (2 min atrás).
    expect(Math.abs(Date.parse(body.current.startedAt) - (Date.now() - 2 * MINUTE))).toBeLessThan(10_000);

    const other = await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Sem pedidos" } });
    const empty = await admin.conversation.create({ data: { tenantId: fx.tenant.id, contactId: other.id, channelId: fx.whatsapp.id, status: "OPEN" } });
    const none = await request(app.getHttpServer())
      .get(`/api/orders/current?conversationId=${empty.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(none.body).toEqual({ current: null });
  });
});
