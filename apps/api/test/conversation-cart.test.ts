import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

describe("Carrinho da IA na conversa (F4-10)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let token: string; // atendente em A
  let conversationA: string;
  let conversationB: string;
  const get = (id: string, t = token) => request(app.getHttpServer()).get(`/api/conversations/${id}/cart`).set("Authorization", `Bearer ${t}`);
  const enable = (tenantId: string) =>
    admin.tenantModule.upsert({ where: { tenantId_module: { tenantId, module: "MENU" } }, create: { tenantId, module: "MENU" }, update: {} });

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    token = await accessTokenFor(app, fx.user.email, fx.a.id);
    const make = async (tenantId: string) => {
      const channel = await admin.channel.create({
        data: { tenantId, type: "WHATSAPP", name: "WhatsApp", externalId: `cart-${tenantId}`, credentials: new Uint8Array(), status: "CONNECTED" },
      });
      const contact = await admin.contact.create({ data: { tenantId, name: "Cliente" } });
      const conversation = await admin.conversation.create({
        data: { tenantId, contactId: contact.id, channelId: channel.id, status: "OPEN", automationState: { ai: "on" } },
      });
      const menu = await admin.menu.create({ data: { tenantId, name: "Cardápio" } });
      const category = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Pizzas" } });
      const item = await admin.menuItem.create({ data: { tenantId, categoryId: category.id, name: "Pizza Calabresa", priceCents: 5000 } });
      const cart = await admin.cart.create({ data: { tenantId, conversationId: conversation.id, contactId: contact.id } });
      await admin.cartItem.create({ data: { tenantId, cartId: cart.id, itemId: item.id, quantity: 2 } });
      return { conversation: conversation.id, cart: cart.id };
    };
    const [a, b] = await Promise.all([make(fx.a.id), make(fx.b.id)]);
    conversationA = a.conversation;
    conversationB = b.conversation;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("módulo MENU desligado: vazio, sem carrinho", async () => {
    const res = await get(conversationA).expect(200);
    expect(res.body).toEqual({ ai: null, cart: null });
  });

  it("módulo ligado: itens, total e etapa", async () => {
    await enable(fx.a.id);
    const { body } = await get(conversationA).expect(200);
    expect(body.ai).toBe("on");
    expect(body.cart).toMatchObject({ stage: "building", subtotalCents: 10000, totalCents: 10000, pixExpiresAt: null });
    expect(body.cart.items).toEqual([expect.objectContaining({ name: "Pizza Calabresa", quantity: 2, totalCents: 10000 })]);
  });

  it("etapas: aguardando confirmação, aguardando Pix (com validade) e pago", async () => {
    const cart = await admin.cart.findFirstOrThrow({ where: { conversationId: conversationA } });
    await admin.cart.update({ where: { id: cart.id }, data: { status: "AWAITING_CONFIRMATION" } });
    expect((await get(conversationA)).body.cart.stage).toBe("awaiting_confirmation");

    const expiresAt = new Date(Date.now() + 600_000);
    const payment = await admin.payment.create({ data: { tenantId: fx.a.id, cartId: cart.id, provider: "teste", txid: "tx-cart-1", amountCents: 10000, expiresAt } });
    const pix = (await get(conversationA)).body.cart;
    expect(pix.stage).toBe("awaiting_pix");
    expect(pix.pixExpiresAt).toBe(expiresAt.toISOString());

    await admin.payment.update({ where: { id: payment.id }, data: { status: "PAID", paidAt: new Date() } });
    expect((await get(conversationA)).body.cart.stage).toBe("paid");
  });

  it("isolamento: conversa de outro restaurante responde 404", async () => {
    await enable(fx.b.id);
    await get(conversationB).expect(404);
  });

  it("Assumir conversa e Devolver à IA", async () => {
    const post = (on: boolean) =>
      request(app.getHttpServer()).post(`/api/conversations/${conversationA}/cart/ai`).set("Authorization", `Bearer ${token}`).send({ on });
    expect((await post(false).expect(201)).body).toEqual({ ai: "off" });
    expect((await get(conversationA)).body.ai).toBe("off");
    await post(true).expect(201);
    expect((await get(conversationA)).body.ai).toBe("on");
    await request(app.getHttpServer()).post(`/api/conversations/${conversationB}/cart/ai`).set("Authorization", `Bearer ${token}`).send({ on: false }).expect(404);
  });
});
