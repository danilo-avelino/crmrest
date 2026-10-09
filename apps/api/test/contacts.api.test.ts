import { blindIndex, encrypt, parseEncryptionKey } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000);
type Item = { id: string };

describe("API de Clientes", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let agentToken: string; // atendente no restaurante A
  let adminToken: string; // admin no restaurante B
  let masterToken: string;
  let maria: Item;
  let ana: Item;
  let joao: Item;
  let mariaChat: Item;
  let carlos: Item; // B: o mais antigo
  let carlosIg: Item; // B: mesmo nome, sem telefone
  let carlosOutro: Item; // B: mesmo nome, outro telefone
  let bia: Item; // B: mesmo endereço da Beatriz
  let beatriz: Item;
  let carlosChat: Item;
  let intruso: Item; // C: nunca visível

  beforeAll(async () => {
    [app, fx] = await Promise.all([createTestApp(), createAuthFixture()]);
    const { a, b, c } = fx;
    const channel = (tenantId: string, type: "WHATSAPP" | "INSTAGRAM" | "IFOOD") =>
      admin.channel.create({
        data: { tenantId, type, name: type, externalId: `${type}-${tenantId}`, credentials: new Uint8Array(), status: "CONNECTED" },
      });
    const [waA, ifoodA, waB, igB] = await Promise.all([
      channel(a.id, "WHATSAPP"),
      channel(a.id, "IFOOD"),
      channel(b.id, "WHATSAPP"),
      channel(b.id, "INSTAGRAM"),
    ]);
    const order = (tenantId: string, contactId: string, channelId: string, code: string, total: string, placedAt: Date) =>
      admin.order.create({
        data: {
          tenantId,
          contactId,
          channelId,
          externalOrderId: `o-${code}-${tenantId}`,
          displayCode: code,
          status: "DELIVERED",
          subtotal: total,
          deliveryFee: "0",
          total,
          placedAt,
          deliveryAddress: { street: "Rua das Acácias", number: "847" },
          raw: { customer: { name: "dado da origem" } },
          items: { create: { tenantId, name: "Lasanha Bolonhesa G", quantity: 1, unitPrice: total, notes: "sem cebola" } },
        },
      });

    // Restaurante A
    maria = await admin.contact.create({
      data: {
        tenantId: a.id,
        name: "Mariana Souza",
        phone: "+5511987654321",
        phoneSource: "informed_by_customer",
        tags: ["VIP", "recorrente"],
        firstSeenAt: daysAgo(270),
        lastSeenAt: daysAgo(0.1),
        identities: {
          create: [
            { tenantId: a.id, channelType: "WHATSAPP", externalId: "5511987654321" },
            { tenantId: a.id, channelType: "IFOOD", externalId: "ifood-maria" },
          ],
        },
        addresses: { create: { tenantId: a.id, label: "Casa", street: "Rua das Acácias", number: "847", district: "Vila Madalena", city: "São Paulo", state: "SP" } },
      },
    });
    mariaChat = await admin.conversation.create({
      data: { tenantId: a.id, contactId: maria.id, channelId: waA.id, status: "OPEN", lastMessageAt: daysAgo(0.05) },
    });
    await admin.message.create({
      data: { tenantId: a.id, conversationId: mariaChat.id, channelId: waA.id, direction: "INBOUND", type: "TEXT", content: { text: "Meu pedido não chegou" } },
    });
    await order(a.id, maria.id, ifoodA.id, "485329", "67.40", daysAgo(1));
    await order(a.id, maria.id, ifoodA.id, "462110", "94.20", daysAgo(3));
    ana = await admin.contact.create({
      data: {
        tenantId: a.id,
        name: "Ana Paula Costa",
        phoneStatus: "pending",
        firstSeenAt: daysAgo(60),
        lastSeenAt: daysAgo(40),
        identities: { create: { tenantId: a.id, channelType: "INSTAGRAM", externalId: "ig-ana" } },
      },
    });
    joao = await admin.contact.create({
      data: {
        tenantId: a.id,
        name: "João Ferreira",
        phone: "+5511965432109",
        firstSeenAt: daysAgo(14),
        lastSeenAt: daysAgo(10),
        identities: { create: { tenantId: a.id, channelType: "WHATSAPP", externalId: "5511965432109" } },
        addresses: { create: { tenantId: a.id, street: "Rua Joaquim Floriano", district: "Itaim Bibi", city: "São Paulo", state: "SP" } },
      },
    });
    await order(a.id, joao.id, ifoodA.id, "441089", "45.80", daysAgo(10));

    // Restaurante B (o usuário é admin): possíveis duplicados
    carlos = await admin.contact.create({
      data: {
        tenantId: b.id,
        name: "Carlos Mendes",
        phone: "+5511900000001",
        cpfEncrypted: encrypt("12345678909", key),
        cpfHash: blindIndex("12345678909", key),
        firstSeenAt: daysAgo(200),
        lastSeenAt: daysAgo(5),
        identities: { create: { tenantId: b.id, channelType: "WHATSAPP", externalId: "5511900000001" } },
      },
    });
    carlosChat = await admin.conversation.create({
      data: { tenantId: b.id, contactId: carlos.id, channelId: waB.id, status: "RESOLVED", lastMessageAt: daysAgo(5) },
    });
    await admin.message.createMany({
      data: [
        { tenantId: b.id, conversationId: carlosChat.id, channelId: waB.id, direction: "INBOUND", type: "IMAGE", content: { media: { mimeType: "image/jpeg", externalMediaId: "m1" } } },
        { tenantId: b.id, conversationId: carlosChat.id, channelId: waB.id, direction: "INBOUND", type: "TEXT", content: { text: "Moro na Rua das Acácias, 847" } },
        { tenantId: b.id, conversationId: carlosChat.id, channelId: waB.id, direction: "INTERNAL", type: "NOTE", content: { text: "Carlos prefere entrega no portão" } },
        { tenantId: b.id, conversationId: carlosChat.id, channelId: waB.id, direction: "INTERNAL", type: "SYSTEM", content: { event: "phone_collected", text: "Telefone informado e cadastrado" } },
      ],
    });
    await order(b.id, carlos.id, waB.id, "900001", "50.00", daysAgo(5));
    carlosIg = await admin.contact.create({
      data: {
        tenantId: b.id,
        name: "carlos  mendes",
        tags: ["sem glúten"],
        firstSeenAt: daysAgo(20),
        identities: { create: { tenantId: b.id, channelType: "INSTAGRAM", externalId: "ig-carlos" } },
      },
    });
    await admin.conversation.create({ data: { tenantId: b.id, contactId: carlosIg.id, channelId: igB.id, status: "OPEN" } });
    carlosOutro = await admin.contact.create({
      data: { tenantId: b.id, name: "Carlos Mendes", phone: "+5511900000002", firstSeenAt: daysAgo(10) },
    });
    beatriz = await admin.contact.create({
      data: {
        tenantId: b.id,
        name: "Beatriz Nascimento",
        firstSeenAt: daysAgo(30),
        addresses: { create: { tenantId: b.id, street: "Av. Paulista", number: "1374", city: "São Paulo", state: "SP" } },
      },
    });
    bia = await admin.contact.create({
      data: {
        tenantId: b.id,
        name: "Bia N.",
        firstSeenAt: daysAgo(3),
        addresses: { create: { tenantId: b.id, street: "av. paulista ", number: "1374", city: "São Paulo", state: "SP" } },
      },
    });

    intruso = await admin.contact.create({ data: { tenantId: c.id, name: "Mariana Intrusa", tags: ["VIP"] } });

    [agentToken, adminToken, masterToken] = await Promise.all([
      accessTokenFor(app, fx.user.email, a.id),
      accessTokenFor(app, fx.user.email, b.id),
      accessTokenFor(app, fx.user.email, "master"),
    ]);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const get = (path: string, token = agentToken) =>
    request(app.getHttpServer()).get(`/api${path}`).set("Authorization", `Bearer ${token}`);
  const send = (method: "post" | "patch", path: string, body: object = {}, token = agentToken) =>
    request(app.getHttpServer())[method](`/api${path}`).set("Authorization", `Bearer ${token}`).send(body);
  const ids = async (query: string, token = agentToken) =>
    (await get(`/contacts?${query}`, token).expect(200)).body.items.map((item: Item) => item.id);

  it("lista os clientes do restaurante com canais, bairro e pedidos", async () => {
    const { body } = await get("/contacts").expect(200);
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 50 });
    expect(body.items.map((item: Item) => item.id)).toEqual([maria.id, joao.id, ana.id]); // último contato primeiro
    expect(body.items[0]).toMatchObject({
      tenant: { id: fx.a.id, name: "Teste A" },
      name: "Mariana Souza",
      tags: ["VIP", "recorrente"],
      phone: "+5511987654321",
      district: "Vila Madalena",
      ordersCount: 2,
      ordersTotal: "161.6",
      anonymizedAt: null,
    });
    expect(body.items[0].channels.sort()).toEqual(["IFOOD", "WHATSAPP"]);
    expect(body.items[2]).toMatchObject({ phone: null, phoneStatus: "pending", ordersCount: 0, ordersTotal: "0" });
  });

  it("busca e filtra por tag, canal, bairro, telefone pendente e último contato", async () => {
    expect(await ids("search=mariana")).toEqual([maria.id]);
    expect(await ids("search=(11)%2096543")).toEqual([joao.id]);
    expect(await ids("tag=VIP")).toEqual([maria.id]);
    expect(await ids("channel=INSTAGRAM")).toEqual([ana.id]);
    expect(await ids("channel=INSTAGRAM&channel=IFOOD")).toEqual([maria.id, ana.id]);
    expect(await ids("district=itaim%20bibi")).toEqual([joao.id]);
    expect(await ids("phonePending=true")).toEqual([ana.id]);
    expect(await ids("lastContact=7d")).toEqual([maria.id]);
    expect(await ids("lastContact=over30d")).toEqual([ana.id]);
    await get("/contacts?channel=TELEGRAM").expect(400);
  });

  it("ordena e pagina", async () => {
    expect(await ids("sort=orders&order=desc")).toEqual([maria.id, joao.id, ana.id]);
    expect(await ids("sort=name&order=asc")).toEqual([ana.id, joao.id, maria.id]);
    const page2 = await get("/contacts?page=2").expect(200);
    expect(page2.body).toMatchObject({ total: 3, page: 2, items: [] });
  });

  it("no painel master lista os clientes dos dois restaurantes e nunca os de fora", async () => {
    const { body } = await get("/contacts", masterToken).expect(200);
    const tenants = new Set(body.items.map((item: { tenant: { id: string } }) => item.tenant.id));
    expect(tenants).toEqual(new Set([fx.a.id, fx.b.id]));
    expect(body.items.map((item: Item) => item.id)).not.toContain(intruso.id);
    expect(await ids("tag=VIP", masterToken)).toEqual([maria.id]);
  });

  it("opções dos filtros vêm dos cadastros do restaurante", async () => {
    const { body } = await get("/contacts/filters").expect(200);
    expect(body.tags.sort()).toEqual(["VIP", "recorrente"].sort());
    expect(body.districts).toEqual(["Itaim Bibi", "Vila Madalena"]);
  });

  it("resumo da base: total, novos, VIPs, recorrentes, inativos, telefone pendente, aniversariantes e ticket médio", async () => {
    // João faz aniversário neste mês, e o pedido mais recente dele foi cancelado (cancelados não entram no ticket).
    await admin.contact.update({ where: { id: joao.id }, data: { birthDate: new Date(Date.UTC(1990, new Date().getMonth(), 15)) } });
    const ifoodA = await admin.channel.findFirstOrThrow({ where: { tenantId: fx.a.id, type: "IFOOD" } });
    await admin.order.create({
      data: {
        tenantId: fx.a.id,
        contactId: joao.id,
        channelId: ifoodA.id,
        externalOrderId: `o-cancelado-${fx.a.id}`,
        displayCode: "441200",
        status: "CANCELED",
        subtotal: "80.00",
        deliveryFee: "0",
        total: "80.00",
        placedAt: daysAgo(2),
        raw: {},
      },
    });
    const a = await get("/contacts/summary").expect(200);
    expect(a.body).toEqual({
      total: 3,
      newLast30d: 1, // João
      vip: 1, // Mariana
      recurring: 1, // Mariana, com 2 pedidos
      inactive: 1, // Ana, há 40 dias sem contato
      upset: 1, // João
      phonePending: 1, // Ana
      birthdaysThisMonth: 1,
      orders: 3,
      averageTicket: "69.13", // (67,40 + 94,20 + 45,80) / 3
    });

    // No painel master soma os dois restaurantes; o C (com outra VIP) fica de fora.
    const master = await get("/contacts/summary", masterToken).expect(200);
    expect(master.body).toMatchObject({ total: 8, vip: 1, inactive: 5, upset: 1, phonePending: 4, orders: 4, averageTicket: "64.35" });

    // A categoria também é um filtro da lista.
    expect(await ids("upset=true")).toEqual([joao.id]);
    expect(await ids("upset=true&search=mariana")).toEqual([]);
  });

  it("detalhe com as abas de conversas e pedidos", async () => {
    const detail = await get(`/contacts/${maria.id}`).expect(200);
    expect(detail.body).toMatchObject({ conversationsCount: 1, latestConversationId: mariaChat.id, anonymized: null });
    expect(detail.body.lastSeenAt).toEqual(expect.any(String));

    const conversations = await get(`/contacts/${maria.id}/conversations`).expect(200);
    expect(conversations.body).toEqual([
      expect.objectContaining({ id: mariaChat.id, status: "OPEN", lastMessage: { direction: "INBOUND", preview: "Meu pedido não chegou" } }),
    ]);
    const orders = await get(`/contacts/${maria.id}/orders`).expect(200);
    expect(orders.body.map((o: { displayCode: string }) => o.displayCode)).toEqual(["485329", "462110"]);
    expect(orders.body[0]).toMatchObject({ channelType: "IFOOD", total: "67.40", items: [{ name: "Lasanha Bolonhesa G", quantity: 1 }] });

    await get(`/contacts/${intruso.id}/orders`).expect(404);
    await get(`/contacts/${carlos.id}/conversations`).expect(404); // outro restaurante no modo restaurante
  });

  it("possíveis duplicados: só para admin, sem pares de pessoas diferentes", async () => {
    await get("/contacts/duplicates").expect(403); // atendente em A
    const { body } = await get("/contacts/duplicates", adminToken).expect(200);
    const pairs = body.map((pair: { keep: Item; other: Item; reasons: string[] }) => [pair.keep.id, pair.other.id, pair.reasons]);
    expect(pairs).toHaveLength(3);
    expect(pairs).toEqual(
      expect.arrayContaining([
        [carlos.id, carlosIg.id, ["name"]], // fica o mais antigo
        [carlosIg.id, carlosOutro.id, ["name"]],
        [beatriz.id, bia.id, ["address"]],
      ]),
    );
    // Carlos e o outro Carlos têm telefones diferentes: não são a mesma pessoa.
    expect(pairs.some(([keep, other]: string[]) => keep === carlos.id && other === carlosOutro.id)).toBe(false);
    const first = body.find((pair: { keep: Item }) => pair.keep.id === carlos.id);
    expect(first).toMatchObject({
      tenantId: fx.b.id,
      keep: { channels: ["WHATSAPP"], ordersCount: 1, conversationsCount: 1 },
      other: { channels: ["INSTAGRAM"], tags: ["sem glúten"], ordersCount: 0, conversationsCount: 1 },
    });
    // No master, só os restaurantes em que é admin (B).
    expect((await get("/contacts/duplicates", masterToken).expect(200)).body).toHaveLength(3);
  });

  it("\"não são a mesma pessoa\" tira o par da fila", async () => {
    await send("post", "/contacts/duplicates/dismiss", { contactIds: [maria.id, joao.id] }).expect(403);
    await send("post", "/contacts/duplicates/dismiss", { contactIds: [carlosOutro.id, carlosIg.id] }, adminToken).expect(204);
    await send("post", "/contacts/duplicates/dismiss", { contactIds: [carlosIg.id, carlosOutro.id] }, adminToken).expect(204);
    const { body } = await get("/contacts/duplicates", adminToken).expect(200);
    expect(body).toHaveLength(2);
  });

  it("une os cadastros: fica o mais antigo, com canais, conversas e tags do outro", async () => {
    await send("post", "/contacts/merge", { contactIds: [maria.id, ana.id] }).expect(403);
    await send("post", "/contacts/merge", { contactIds: [carlos.id, maria.id] }, masterToken).expect(400);

    const { body } = await send("post", "/contacts/merge", { contactIds: [carlosIg.id, carlos.id] }, adminToken).expect(200);
    expect(body).toEqual({ contactId: carlos.id });
    expect(await admin.contact.findUnique({ where: { id: carlosIg.id } })).toBeNull();
    const detail = await get(`/contacts/${carlos.id}`, adminToken).expect(200);
    expect(detail.body).toMatchObject({ name: "Carlos Mendes", tags: ["sem glúten"], conversationsCount: 2 });
    expect(detail.body.identities.map((i: { channelType: string }) => i.channelType).sort()).toEqual(["INSTAGRAM", "WHATSAPP"]);
    expect(await admin.auditLog.findFirst({ where: { entityId: carlos.id, action: "contact.merged" } })).toMatchObject({ userId: fx.user.id });

    const conflict = await send("post", "/contacts/merge", { contactIds: [carlos.id, carlosOutro.id] }, adminToken).expect(409);
    expect(conflict.body.message).toBe("Estes cadastros têm telefones diferentes.");
  });

  it("exporta os dados do cliente para o titular, com auditoria", async () => {
    await get(`/contacts/${maria.id}/export`).expect(403);
    const { body } = await get(`/contacts/${carlos.id}/export`, adminToken).expect(200);
    expect(body.cadastro).toMatchObject({ nome: "Carlos Mendes", telefone: "+5511900000001", cpf: "12345678909" });
    expect(body.canais).toHaveLength(2);
    expect(body.pedidos).toEqual([expect.objectContaining({ displayCode: "900001", enderecoDeEntrega: { street: "Rua das Acácias", number: "847" } })]);
    const messages = body.conversas.flatMap((c: { mensagens: { conteudo: { text?: string } }[] }) => c.mensagens);
    expect(messages.map((m: { conteudo: { text?: string } }) => m.conteudo.text)).not.toContain("Carlos prefere entrega no portão");
    expect(await admin.auditLog.findFirst({ where: { entityId: carlos.id, action: "contact.exported" } })).toMatchObject({ userId: fx.user.id });
  });

  it("anonimiza: some o que identifica o cliente, ficam pedidos e conversas", async () => {
    await send("post", `/contacts/${maria.id}/anonymize`).expect(403);
    const { body } = await send("post", `/contacts/${carlos.id}/anonymize`, {}, adminToken).expect(200);
    expect(body).toMatchObject({
      name: null,
      phone: null,
      cpfMasked: null,
      tags: [],
      identities: [],
      addresses: [],
      metrics: { ordersCount: 1 },
      conversationsCount: 2,
      anonymized: { by: "Atendente Teste" },
    });

    const messages = await admin.message.findMany({ where: { conversationId: carlosChat.id } });
    expect(messages.map((m) => `${m.type}: ${(m.content as { text?: string }).text}`).sort()).toEqual([
      "NOTE: Conteúdo removido (LGPD)",
      "SYSTEM: Telefone informado e cadastrado",
      "TEXT: Conteúdo removido (LGPD)",
      "TEXT: Conteúdo removido (LGPD)",
    ]);
    const order = await admin.order.findFirstOrThrow({ where: { contactId: carlos.id }, include: { items: true } });
    expect(order).toMatchObject({ deliveryAddress: null, raw: {}, items: [{ notes: null }] });

    await send("patch", `/contacts/${carlos.id}`, { name: "De volta" }, adminToken).expect(409);
    await send("post", `/contacts/${carlos.id}/anonymize`, {}, adminToken).expect(409);
    const list = await get("/contacts", adminToken).expect(200);
    expect(list.body.items.find((item: Item) => item.id === carlos.id)).toMatchObject({ name: null, anonymizedAt: expect.any(String) });
    expect(await ids("tag=sem%20gl%C3%BAten", adminToken)).toEqual([]);
  });

});
