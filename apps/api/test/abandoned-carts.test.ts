import { randomUUID } from "node:crypto";
import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import { fillMessage, PERSONALITY_MESSAGES } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const HOUR = 60 * 60 * 1000;

describe("Carrinhos abandonados e recuperação (F7-07)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let adminToken: string;
  let agentToken: string;
  let pizza = "";
  let size = "";
  let channelId = "";

  /** Carrinho da IA numa conversa, parado há `idleHours`, com a última mensagem do cliente há `inboundHours`. */
  async function cartOf(name: string, idleHours: number, inboundHours: number) {
    const contact = await admin.contact.create({ data: { tenantId: fx.b.id, name, phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}` } });
    const conversation = await admin.conversation.create({ data: { tenantId: fx.b.id, contactId: contact.id, channelId, status: "OPEN" } });
    await admin.message.create({
      data: { tenantId: fx.b.id, conversationId: conversation.id, channelId, direction: "INBOUND", type: "TEXT", content: { text: "quero pizza" }, status: "DELIVERED", createdAt: new Date(Date.now() - inboundHours * HOUR) },
    });
    const cart = await admin.cart.create({
      data: { tenantId: fx.b.id, contactId: contact.id, conversationId: conversation.id, items: { create: { tenantId: fx.b.id, itemId: pizza, sizeId: size, quantity: 2 } } },
    });
    await admin.$executeRaw`UPDATE carts SET updated_at = ${new Date(Date.now() - idleHours * HOUR)} WHERE id = ${cart.id}::uuid`;
    return { cart, conversation };
  }

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
    await admin.tenant.update({ where: { id: fx.b.id }, data: { settings: { personality: "jovial" } } });
    const menu = await admin.menu.create({ data: { tenantId: fx.b.id, name: "Cardápio" } });
    const category = await admin.menuCategory.create({ data: { tenantId: fx.b.id, menuId: menu.id, name: "Pizzas" } });
    const item = await admin.menuItem.create({
      data: { tenantId: fx.b.id, categoryId: category.id, name: "Calabresa", sizes: { create: [{ tenantId: fx.b.id, name: "G", priceCents: 5000 }] } },
      include: { sizes: true },
    });
    pizza = item.id;
    size = item.sizes[0]!.id;
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
    channelId = (
      await admin.channel.create({
        data: { tenantId: fx.b.id, type: "WHATSAPP", name: "WhatsApp", externalId: `wa-${randomUUID()}`, credentials: encrypt(JSON.stringify({ accessToken: "t", instance: `i-${randomUUID()}` }), key), status: "CONNECTED" },
      })
    ).id;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const list = (tenantId: string, token: string) => request(app.getHttpServer()).get(`/api/menu/${tenantId}/abandoned-carts`).set("Authorization", `Bearer ${token}`);
  const recover = (cartId: string) => request(app.getHttpServer()).post(`/api/menu/${fx.b.id}/abandoned-carts/${cartId}/recover`).set("Authorization", `Bearer ${adminToken}`);

  it("sem o módulo Cardápio é recusado; atendente não vê", async () => {
    await list(fx.b.id, adminToken).expect(403);
    await admin.tenantModule.create({ data: { tenantId: fx.b.id, module: "MENU" } });
    await list(fx.a.id, agentToken).expect(403);
  });

  it("lista o carrinho parado com o valor do cardápio, a janela e sem o recente nem o velho demais", async () => {
    const parado = await cartOf("Ana Souza", 2, 3);
    await cartOf("Recente", 0.1, 0.1);
    await cartOf("Velho", 24 * 8, 24 * 8);
    const res = await list(fx.b.id, adminToken).expect(200);
    expect(res.body.map((c: { customerName: string }) => c.customerName)).toEqual(["Ana Souza"]);
    expect(res.body[0]).toMatchObject({ id: parado.cart.id, stage: "building", items: ["2× Calabresa G"], subtotalCents: 10_000, windowOpen: true, recoverySentAt: null });
  });

  it("recuperação: manda a mensagem no tom da loja uma vez só; fora da janela de 24 h, recusa", async () => {
    const { cart, conversation } = await cartOf("Bruno Lima", 3, 5);
    await recover(cart.id).expect(200);
    const message = await admin.message.findFirstOrThrow({ where: { conversationId: conversation.id, direction: "OUTBOUND" } });
    expect(message.content).toMatchObject({ automation: "menu_cart_recovery", text: fillMessage(PERSONALITY_MESSAGES.jovial.menuCartRecovery, { nome: "Bruno" }) });
    expect((await recover(cart.id).expect(409)).body.message).toContain("já foi mandada");

    const fechada = await cartOf("Carla", 30, 30);
    expect((await recover(fechada.cart.id).expect(409)).body.message).toContain("24 h");
    await recover(randomUUID()).expect(404);
  });
});
