import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createChannelFixture, createTestApp } from "./helpers.js";

describe("histórico do cliente em todas as fontes de pedido", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let token: string;
  let ifoodContact: string;
  let cardapioContact: string;

  const order = (contactId: string, channelId: string, code: string, total: string, status: "DELIVERED" | "CANCELED" = "DELIVERED") =>
    admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId,
        channelId,
        externalOrderId: `historico-${code}-${randomUUID()}`,
        displayCode: code,
        status,
        subtotal: total,
        deliveryFee: "0.00",
        total,
        placedAt: new Date(),
        raw: {},
      },
    });

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createChannelFixture();
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const cardapioWeb = await admin.channel.create({
      data: { tenantId: fx.tenant.id, type: "CARDAPIO_WEB", name: "Cardápio Web", externalId: `cw-${randomUUID()}`, credentials: Buffer.from("{}"), status: "CONNECTED" },
    });
    // O mesmo cliente em dois cadastros: o do iFood (só CPF) e o do Cardápio Web (telefone e o mesmo CPF).
    ifoodContact = (await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Carlos (iFood)", cpfHash: "cpf-carlos" } })).id;
    cardapioContact = (
      await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Carlos", phone: "+5511970001111", cpfHash: "cpf-carlos" } })
    ).id;
    await order(ifoodContact, fx.ifood.id, "1001", "40.00");
    await order(ifoodContact, fx.ifood.id, "1002", "35.00");
    await order(ifoodContact, fx.ifood.id, "1003", "99.00", "CANCELED"); // cancelado não conta
    await order(cardapioContact, cardapioWeb.id, "2001", "25.00");
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(`/api${path}`).set("Authorization", `Bearer ${token}`).expect(200);

  it("o cadastro soma os pedidos de outros cadastros com o mesmo CPF ou telefone, sem os cancelados", async () => {
    const { body } = await get(`/contacts/${cardapioContact}`);
    expect(body.metrics).toEqual({
      ordersCount: 3,
      ordersTotal: "100.00",
      ordersBySource: [
        { channelType: "IFOOD", orders: 2 },
        { channelType: "CARDAPIO_WEB", orders: 1 },
      ],
    });
    const orders = (await get(`/contacts/${cardapioContact}/orders`)).body as { displayCode: string }[];
    expect(orders.map((o) => o.displayCode).sort()).toEqual(["1001", "1002", "1003", "2001"]);
  });

  it("aba Pedidos: cada pedido traz o histórico do cliente", async () => {
    const { body } = await get("/orders?period=7d");
    const fromCardapio = body.items.find((o: { displayCode: string }) => o.displayCode === "2001");
    expect(fromCardapio.history).toEqual({
      orders: 3,
      total: "100.00",
      bySource: [
        { channelType: "IFOOD", orders: 2 },
        { channelType: "CARDAPIO_WEB", orders: 1 },
      ],
    });
  });
});
