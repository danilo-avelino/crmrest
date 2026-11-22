import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

/** Pedidos do cardápio próprio na aba Pedidos (F3-12): campos do OrderDto, filtro de origem e isolamento. */
describe("Pedidos do cardápio no painel (F3-12)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let token: string;
  const ids: Record<string, string> = {};

  async function place(tenantId: string, key: string, extra: { source?: "MENU" | "PLATFORM"; channelId?: string; scheduledFor?: Date; paymentMethod?: string; raw?: object; items?: object[] } = {}) {
    const contact = await admin.contact.create({ data: { tenantId, name: `Cliente ${key}`, phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}` } });
    const order = await admin.order.create({
      data: {
        tenantId,
        contactId: contact.id,
        channelId: extra.channelId ?? null,
        externalOrderId: randomUUID(),
        displayCode: key,
        source: extra.source ?? "MENU",
        status: "CONFIRMED",
        scheduledFor: extra.scheduledFor ?? null,
        paymentMethod: extra.paymentMethod ?? null,
        subtotal: 56,
        deliveryFee: 5,
        total: 61,
        placedAt: new Date(),
        raw: (extra.raw ?? { source: "menu", orderType: "DELIVERY" }) as object,
        items: {
          create: (extra.items ?? [{ name: "½ Calabresa + ½ Frango (Grande)", quantity: 1, unitPrice: 56, options: ["2× Bacon"], notes: "Sem cebola" }]).map((item) => ({ tenantId, ...item })) as never,
        },
      },
    });
    ids[key] = order.id;
  }

  const list = async (query = "") =>
    (await request(app.getHttpServer()).get(`/api/orders?period=7d${query}`).set("Authorization", `Bearer ${token}`).expect(200)).body as {
      items: { id: string; channelType: string; menu: unknown; items: { name: string }[] }[];
      menuOrigin: boolean;
    };

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    token = await accessTokenFor(app, fx.user.email, fx.a.id);
    await place(fx.a.id, "dinheiro", {
      paymentMethod: "CASH",
      raw: { source: "menu", orderType: "DELIVERY", payment: { method: "cash", changeForCents: 10_000 } },
      scheduledFor: new Date("2026-11-22T22:30:00.000Z"),
    });
    await place(fx.a.id, "retirada", { paymentMethod: "DEBIT_ON_DELIVERY", raw: { source: "menu", orderType: "TAKEOUT", payment: { method: "debit", changeForCents: null } } });
    await place(fx.a.id, "pix", { paymentMethod: "PIX", raw: { source: "menu", orderType: "DELIVERY", origin: "whatsapp_ai", payment: { method: "pix", changeForCents: null } } });
    const ifood = await admin.channel.create({
      data: { tenantId: fx.a.id, type: "IFOOD", name: "iFood", externalId: `ifood-${randomUUID()}`, credentials: Buffer.from("x"), status: "CONNECTED" },
    });
    await place(fx.a.id, "plataforma", { source: "PLATFORM", channelId: ifood.id, raw: { orderType: "DELIVERY" } });
    // Outro restaurante (o atendente não é membro): nunca aparece, nem no filtro.
    await place(fx.c.id, "alheio", { paymentMethod: "CASH", raw: { source: "menu", orderType: "DELIVERY", payment: { method: "cash", changeForCents: 5000 } } });
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("OrderDto do cardápio: pagamento, troco, retirada, agendamento e origem", async () => {
    const { items, menuOrigin } = await list();
    const byId = (key: string) => items.find((order) => order.id === ids[key])!;
    expect(menuOrigin).toBe(true);
    expect(byId("dinheiro")).toMatchObject({
      channelType: "MENU",
      items: [{ name: "½ Calabresa + ½ Frango (Grande)", options: ["2× Bacon"], notes: "Sem cebola" }],
      menu: { takeout: false, scheduledFor: "2026-11-22T22:30:00.000Z", payment: { method: "cash", changeForCents: 10_000 }, origin: "site" },
    });
    expect(byId("retirada").menu).toEqual({ takeout: true, scheduledFor: null, payment: { method: "debit", changeForCents: null }, origin: "site", benefit: null });
    expect(byId("pix").menu).toEqual({ takeout: false, scheduledFor: null, payment: { method: "pix", changeForCents: null }, origin: "whatsapp_ai", benefit: null });
  });

  it("pedido de plataforma não traz o bloco do cardápio", async () => {
    const { items } = await list();
    expect(items.find((order) => order.id === ids.plataforma)!.menu).toBeNull();
  });

  it("filtro de origem MENU: só o cardápio do restaurante, sem o de outro", async () => {
    const { items } = await list("&channel=MENU");
    const found = items.map((order) => order.id).sort();
    expect(found).toEqual([ids.dinheiro, ids.retirada, ids.pix].sort());
    expect(items.every((order) => order.channelType === "MENU")).toBe(true);
    expect(JSON.stringify(items)).not.toContain(ids.alheio!);
  });

  it("filtro Agendados: só os com horário marcado, do que sai primeiro para o último", async () => {
    await place(fx.a.id, "agendado-cedo", { scheduledFor: new Date("2026-11-22T20:00:00.000Z") });
    const { items } = await list("&scheduled=true");
    expect(items.map((order) => order.id)).toEqual([ids["agendado-cedo"], ids.dinheiro]);
  });

  it("canal desconhecido continua recusado", async () => {
    await request(app.getHttpServer()).get("/api/orders?channel=NAO_EXISTE").set("Authorization", `Bearer ${token}`).expect(400);
  });
});
