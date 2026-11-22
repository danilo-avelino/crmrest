import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ifoodCatalogToRows } from "../src/menu/ifood-catalog.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp, PASSWORD } from "./helpers.js";

const CNPJ = "11.222.333/0001-81";

/** Catalog API v2 falsa: um catálogo DEFAULT com uma categoria de itens (com grupo "Tamanho") e uma de pizza. */
async function startMockCatalog() {
  const state = { forbidden: false, paths: [] as string[] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://ifood");
    const json = (status: number, body?: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));
    if (url.pathname === "/authentication/v1.0/oauth/token") return json(200, { accessToken: "token-ifood", type: "bearer", expiresIn: 21600 });
    if (url.pathname === "/order/v1.0/events:polling") return json(204);
    state.paths.push(url.pathname + url.search);
    if (state.forbidden) return json(403);
    if (/\/catalog\/v2\.0\/merchants\/[^/]+\/catalogs$/.test(url.pathname)) {
      return json(200, [
        { catalogId: "cat-indoor", context: ["INDOOR"], status: "AVAILABLE" },
        { catalogId: "cat-delivery", context: ["DEFAULT"], status: "AVAILABLE" },
      ]);
    }
    if (url.pathname.endsWith("/catalogs/cat-delivery/categories")) {
      return json(200, [
        {
          id: "c2",
          name: "Pizzas",
          sequence: 2,
          template: "PIZZA",
          pizza: {
            sizes: [
              { id: "s-g", name: "Grande", sequence: 2 },
              { id: "s-b", name: "Broto", sequence: 1 },
            ],
            toppings: [{ name: "Calabresa", description: "Calabresa e cebola", prices: { "s-b": 34.9, "s-g": 59.9 } }],
          },
        },
        {
          id: "c1",
          name: "Lanches",
          sequence: 1,
          items: [
            { name: "X-Burguer", description: "Pão, carne e queijo", sequence: 1, price: { value: 25 }, optionGroups: [{ name: "Adicionais", min: 0, max: 3, options: [{ name: "Bacon", price: { value: 4 } }] }] },
            {
              name: "Açaí",
              sequence: 2,
              price: { value: 0 },
              optionGroups: [{ name: "Tamanho", min: 1, max: 1, options: [{ name: "300 ml", price: { value: 15 } }, { name: "500 ml", price: { value: 20 } }] }],
            },
          ],
        },
      ]);
    }
    return json(404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("ifoodCatalogToRows", () => {
  it("tamanho vira tamanho do item, pizza vira um item por sabor e os outros grupos entram nos avisos", () => {
    const { rows, warnings } = ifoodCatalogToRows([
      { name: "Lanches", items: [{ name: "X", price: { value: 10 }, optionGroups: [{ name: "Molhos", options: [{ name: "Alho" }] }] }] },
    ] as never);
    expect(rows).toMatchObject([{ category: "Lanches", item: "X", priceCents: 1000, size: null }]);
    expect(warnings[0]).toContain("Molhos");
  });
});

describe("importação do cardápio do iFood por pedido", () => {
  let app: INestApplication;
  let ifood: Awaited<ReturnType<typeof startMockCatalog>>;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let other: Awaited<ReturnType<typeof createChannelFixture>>;
  let superAdmin: { id: string; email: string };
  let adminToken: string;
  let superToken: string;
  let requestId: string;

  beforeAll(async () => {
    ifood = await startMockCatalog();
    app = await createTestApp({ IFOOD_CLIENT_ID: "cliente", IFOOD_CLIENT_SECRET: "segredo", IFOOD_API_URL: ifood.url });
    await app.get<Queue>(getQueueToken(QUEUES.ifood)).removeJobScheduler("ifood-polling");
    fx = await createChannelFixture();
    other = await createChannelFixture();
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    superAdmin = await admin.user.create({
      data: {
        name: "Equipe Plataforma",
        email: `plataforma-${randomUUID()}@teste.local`,
        passwordHash: await hash(PASSWORD),
        isSuperAdmin: true,
        memberships: { create: { tenantId: other.tenant.id, role: "ADMIN" } },
      },
      select: { id: true, email: true },
    });
    adminToken = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    superToken = await accessTokenFor(app, superAdmin.email, other.tenant.id);
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: superAdmin?.id } });
    await fx?.cleanup();
    await other?.cleanup();
    await app?.close();
    await ifood?.close();
  });

  const api = () => request(app.getHttpServer());

  it("sem o módulo Cardápio o pedido é recusado", async () => {
    await api().post(`/api/menu/${fx.tenant.id}/import-requests`).set("Authorization", `Bearer ${adminToken}`).send({ storeName: "Loja", cnpj: CNPJ }).expect(403);
  });

  it("o administrador pede com o nome da loja e o CNPJ; CNPJ inválido e segundo pedido aberto são recusados", async () => {
    await admin.tenantModule.create({ data: { tenantId: fx.tenant.id, module: "MENU" } });
    await api().post(`/api/menu/${fx.tenant.id}/import-requests`).set("Authorization", `Bearer ${adminToken}`).send({ storeName: "Loja", cnpj: "11.222.333/0001-82" }).expect(400);
    const created = await api()
      .post(`/api/menu/${fx.tenant.id}/import-requests`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ storeName: "  Pizzaria do Teste  ", cnpj: CNPJ })
      .expect(201);
    expect(created.body).toMatchObject({ storeName: "Pizzaria do Teste", cnpj: "11222333000181", status: "OPEN" });
    requestId = created.body.id;
    await api().post(`/api/menu/${fx.tenant.id}/import-requests`).set("Authorization", `Bearer ${adminToken}`).send({ storeName: "Outra", cnpj: CNPJ }).expect(409);
    const list = await api().get(`/api/menu/${fx.tenant.id}/import-requests`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([requestId]);
  });

  it("só a equipe da plataforma vê a lista e importa", async () => {
    await api().get("/api/platform/menu-import-requests").set("Authorization", `Bearer ${adminToken}`).expect(403);
    await api().post(`/api/platform/menu-import-requests/${requestId}/ifood-preview`).set("Authorization", `Bearer ${adminToken}`).send({ channelId: fx.ifood.id }).expect(403);
    const list = await api().get("/api/platform/menu-import-requests").set("Authorization", `Bearer ${superToken}`).expect(200);
    const mine = list.body.find((r: { id: string }) => r.id === requestId);
    expect(mine).toMatchObject({ tenantName: "Restaurante Pipeline", userName: "Atendente Pipeline", ifoodStores: [{ channelId: fx.ifood.id, merchantId: fx.ifood.externalId }] });
  });

  it("loja do iFood de outro restaurante não serve para o pedido", async () => {
    await api().post(`/api/platform/menu-import-requests/${requestId}/ifood-preview`).set("Authorization", `Bearer ${superToken}`).send({ channelId: other.ifood.id }).expect(404);
  });

  it("iFood recusando o catálogo (módulo não liberado) vira aviso claro", async () => {
    ifood.state.forbidden = true;
    const res = await api().post(`/api/platform/menu-import-requests/${requestId}/ifood-preview`).set("Authorization", `Bearer ${superToken}`).send({ channelId: fx.ifood.id }).expect(422);
    expect(res.body.message).toContain("Catalog");
    ifood.state.forbidden = false;
  });

  it("lê o catálogo DEFAULT, mostra o plano sem gravar e depois grava e conclui o pedido", async () => {
    const preview = await api().post(`/api/platform/menu-import-requests/${requestId}/ifood-preview`).set("Authorization", `Bearer ${superToken}`).send({ channelId: fx.ifood.id }).expect(200);
    expect(ifood.state.paths.some((p) => p.includes("/catalogs/cat-delivery/categories"))).toBe(true);
    expect(preview.body.counts).toMatchObject({ items: 3, sizes: 4 });
    expect(preview.body.warnings[0]).toContain("Adicionais");
    expect(await admin.menuItem.count({ where: { tenantId: fx.tenant.id } })).toBe(0);

    const rows = preview.body.rows.map(({ errors: _errors, ...row }: { errors: string[] }) => row);
    const done = await api().post(`/api/platform/menu-import-requests/${requestId}/commit`).set("Authorization", `Bearer ${superToken}`).send({ rows }).expect(201);
    expect(done.body).toMatchObject({ items: 3, sizes: 4 });
    const items = await admin.menuItem.findMany({ where: { tenantId: fx.tenant.id }, include: { sizes: true, category: true }, orderBy: { name: "asc" } });
    expect(items.map((i) => [i.category.name, i.name, i.priceCents, i.sizes.map((s) => [s.name, s.priceCents])])).toEqual([
      ["Lanches", "Açaí", null, [["300 ml", 1500], ["500 ml", 2000]]],
      ["Pizzas", "Calabresa", null, [["Broto", 3490], ["Grande", 5990]]],
      ["Lanches", "X-Burguer", 2500, []],
    ]);
    const after = await api().get(`/api/menu/${fx.tenant.id}/import-requests`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(after.body[0]).toMatchObject({ status: "DONE" });
    expect(after.body[0].note).toContain("3 itens");
  });

  it("a plataforma pode recusar com uma nota", async () => {
    await admin.menuImportRequest.update({ where: { id: requestId }, data: { status: "OPEN" } });
    const res = await api()
      .post(`/api/platform/menu-import-requests/${requestId}/resolve`)
      .set("Authorization", `Bearer ${superToken}`)
      .send({ status: "REJECTED", note: "A loja não autorizou o Dish Desk no iFood." })
      .expect(200);
    expect(res.body).toMatchObject({ status: "REJECTED", note: "A loja não autorizou o Dish Desk no iFood." });
  });
});
