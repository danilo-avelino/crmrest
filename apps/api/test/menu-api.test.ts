import { createPrismaClient, encrypt, parseEncryptionKey, withTenants } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { topItems } from "../src/menu/menu-stats.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

describe("Cardápio: API do painel (F2-05) e mais vendidos (F2-11)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let agentToken: string; // atendente em A
  let adminToken: string; // administrador em B
  const url = (tenantId: string, path = "") => `/api/menu/${tenantId}${path}`;
  const call = (method: "get" | "post" | "put" | "patch" | "delete", tenantId: string, path: string, token = adminToken) =>
    request(app.getHttpServer())[method](url(tenantId, path)).set("Authorization", `Bearer ${token}`);

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const enable = (tenantId: string) => admin.tenantModule.upsert({ where: { tenantId_module: { tenantId, module: "MENU" } }, create: { tenantId, module: "MENU" }, update: {} });

  it("sem o módulo MENU, leitura e escrita respondem 403", async () => {
    await call("get", fx.b.id, "").expect(403);
    await call("post", fx.b.id, "/categories").send({ name: "Pizzas" }).expect(403);
    expect(await admin.menuCategory.count({ where: { tenantId: fx.b.id } })).toBe(0);
  });

  describe("com o módulo ligado", () => {
    beforeAll(async () => {
      await enable(fx.a.id);
      await enable(fx.b.id);
    });

    it("categorias: cria, edita, ordena e apaga; o cardápio nasce no primeiro uso", async () => {
      expect((await call("get", fx.b.id, "").expect(200)).body.menu).toBeNull();
      const pizzas = (await call("post", fx.b.id, "/categories").send({ name: "Pizzas", allowsHalf: true, halfPricing: "AVERAGE" }).expect(201)).body;
      const bebidas = (await call("post", fx.b.id, "/categories").send({ name: "Bebidas" }).expect(201)).body;
      expect(pizzas).toMatchObject({ tenantId: fx.b.id, name: "Pizzas", sortOrder: 0, allowsHalf: true, halfPricing: "AVERAGE" });
      expect(bebidas.sortOrder).toBe(1);

      await call("patch", fx.b.id, `/categories/${bebidas.id}`).send({ description: "Geladas" }).expect(200);
      await call("put", fx.b.id, "/categories/order").send({ ids: [bebidas.id, pizzas.id] }).expect(204);
      const tree = (await call("get", fx.b.id, "").expect(200)).body;
      expect(tree.categories.map((c: { name: string; description: string | null }) => [c.name, c.description])).toEqual([
        ["Bebidas", "Geladas"],
        ["Pizzas", null],
      ]);

      await call("put", fx.b.id, `/categories/${pizzas.id}/availability`)
        .send({ slots: [{ weekday: 5, startMinute: 1080, endMinute: 1439 }] })
        .expect(200);
      await call("put", fx.b.id, `/categories/${pizzas.id}/availability`)
        .send({ slots: [{ weekday: 7, startMinute: 0, endMinute: 10 }] })
        .expect(400);
      await call("delete", fx.b.id, `/categories/${bebidas.id}`).expect(204);
    });

    it("itens: todos os campos da IA, tamanhos, complementos, horários, combina com, duplicar, esgotado e arquivar", async () => {
      const category = (await call("get", fx.b.id, "").expect(200)).body.categories[0];
      const create = (body: object) => call("post", fx.b.id, "/items").send(body);

      await create({ categoryId: category.id, name: "  " }).expect(400);
      const item = (
        await create({
          categoryId: category.id,
          name: "Calabresa",
          description: "Linguiça e cebola",
          ingredients: ["linguiça", "cebola", "linguiça"],
          allergens: ["glúten"],
          servesPeople: 2,
          tags: ["mais pedido"],
          synonyms: ["calabreza"],
          aiNotes: "Não oferecer com borda de catupiry",
        }).expect(201)
      ).body;
      expect(item).toMatchObject({
        name: "Calabresa",
        priceCents: null,
        ingredients: ["linguiça", "cebola"],
        allergens: ["glúten"],
        servesPeople: 2,
        synonyms: ["calabreza"],
        aiNotes: "Não oferecer com borda de catupiry",
        active: true,
        soldOut: false,
      });
      const mussarela = (await create({ categoryId: category.id, name: "Mussarela", priceCents: 4500 }).expect(201)).body;

      // PATCH parcial não zera o que não veio.
      const patched = (await call("patch", fx.b.id, `/items/${item.id}`).send({ description: null, priceCents: 3000 }).expect(200)).body;
      expect(patched).toMatchObject({ description: null, priceCents: 3000, name: "Calabresa", tags: ["mais pedido"], allergens: ["glúten"] });

      const sizes = (
        await call("put", fx.b.id, `/items/${item.id}/sizes`)
          .send({ sizes: [{ name: "Broto", priceCents: 2500 }, { name: "Grande", priceCents: 5000 }] })
          .expect(200)
      ).body;
      expect(sizes.map((s: { name: string; sortOrder: number }) => [s.name, s.sortOrder])).toEqual([["Broto", 0], ["Grande", 1]]);
      await call("put", fx.b.id, `/items/${item.id}/sizes`).send({ sizes: [{ name: "a", priceCents: 1 }, { name: "A", priceCents: 2 }] }).expect(400);

      const group = (await call("post", fx.b.id, "/option-groups").send({ name: "Borda", minSelect: 0, maxSelect: 1 }).expect(201)).body;
      await call("post", fx.b.id, "/option-groups").send({ name: "Ruim", minSelect: 3, maxSelect: 1 }).expect(400);
      await call("patch", fx.b.id, `/option-groups/${group.id}`).send({ minSelect: 5 }).expect(400); // passa do máximo atual
      const option = (await call("post", fx.b.id, `/option-groups/${group.id}/options`).send({ name: "Catupiry", priceCents: 800 }).expect(201)).body;
      expect(option).toMatchObject({ groupId: group.id, priceCents: 800, active: true, soldOut: false });
      await call("patch", fx.b.id, `/options/${option.id}`).send({ soldOut: true }).expect(200);

      await call("post", fx.b.id, `/items/${item.id}/option-groups/${group.id}`).expect(200);
      await call("post", fx.b.id, `/items/${item.id}/option-groups/${group.id}`).expect(200); // idempotente
      expect(await admin.menuItemOptionGroup.count({ where: { itemId: item.id } })).toBe(1);
      await call("delete", fx.b.id, `/items/${item.id}/option-groups/${group.id}`).expect(204);
      expect(await admin.menuItemOptionGroup.count({ where: { itemId: item.id } })).toBe(0);
      await call("put", fx.b.id, `/items/${item.id}/option-groups`).send({ groupIds: [group.id] }).expect(200);

      await call("put", fx.b.id, `/items/${item.id}/availability`).send({ slots: [{ weekday: 1, startMinute: 600, endMinute: 900 }] }).expect(200);
      await call("put", fx.b.id, `/items/${item.id}/pairings`).send({ itemIds: [mussarela.id] }).expect(200);
      await call("put", fx.b.id, `/items/${item.id}/pairings`).send({ itemIds: [item.id] }).expect(400);

      const copy = (await call("post", fx.b.id, `/items/${item.id}/duplicate`).expect(201)).body;
      expect(copy).toMatchObject({ name: "Calabresa (cópia)", ingredients: ["linguiça", "cebola"], sortOrder: 2 });
      expect(copy.id).not.toBe(item.id);
      expect(copy.sizes.map((s: { name: string }) => s.name)).toEqual(["Broto", "Grande"]);
      expect(copy.optionGroups).toHaveLength(1);
      expect(copy.availabilities).toHaveLength(1);
      expect(copy.pairsWith).toEqual([{ pairedItemId: mussarela.id }]);

      expect((await call("put", fx.b.id, `/items/${item.id}/sold-out`).send({ soldOut: true }).expect(200)).body).toEqual({ id: item.id, soldOut: true });
      expect((await call("post", fx.b.id, `/items/${item.id}/archive`).expect(200)).body).toEqual({ id: item.id, active: false });
      expect((await call("post", fx.b.id, `/items/${item.id}/unarchive`).expect(200)).body).toEqual({ id: item.id, active: true });

      await call("put", fx.b.id, `/categories/${category.id}/items/order`).send({ ids: [copy.id, mussarela.id, item.id] }).expect(204);
      const tree = (await call("get", fx.b.id, "").expect(200)).body;
      expect(tree.categories[0].items.map((i: { id: string }) => i.id)).toEqual([copy.id, mussarela.id, item.id]);
      expect(tree.optionGroups[0].options).toHaveLength(1);

      await call("delete", fx.b.id, `/items/${copy.id}`).expect(204);
      await call("delete", fx.b.id, `/options/${option.id}`).expect(204);
      await call("delete", fx.b.id, `/option-groups/${group.id}`).expect(204);
    });

    it("atendente lê mas não altera; restaurante de fora (C) é 403", async () => {
      await call("get", fx.a.id, "", agentToken).expect(200);
      await call("post", fx.a.id, "/categories", agentToken).send({ name: "Não" }).expect(403);
      await call("get", fx.c.id, "").expect(403);
      await call("post", fx.c.id, "/categories").send({ name: "Não" }).expect(403);
      expect(await admin.menuCategory.count({ where: { tenantId: { in: [fx.a.id, fx.c.id] } } })).toBe(0);
    });

    it("isolamento: ids de outro restaurante nunca são lidos nem alterados pela rota de B", async () => {
      const menuA = await admin.menu.create({ data: { tenantId: fx.a.id, name: "Cardápio A" } });
      const categoryA = await admin.menuCategory.create({ data: { tenantId: fx.a.id, menuId: menuA.id, name: "Categoria de A" } });
      const itemA = await admin.menuItem.create({ data: { tenantId: fx.a.id, categoryId: categoryA.id, name: "Item de A", priceCents: 1000 } });
      const groupA = await admin.menuOptionGroup.create({ data: { tenantId: fx.a.id, menuId: menuA.id, name: "Grupo de A" } });
      const choiceA = await admin.menuChoice.create({ data: { tenantId: fx.a.id, menuId: menuA.id, name: "Opção de A" } });
      const optionA = await admin.menuOption.create({ data: { tenantId: fx.a.id, groupId: groupA.id, choiceId: choiceA.id, name: "Opção de A" } });

      const categoryB = (await call("post", fx.b.id, "/categories").send({ name: "Categoria de B" }).expect(201)).body;
      const itemB = (await call("post", fx.b.id, "/items").send({ categoryId: categoryB.id, name: "Item de B", priceCents: 500 }).expect(201)).body;

      const tree = JSON.stringify((await call("get", fx.b.id, "").expect(200)).body);
      for (const leak of ["de A", categoryA.id, itemA.id, groupA.id, optionA.id]) expect(tree).not.toContain(leak);

      await call("post", fx.b.id, "/items").send({ categoryId: categoryA.id, name: "Intruso" }).expect(404);
      await call("patch", fx.b.id, `/items/${itemA.id}`).send({ name: "Invadido" }).expect(404);
      await call("patch", fx.b.id, `/items/${itemB.id}`).send({ categoryId: categoryA.id }).expect(404);
      await call("delete", fx.b.id, `/items/${itemA.id}`).expect(404);
      await call("put", fx.b.id, `/items/${itemA.id}/sold-out`).send({ soldOut: true }).expect(404);
      await call("post", fx.b.id, `/items/${itemA.id}/duplicate`).expect(404);
      await call("put", fx.b.id, `/items/${itemB.id}/pairings`).send({ itemIds: [itemA.id] }).expect(404);
      await call("put", fx.b.id, `/items/${itemB.id}/option-groups`).send({ groupIds: [groupA.id] }).expect(404);
      await call("post", fx.b.id, `/items/${itemB.id}/option-groups/${groupA.id}`).expect(404);
      await call("put", fx.b.id, "/categories/order").send({ ids: [categoryA.id] }).expect(404);
      await call("put", fx.b.id, `/categories/${categoryB.id}/items/order`).send({ ids: [itemA.id] }).expect(404);
      await call("patch", fx.b.id, `/categories/${categoryA.id}`).send({ name: "Invadida" }).expect(404);
      await call("post", fx.b.id, `/option-groups/${groupA.id}/options`).send({ name: "Intruso" }).expect(404);
      await call("patch", fx.b.id, `/options/${optionA.id}`).send({ name: "Invadida" }).expect(404);
      await call("delete", fx.b.id, `/option-groups/${groupA.id}`).expect(404);

      expect(await admin.menuItem.findUnique({ where: { id: itemA.id } })).toMatchObject({ name: "Item de A", soldOut: false });
      expect(await admin.menuCategory.findUnique({ where: { id: categoryA.id } })).toMatchObject({ name: "Categoria de A" });
      expect(await admin.menuOption.findUnique({ where: { id: optionA.id } })).toMatchObject({ name: "Opção de A" });
      expect(await admin.menuOptionGroup.count({ where: { id: groupA.id } })).toBe(1);
    });
  });

  describe("mais vendidos (F2-11)", () => {
    const db = createPrismaClient(process.env.DATABASE_URL ?? "");
    afterAll(() => db.$disconnect());

    async function seedSales(tenantId: string) {
      const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
      const channel = await admin.channel.create({
        data: { tenantId, type: "WHATSAPP", name: "WA", externalId: `wa-${tenantId}`, credentials: encrypt("{}", key), status: "CONNECTED" },
      });
      const contact = await admin.contact.create({ data: { tenantId, name: "Cliente" } });
      const menu = await admin.menu.upsert({ where: { tenantId }, create: { tenantId, name: "Cardápio" }, update: {} });
      const category = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Estatística" } });
      const other = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Outra" } });
      const pizza = await admin.menuItem.create({ data: { tenantId, categoryId: category.id, name: "Pizza", priceCents: 5000 } });
      const suco = await admin.menuItem.create({ data: { tenantId, categoryId: other.id, name: "Suco", priceCents: 800 } });
      const day = 86_400_000;
      let n = 0;
      const order = (status: "DELIVERED" | "CANCELED" | "PLACED", daysAgo: number, items: { id: string | null; quantity: number; price: number }[]) =>
        admin.order.create({
          data: {
            tenantId, contactId: contact.id, channelId: channel.id, externalOrderId: `m-${tenantId}-${n++}`, status,
            subtotal: 0, deliveryFee: 0, total: 0, placedAt: new Date(Date.now() - daysAgo * day), raw: {}, source: "MENU",
            items: { create: items.map((i) => ({ tenantId, name: "x", quantity: i.quantity, unitPrice: i.price, menuItemId: i.id })) },
          },
        });
      await order("DELIVERED", 1, [{ id: pizza.id, quantity: 2, price: 50 }, { id: suco.id, quantity: 1, price: 8.5 }]);
      await order("PLACED", 5, [{ id: pizza.id, quantity: 1, price: 55.5 }]);
      await order("CANCELED", 2, [{ id: pizza.id, quantity: 10, price: 50 }]); // cancelado não conta
      await order("DELIVERED", 45, [{ id: suco.id, quantity: 30, price: 8 }]); // fora dos 30 dias
      await order("DELIVERED", 3, [{ id: null, quantity: 4, price: 20 }]); // pedido de plataforma, sem item do cardápio
      return { pizza, suco, category, other };
    }

    it("soma quantidade e receita dos pedidos não cancelados dos últimos 30 dias, por categoria, sem vazar entre restaurantes", async () => {
      const a = await seedSales(fx.a.id);
      const b = await seedSales(fx.b.id);
      const scope = (tenantId: string) => ({ tenantIds: [tenantId] });

      const topB = await withTenants(db, scope(fx.b.id), (tx) => topItems(tx, { tenantId: fx.b.id, days: 30 }));
      expect(topB).toEqual([
        { itemId: b.pizza.id, name: "Pizza", categoryId: b.category.id, quantity: 3, revenueCents: 15_550 },
        { itemId: b.suco.id, name: "Suco", categoryId: b.other.id, quantity: 1, revenueCents: 850 },
      ]);

      const wide = await withTenants(db, scope(fx.b.id), (tx) => topItems(tx, { tenantId: fx.b.id, days: 60 }));
      expect(wide.find((row) => row.name === "Suco")).toMatchObject({ quantity: 31, revenueCents: 24_850 });

      const byCategory = await withTenants(db, scope(fx.b.id), (tx) => topItems(tx, { tenantId: fx.b.id, categoryId: b.other.id }));
      expect(byCategory.map((row) => row.name)).toEqual(["Suco"]);

      // Sessão de B pedindo o id de A: a RLS e o filtro do tenant não devolvem nada de A.
      const forged = await withTenants(db, scope(fx.b.id), (tx) => topItems(tx, { tenantId: fx.a.id }));
      expect(forged).toEqual([]);
      const mine = await withTenants(db, scope(fx.a.id), (tx) => topItems(tx, { tenantId: fx.a.id }));
      expect(mine.map((row) => row.itemId).sort()).toEqual([a.pizza.id, a.suco.id].sort());

      const api = (await call("get", fx.b.id, "/top-items?days=30&limit=1").expect(200)).body;
      expect(api).toEqual([topB[0]]);
      await call("get", fx.b.id, "/top-items?days=x").expect(400);
      await call("get", fx.c.id, "/top-items").expect(403);
    });
  });
});
