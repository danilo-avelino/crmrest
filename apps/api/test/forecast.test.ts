import type { OrderStageCounts } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseService } from "../src/core/database.service.js";
import { forecastOrder } from "../src/orders/forecast.js";
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
    // A partir da confirmação gravada (placedAt + 1 min), não de outro Date.now(): o arredondamento de 5 em 5 minutos
    // daria outro horário se os dois instantes caíssem em lados opostos de uma virada.
    const expected = new Date(current.placedAt.getTime() + MINUTE + 14 * MINUTE);
    expect(await forecast(current.id)).toBe(
      [`⏱️ Previsão de saída do restaurante: por volta das ${clock(expected)}.`, "Há 1 pedido na sua frente na cozinha."].join("\n"),
    );
  });

  it("a fila soma os pedidos na cozinha de todas as integrações e não para na meia-noite", async () => {
    // 0h05 em Brasília (data longe de agora, para os pedidos dos outros testes ficarem de fora): o pedido do Cardápio
    // Web das 23h55 (confirmado: lá não há etapa de preparo) e o do iFood das 23h58 estão na cozinha, na frente do
    // pedido do iFood da 0h03. O pronto, à espera do entregador, e o ainda não aceito ficam fora da fila.
    const now = new Date("2026-01-15T03:05:00Z");
    const cardapio = await admin.channel.create({
      data: { tenantId: fx.tenant.id, type: "CARDAPIO_WEB", name: "Cardápio Web", externalId: `cw-${Date.now()}`, credentials: Buffer.from("-"), status: "CONNECTED" },
    });
    const placed = (channelId: string, minutesAgo: number, status: "PLACED" | "CONFIRMED" | "PREPARING" | "READY" = "PREPARING") => {
      sequence += 1;
      return admin.order.create({
        data: {
          tenantId: fx.tenant.id,
          contactId,
          channelId,
          externalOrderId: `fila-${sequence}-${Date.now()}`,
          displayCode: String(2000 + sequence),
          status,
          subtotal: "30.00",
          deliveryFee: "0.00",
          total: "30.00",
          placedAt: new Date(now.getTime() - minutesAgo * MINUTE),
          raw: {},
        },
      });
    };
    await placed(cardapio.id, 10, "CONFIRMED");
    await placed(fx.ifood.id, 7);
    await placed(fx.ifood.id, 9, "READY");
    await placed(cardapio.id, 4, "PLACED");
    const current = await placed(fx.ifood.id, 2);

    const result = await app.get(DatabaseService).withTenants({ tenantIds: [fx.tenant.id] }, (tx) => forecastOrder(tx, current.id, now));
    expect(result?.ahead).toBe(2);
  });

  it("atrasado: pede desculpas e usa só os pedidos que demoraram mais que ele", async () => {
    const late = await order(20); // já passou dos 14 min; mais demorados: 30 e 40 → 35 min
    const text = await forecast(late.id);
    expect(text).toMatch(/^Pedimos desculpas pela demora! 🙏/);
    expect(text).toContain(`Nova previsão de saída do restaurante: por volta das ${clock(new Date(late.placedAt.getTime() + MINUTE + 35 * MINUTE))}.`);
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

  it("barra da Inbox: só os pedidos em produção, do mais antigo para o mais novo, com o alerta de atraso", async () => {
    const onTime = await order(1); // dentro do tempo normal de saída
    const late = await order(45); // passou do tempo normal, sem entrega prometida

    const { body } = await request(app.getHttpServer())
      .get("/api/orders?period=7d&production=true")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const items = body.items as { id: string; status: string; placedAt: string; late: boolean }[];
    expect(items.every((item) => ["PLACED", "CONFIRMED", "PREPARING", "READY"].includes(item.status))).toBe(true);
    const placed = items.map((item) => Date.parse(item.placedAt));
    expect(placed).toEqual([...placed].sort((a, b) => a - b));
    expect(items.find((item) => item.id === late.id)?.late).toBe(true);
    expect(items.find((item) => item.id === onTime.id)?.late).toBe(false);
  });

  it("faixa recolhida da Inbox: pedidos de hoje por etapa, sem os cancelados", async () => {
    const stages = async () =>
      (await request(app.getHttpServer()).get("/api/orders/stages").set("Authorization", `Bearer ${token}`).expect(200)).body as OrderStageCounts;
    const before = await stages();
    await order(1); // em produção
    const ready = await order(1);
    await admin.order.update({ where: { id: ready.id }, data: { status: "READY" } });
    await order(5, 2); // saiu
    const delivered = await order(5, 2);
    await admin.order.update({ where: { id: delivered.id }, data: { status: "DELIVERED" } });
    const canceled = await order(1);
    await admin.order.update({ where: { id: canceled.id }, data: { status: "CANCELED" } });

    const after = await stages();
    expect({
      production: after.production - before.production,
      ready: after.ready - before.ready,
      dispatched: after.dispatched - before.dispatched,
      delivered: after.delivered - before.delivered,
    }).toEqual({ production: 1, ready: 1, dispatched: 1, delivered: 1 });
  });

  it("retirada pronta: à espera do cliente, sem saída prevista nem atraso; o andamento para no pronto", async () => {
    const conversation = await admin.conversation.create({
      data: { tenantId: fx.tenant.id, contactId, channelId: fx.whatsapp.id, status: "OPEN" },
    });
    const takeout = await order(0); // o mais recente do cliente: é o que o painel mostra
    const readyAt = new Date(Date.now() - 30_000);
    const past = new Date(Date.now() - 5 * MINUTE).toISOString();
    await admin.order.update({
      where: { id: takeout.id },
      data: {
        status: "READY",
        raw: { orderType: "TAKEOUT", takeout: { takeoutDateTime: past } }, // retirada prometida já passou
        events: { create: { tenantId: fx.tenant.id, externalEventId: `rtp-${takeout.id}`, code: "READY_TO_PICKUP", occurredAt: readyAt } },
      },
    });
    const get = (path: string) => request(app.getHttpServer()).get(`/api${path}`).set("Authorization", `Bearer ${token}`).expect(200);

    expect(await forecast(takeout.id)).toBe(`✅ Seu pedido #${takeout.displayCode} ficou pronto!`);
    const { body } = await get(`/orders/current?conversationId=${conversation.id}`);
    expect(body.current).toMatchObject({ order: { id: takeout.id }, takeout: true, readyAt: readyAt.toISOString(), forecast: null });
    const list = await get("/orders?period=7d&production=true");
    expect((list.body.items as { id: string; late: boolean }[]).find((item) => item.id === takeout.id)?.late).toBe(false);

    // Na entrega, o pronto aparece no andamento, mas o pedido ainda espera a saída: segue com previsão e atraso.
    await admin.order.update({ where: { id: takeout.id }, data: { raw: { orderType: "DELIVERY", delivery: { deliveryDateTime: past } } } });
    const delivery = await get(`/orders/current?conversationId=${conversation.id}`);
    expect(delivery.body.current).toMatchObject({ takeout: false, readyAt: readyAt.toISOString(), forecast: { late: true } });
    const deliveryList = await get("/orders?period=7d&production=true");
    expect((deliveryList.body.items as { id: string; late: boolean }[]).find((item) => item.id === takeout.id)?.late).toBe(true);
    await admin.order.delete({ where: { id: takeout.id } });
  });
});
