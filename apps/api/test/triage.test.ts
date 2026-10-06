import { blindIndex, encrypt, parseEncryptionKey } from "@comanda/database";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { INACTIVITY_CLOSE_MS, InactivityService } from "../src/automations/inactivity.service.js";
import { SurveyService } from "../src/automations/survey.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp, drainQueues, metaPayload, postMetaWebhook, startMockGraph } from "./helpers.js";

const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
const DAY = 24 * 60 * 60 * 1000;

describe("menu de atendimento, busca do pedido e pesquisa de satisfação", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let token: string;

  beforeAll(async () => {
    graph = await startMockGraph();
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", META_GRAPH_URL: graph.url });
    fx = await createChannelFixture();
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await graph?.close();
  });

  const say = async (waId: string, id: string, body: string) => {
    await postMetaWebhook(
      app,
      metaPayload(fx.whatsapp.externalId, {
        contacts: [{ profile: { name: "Carlos M" }, wa_id: waId }],
        messages: [{ from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
      }),
    ).expect(200);
    await drainQueues(app);
  };
  const conversationOf = (waId: string) =>
    admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, channelId: fx.whatsapp.id, contact: { identities: { some: { channelType: "WHATSAPP", externalId: waId } } } },
      include: { contact: { include: { identities: true, addresses: true } }, messages: { orderBy: { createdAt: "asc" } } },
    });
  type Content = { text?: string; automation?: string; event?: string; orderId?: string };
  const contents = async (waId: string) => (await conversationOf(waId)).messages.map((m) => m.content as Content);
  const automations = async (waId: string) => (await contents(waId)).flatMap((c) => (c.automation ? [c.automation] : []));

  /** Pedido do iFood (o cliente só tem CPF e endereço no cadastro, como o iFood informa). */
  const ifoodOrder = async (code: string, placedAt: Date, customer: { phone?: string } = {}) => {
    const contact = await admin.contact.create({
      data: {
        tenantId: fx.tenant.id,
        name: "Carlos Mendes",
        ...customer,
        cpfEncrypted: encrypt("12345678909", key),
        cpfHash: blindIndex("12345678909", key),
        firstSeenAt: new Date(Date.now() - 30 * DAY),
        identities: { create: { tenantId: fx.tenant.id, channelType: "IFOOD", externalId: `cliente-ifood-${code}` } },
        addresses: { create: { tenantId: fx.tenant.id, street: "Rua dos Pinheiros", number: "120", city: "São Paulo", state: "SP" } },
      },
    });
    const conversation = await admin.conversation.create({
      data: { tenantId: fx.tenant.id, contactId: contact.id, channelId: fx.ifood.id, status: "OPEN" },
    });
    return admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId: contact.id,
        channelId: fx.ifood.id,
        conversationId: conversation.id,
        externalOrderId: `pedido-${code}-${placedAt.getTime()}`,
        displayCode: code,
        status: "PREPARING",
        subtotal: "89.80",
        deliveryFee: "5.00",
        total: "94.80",
        placedAt,
        raw: {},
        items: { create: { tenantId: fx.tenant.id, name: "Pizza Margherita G", quantity: 2, unitPrice: "44.90" } },
      },
    });
  };

  it("conversa nova recebe o menu; a opção 1 pede o número do pedido", async () => {
    await say("5511970000001", "wamid.T1", "Oi");
    expect((await conversationOf("5511970000001")).automationState).toEqual({ triage: "awaiting_option" });

    await say("5511970000001", "wamid.T2", "1");
    expect((await conversationOf("5511970000001")).automationState).toEqual({ triage: "awaiting_order_number" });
    expect(await automations("5511970000001")).toEqual(["menu", "order_number_request"]);
    expect(graph.requests.at(-1)!.body).toMatchObject({ text: { body: expect.stringContaining("número do pedido") } });
  });

  it("pedido de hoje: card na conversa e confirmação com os itens; confirmado, une o cadastro ao do iFood", async () => {
    const order = await ifoodOrder("4853", new Date());
    await say("5511970000001", "wamid.T3", "é o #4853");
    const found = await conversationOf("5511970000001");
    expect(found.contactId).not.toBe(order.contactId); // ainda não une: espera a confirmação
    expect(found.automationState).toEqual({ triage: "awaiting_order_confirmation", foundOrderId: order.id });
    expect(found.messages.at(-1)!.content).toEqual({
      automation: "order_lookup",
      text: "Encontramos o pedido #4853 (em preparo):\n• 2x Pizza Margherita G\nTotal: R$\u00a094,80\n\nÉ este o seu pedido?\n1 - Sim\n2 - Não",
    });

    await say("5511970000001", "wamid.T3b", "Sim, é esse");
    const conversation = await conversationOf("5511970000001");
    // Fica o cadastro mais antigo (o do iFood), agora com o telefone do WhatsApp.
    expect(conversation.contactId).toBe(order.contactId);
    expect(conversation.contact).toMatchObject({ name: "Carlos Mendes", phone: "+5511970000001", phoneSource: "channel" });
    expect(conversation.contact.identities.map((i) => i.channelType).sort()).toEqual(["IFOOD", "WHATSAPP"]);
    expect(conversation.contact.addresses).toHaveLength(1);
    expect(conversation.automationState).toEqual({ triage: "done", linkedOrder: { id: order.id, at: expect.any(String) } });

    const content = conversation.messages.map((m) => m.content as Content);
    expect(content).toContainEqual({ event: "order", orderId: order.id });
    expect(content).toContainEqual({ event: "contacts_merged", text: "Cadastro unificado com o do pedido #4853 (iFood)" });
    expect(content.at(-2)).toMatchObject({
      automation: "order_confirmed",
      text: "Pedido confirmado 👍 Enquanto um atendente chega, já nos conte o problema ou a sua dúvida, assim agilizamos o atendimento.",
    });
    // Marca o início do tempo de resposta da equipe.
    expect(content.at(-1)).toEqual({ event: "handoff", text: "Atendimento passado para a equipe" });
    expect(await admin.auditLog.count({ where: { tenantId: fx.tenant.id, action: "contact.merged", entityId: order.contactId } })).toBe(1);
  });

  it("ao resolver, pede a nota; a nota fica registrada e a conversa continua resolvida", async () => {
    const { id } = await conversationOf("5511970000001");
    await request(app.getHttpServer())
      .patch(`/api/conversations/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "RESOLVED" })
      .expect(200);
    await vi.waitFor(async () => expect((await automations("5511970000001")).at(-1)).toBe("survey"), { timeout: 10_000 });
    expect((await contents("5511970000001")).at(-1)!.text).toBe("Qual nota você dá para nosso atendimento? Digite de 1 a 5");
    const { unreadCount } = await conversationOf("5511970000001");

    await say("5511970000001", "wamid.T4", "5");
    const conversation = await conversationOf("5511970000001");
    const order = await admin.order.findFirstOrThrow({ where: { tenantId: fx.tenant.id, displayCode: "4853" } });
    expect(await admin.rating.findMany({ where: { conversationId: id } })).toEqual([expect.objectContaining({ score: 5, orderId: order.id })]);
    expect(conversation).toMatchObject({ status: "RESOLVED", unreadCount }); // a nota não conta como mensagem nova
    const content = conversation.messages.map((m) => m.content as Content);
    expect(content).toContainEqual({ event: "rating", text: "Avaliação do atendimento: 5/5" });
    expect(content.at(-1)).toMatchObject({ automation: "survey_thanks" });
  });

  it("depois de resolvida, uma mensagem nova começa outro atendimento com o menu", async () => {
    await say("5511970000001", "wamid.T5", "Oi de novo");
    const conversation = await conversationOf("5511970000001");
    expect(conversation).toMatchObject({ status: "OPEN", automationState: { triage: "awaiting_option" } });
    expect((await automations("5511970000001")).at(-1)).toBe("menu");
  });

  it("pedido de três dias atrás não é achado, e sem pedido não há pesquisa", async () => {
    await ifoodOrder("7777", new Date(Date.now() - 3 * DAY));
    await say("5511970000002", "wamid.N1", "Oi");
    await say("5511970000002", "wamid.N2", "1");
    await say("5511970000002", "wamid.N3", "7777");

    const conversation = await conversationOf("5511970000002");
    expect(conversation.automationState).toEqual({ triage: "done" });
    expect(conversation.contact.identities.map((i) => i.channelType)).toEqual(["WHATSAPP"]);
    expect((conversation.messages.at(-2)!.content as Content).text).toBe(
      "Não encontramos o pedido #7777 entre os pedidos de hoje e de ontem. Um atendente já vai te ajudar.",
    );

    await admin.conversation.update({ where: { id: conversation.id }, data: { status: "RESOLVED" } });
    await app.get(SurveyService).request(fx.tenant.id, conversation.id);
    expect((await conversationOf("5511970000002")).messages).toHaveLength(conversation.messages.length);
  });

  it("pedido de outro cliente (telefone diferente): não une os cadastros e avisa a equipe", async () => {
    const order = await ifoodOrder("5150", new Date(), { phone: "+5511999990000" });
    await say("5511970000003", "wamid.C1", "Oi");
    await say("5511970000003", "wamid.C2", "1");
    await say("5511970000003", "wamid.C3", "5150");
    await say("5511970000003", "wamid.C4", "1");

    const conversation = await conversationOf("5511970000003");
    expect(conversation.contactId).not.toBe(order.contactId);
    const content = conversation.messages.map((m) => m.content as Content);
    expect(content).toContainEqual({ event: "order", orderId: order.id });
    expect(content).toContainEqual({
      event: "merge_conflict",
      text: "O pedido #5150 (iFood) está no cadastro de Carlos Mendes, com telefone diferente",
    });
  });

  it("pedido achado, mas o cliente diz que não é dele: não une os cadastros e segue com a equipe", async () => {
    const order = await ifoodOrder("8181", new Date());
    await say("5511970000012", "wamid.D1", "Oi");
    await say("5511970000012", "wamid.D2", "1");
    await say("5511970000012", "wamid.D3", "8181");
    await say("5511970000012", "wamid.D4", "Não");

    const conversation = await conversationOf("5511970000012");
    expect(conversation.contactId).not.toBe(order.contactId);
    expect(conversation.automationState).toEqual({ triage: "done" });
    expect(await automations("5511970000012")).toEqual(["menu", "order_number_request", "order_lookup", "handoff"]);
  });

  it("cadastro com telefone: a opção 1 acha o pedido sem pedir o número; \"não\" pede o número", async () => {
    const order = await ifoodOrder("9292", new Date(), { phone: "+5511970000014" });
    await say("5511970000014", "wamid.P1", "Oi");
    await say("5511970000014", "wamid.P2", "1");
    expect((await conversationOf("5511970000014")).automationState).toEqual({
      triage: "awaiting_order_confirmation",
      foundOrderId: order.id,
      autoFound: true,
    });
    expect((await contents("5511970000014")).at(-1)!.text).toMatch(/^Encontramos o pedido #9292 \(em preparo\):\n/);

    await say("5511970000014", "wamid.P3", "não");
    expect((await conversationOf("5511970000014")).automationState).toEqual({ triage: "awaiting_order_number" });
    await say("5511970000014", "wamid.P4", "9292");
    await say("5511970000014", "wamid.P5", "sim");
    const conversation = await conversationOf("5511970000014");
    expect(conversation.automationState).toEqual({ triage: "done", linkedOrder: { id: order.id, at: expect.any(String) } });
    expect(await automations("5511970000014")).toEqual(["menu", "order_lookup", "order_number_request", "order_lookup", "order_confirmed"]);
  });

  it("acha o pedido de outro cadastro com o mesmo CPF e, confirmado, une os dois", async () => {
    const order = await ifoodOrder("7373", new Date());
    const cpfHash = `cpf-teste-${Date.now()}`;
    await admin.contact.update({ where: { id: order.contactId }, data: { cpfHash } });
    await say("5511970000015", "wamid.F1", "Oi");
    const { contactId } = await conversationOf("5511970000015");
    await admin.contact.update({ where: { id: contactId }, data: { cpfHash } });

    await say("5511970000015", "wamid.F2", "1");
    expect((await conversationOf("5511970000015")).automationState).toMatchObject({ foundOrderId: order.id, autoFound: true });
    await say("5511970000015", "wamid.F3", "1");
    const conversation = await conversationOf("5511970000015");
    expect(conversation.contactId).toBe(order.contactId);
    expect(await automations("5511970000015")).toEqual(["menu", "order_lookup", "order_confirmed"]);
  });

  it("mensagens seguidas chegam juntas: a resposta ao menu não passa na frente do \"Oi\"", async () => {
    const message = (id: string, body: string) => ({ from: "5511970000013", id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } });
    const contacts = [{ profile: { name: "Carlos M" }, wa_id: "5511970000013" }];
    await postMetaWebhook(app, metaPayload(fx.whatsapp.externalId, { contacts, messages: [message("wamid.R1", "Oi")] })).expect(200);
    await postMetaWebhook(app, metaPayload(fx.whatsapp.externalId, { contacts, messages: [message("wamid.R2", "1")] })).expect(200);
    await drainQueues(app);
    expect((await conversationOf("5511970000013")).automationState).toEqual({ triage: "awaiting_order_number" });
  });

  it("fazer um pedido: envia os links cadastrados pelo restaurante", async () => {
    await admin.tenant.update({
      where: { id: fx.tenant.id },
      data: { settings: { orderLinks: [{ label: "Cardápio digital", url: "https://pedido.exemplo.com" }] } },
    });
    await say("5511970000004", "wamid.L1", "Boa noite");
    await say("5511970000004", "wamid.L2", "2");

    const conversation = await conversationOf("5511970000004");
    expect(conversation.automationState).toEqual({ triage: "done", selfServed: true });
    expect(conversation.messages.at(-1)!.content).toMatchObject({
      automation: "order_links",
      text: "Você pode fazer seu pedido por aqui:\n• Cardápio digital: https://pedido.exemplo.com",
    });

    // Continuou escrevendo depois dos links: o menu volta uma vez; fora das opções de novo, a equipe é chamada.
    await say("5511970000004", "wamid.L3", "Quero falar com atendente");
    expect((await conversationOf("5511970000004")).automationState).toEqual({ triage: "awaiting_option", menuRepeated: true });
    await say("5511970000004", "wamid.L4", "Atendente por favor");
    const called = await conversationOf("5511970000004");
    expect(called.awaitingAgentSince).not.toBeNull();
    expect(await automations("5511970000004")).toEqual(["menu", "order_links", "menu", "handoff"]);
  });

  it("resposta fora das opções: repete o menu uma vez e, na segunda, chama a equipe", async () => {
    await say("5511970000017", "wamid.O1", "Oi");
    await say("5511970000017", "wamid.O2", "Vocês entregam no Centro?");
    expect((await conversationOf("5511970000017")).automationState).toEqual({ triage: "awaiting_option", menuRepeated: true });
    await say("5511970000017", "wamid.O3", "Entregam?");
    const conversation = await conversationOf("5511970000017");
    expect(conversation.automationState).toEqual({ triage: "done", menuRepeated: true });
    expect(conversation.awaitingAgentSince).not.toBeNull();
    expect(await automations("5511970000017")).toEqual(["menu", "menu", "handoff"]);
  });

  it("quando o atendente responde, o menu deixa de interpretar as mensagens", async () => {
    await say("5511970000005", "wamid.A1", "Oi");
    const { id } = await conversationOf("5511970000005");
    await request(app.getHttpServer())
      .post(`/api/conversations/${id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Oi! Aqui é a Bruna, em que posso ajudar?" })
      .expect(201);
    await drainQueues(app);
    await say("5511970000005", "wamid.A2", "1 pizza grande, por favor");

    expect((await conversationOf("5511970000005")).automationState).toEqual({ triage: "done" });
    expect(await automations("5511970000005")).toEqual(["menu"]);
  });

  it("saudação editada pelo restaurante e, fora do horário, o aviso no lugar do menu", async () => {
    const days = Array.from({ length: 7 }, () => null); // fechado todos os dias
    await admin.tenant.update({
      where: { id: fx.tenant.id },
      data: { settings: { automationTexts: { greeting: "Bem-vindo à Cantina, {nome}!" } } },
    });
    try {
      await say("5511970000006", "wamid.G1", "Oi");
      expect((await contents("5511970000006")).at(-1)).toMatchObject({
        automation: "menu",
        text: "Bem-vindo à Cantina, Carlos!\n1 - Falar sobre um pedido\n2 - Fazer um pedido\n3 - Outro assunto",
      });

      await admin.tenant.update({
        where: { id: fx.tenant.id },
        data: { settings: { businessHours: { enabled: true, days, closedMessage: "Estamos fechados. Abrimos às 18h!" } } },
      });
      await say("5511970000007", "wamid.H1", "Oi, vocês estão abertos?");
      // Fica pendente para a equipe responder quando abrir (sem encerramento por inatividade nem avaliação).
      expect(await conversationOf("5511970000007")).toMatchObject({ status: "PENDING", automationState: { triage: "done", afterHours: true } });
      expect((await contents("5511970000007")).at(-1)).toMatchObject({ automation: "after_hours", text: "Estamos fechados. Abrimos às 18h!" });
      // Mensagens seguintes do mesmo atendimento não repetem o aviso nem abrem o menu, e a conversa continua pendente.
      await say("5511970000007", "wamid.H2", "1");
      expect(await automations("5511970000007")).toEqual(["after_hours"]);
      const pending = await conversationOf("5511970000007");
      expect(pending.status).toBe("PENDING");
      await app.get(InactivityService).close(fx.tenant.id, pending.id, new Date(Date.now() + 60 * 60_000));
      expect((await conversationOf("5511970000007")).status).toBe("PENDING");

      // A equipe responde: volta a ser um atendimento aberto.
      await request(app.getHttpServer())
        .post(`/api/conversations/${pending.id}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ text: "Bom dia! Já abrimos, em que posso ajudar?" })
        .expect(201);
      expect(await conversationOf("5511970000007")).toMatchObject({ status: "OPEN", automationState: { triage: "done" } });
    } finally {
      await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: {} } });
    }
  });

  /** Simula o tempo parado: as mensagens da conversa passam a ter mais de 20 minutos. */
  const idle = async (conversationId: string) => {
    for (const { id, createdAt } of await admin.message.findMany({ where: { conversationId } })) {
      await admin.message.update({ where: { id }, data: { createdAt: new Date(createdAt.getTime() - INACTIVITY_CLOSE_MS - 60_000) } });
    }
  };

  it("cliente sem responder por 20 minutos: encerra a conversa e, com pedido de hoje, pede a avaliação", async () => {
    await ifoodOrder("6060", new Date());
    await say("5511970000008", "wamid.I1", "Oi");
    await say("5511970000008", "wamid.I2", "1");
    await say("5511970000008", "wamid.I3", "6060");
    await say("5511970000008", "wamid.I4", "1");
    const { id } = await conversationOf("5511970000008");
    // Cada envio agenda a checagem de inatividade.
    const delayed = await app.get<Queue>(getQueueToken(QUEUES.automations)).getJobs(["delayed"]);
    expect(delayed.some((job) => job.name === "inactivity" && job.data.conversationId === id)).toBe(true);

    // Chamando o atendente: mesmo parada, a conversa não é encerrada (o cliente espera a equipe).
    expect((await conversationOf("5511970000008")).awaitingAgentSince).not.toBeNull();
    await idle(id);
    await app.get(InactivityService).close(fx.tenant.id, id);
    expect((await conversationOf("5511970000008")).status).toBe("OPEN");

    // A equipe responde e o alarme para; antes dos 20 minutos, nada acontece.
    await request(app.getHttpServer())
      .post(`/api/conversations/${id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Oi! Vou verificar seu pedido." })
      .expect(201);
    await drainQueues(app);
    expect((await conversationOf("5511970000008")).awaitingAgentSince).toBeNull();
    await app.get(InactivityService).close(fx.tenant.id, id);
    expect((await conversationOf("5511970000008")).status).toBe("OPEN");

    await idle(id);
    await app.get(InactivityService).close(fx.tenant.id, id);
    await drainQueues(app);
    const conversation = await conversationOf("5511970000008");
    expect(conversation.status).toBe("RESOLVED");
    expect(conversation.messages.slice(-2).map((m) => m.content)).toEqual([
      {
        automation: "inactivity_close",
        text: "Encerramos esta conversa por falta de interação. Se precisar de algo, é só mandar uma mensagem que retomamos de onde paramos.",
      },
      { automation: "survey", text: "Qual nota você dá para nosso atendimento? Digite de 1 a 5" },
    ]);
    expect(graph.requests.at(-1)!.body).toMatchObject({ text: { body: expect.stringContaining("Digite de 1 a 5") } });
  });

  it("chamando o atendente: fica no topo da Inbox, entra na contagem do alarme e para ao resolver", async () => {
    await say("5511970000016", "wamid.Q1", "Oi");
    await say("5511970000016", "wamid.Q2", "3");
    const { id } = await conversationOf("5511970000016");
    const api = (path: string) => request(app.getHttpServer()).get(`/api${path}`).set("Authorization", `Bearer ${token}`).expect(200);

    const { body } = await api("/conversations?status=ACTIVE");
    const flags = body.items.map((c: { awaitingAgentSince: string | null }) => c.awaitingAgentSince !== null);
    expect(flags.indexOf(false)).toBeGreaterThan(0); // todas as que chamam vêm antes das demais
    expect(flags.slice(flags.indexOf(false))).not.toContain(true);
    expect(body.items.find((c: { id: string }) => c.id === id).awaitingAgentSince).toEqual(expect.any(String));
    expect((await api("/conversations/counts")).body.awaitingAgent).toBe(flags.filter(Boolean).length);

    await request(app.getHttpServer())
      .patch(`/api/conversations/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "RESOLVED" })
      .expect(200);
    expect((await conversationOf("5511970000016")).awaitingAgentSince).toBeNull();
  });

  it("não encerra quando o cliente falou por último ou a conversa está pendente; sem pedido, não pede avaliação", async () => {
    await say("5511970000009", "wamid.J1", "Oi");
    await say("5511970000009", "wamid.J2", "3");
    await say("5511970000009", "wamid.J3", "Vocês têm opção sem glúten?");
    const { id } = await conversationOf("5511970000009");
    await idle(id);
    await app.get(InactivityService).close(fx.tenant.id, id);
    expect((await conversationOf("5511970000009")).status).toBe("OPEN");

    await say("5511970000010", "wamid.K1", "Oi");
    const pending = await conversationOf("5511970000010");
    await admin.conversation.update({ where: { id: pending.id }, data: { status: "PENDING" } });
    await idle(pending.id);
    await app.get(InactivityService).close(fx.tenant.id, pending.id);
    expect((await conversationOf("5511970000010")).status).toBe("PENDING");

    await admin.conversation.update({ where: { id: pending.id }, data: { status: "OPEN" } });
    await app.get(InactivityService).close(fx.tenant.id, pending.id);
    await drainQueues(app);
    expect((await conversationOf("5511970000010")).status).toBe("RESOLVED");
    expect(await automations("5511970000010")).toEqual(["menu", "inactivity_close"]);
  });

  it("conversa aberta parada há 20 minutos: a mensagem seguinte começa outro atendimento, com o menu", async () => {
    await say("5511970000011", "wamid.M1", "Oi");
    await say("5511970000011", "wamid.M2", "3");
    await say("5511970000011", "wamid.M3", "Vocês abrem no feriado?");
    const { id } = await conversationOf("5511970000011");
    // Sem resposta da equipe, a conversa continua aberta (o cliente falou por último).
    await idle(id);
    await app.get(InactivityService).close(fx.tenant.id, id);
    expect((await conversationOf("5511970000011")).status).toBe("OPEN");

    await say("5511970000011", "wamid.M4", "Oi, outra dúvida");
    const conversation = await conversationOf("5511970000011");
    expect(conversation.automationState).toEqual({ triage: "awaiting_option" });
    expect(await automations("5511970000011")).toEqual(["menu", "handoff", "menu"]);
  });
});
