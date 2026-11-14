import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { INACTIVITY_CLOSE_MS, InactivityService } from "../src/automations/inactivity.service.js";
import { OrderNoticeService } from "../src/orders/order-notice.service.js";
import { IFOOD_CHAT_WAIT_MS, OutboundProcessor } from "../src/outbound/outbound.processor.js";
import { type OutboundJob, QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createAuthFixture, createChannelFixture, createTestApp, metaPayload, postMetaWebhook, startMockGraph } from "./helpers.js";

const EXTENSION_URL = "https://chromewebstore.google.com/detail/dish-desk/teste";
const CLOCK = new Intl.DateTimeFormat("pt-BR", { timeStyle: "medium", timeZone: "America/Sao_Paulo" });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
/** Mensagem como o widget mostra: só a hora. */
const shown = (direction: "INBOUND" | "OUTBOUND", text: string, at: Date) => ({ direction, text, time: CLOCK.format(at) });

describe("Chat do iFood na Inbox (trava IFOOD_CHAT_BRIDGE ligada)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let other: Awaited<ReturnType<typeof createAuthFixture>>;
  let token: string;
  let order: { id: string; contactId: string };
  const post = (path: string, body?: object, bearer = token) =>
    request(app.getHttpServer()).post(`/api${path}`).set("Authorization", `Bearer ${bearer}`).send(body);
  const timeline = (conversationId: string) =>
    admin.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" }, select: { id: true, direction: true, status: true, content: true } });
  const conversation = () => admin.conversation.findFirstOrThrow({ where: { tenantId: fx.tenant.id, channelId: fx.ifood.id, contactId: order.contactId } });
  const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 15_000, interval: 100 });
  /** Espera as automações da mensagem copiada rodarem (o worker está no próprio processo de teste). */
  const settle = () =>
    until(async () => {
      const counts = await app.get<Queue>(getQueueToken(QUEUES.automations)).getJobCounts("waiting", "active", "prioritized");
      expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(0);
    });
  /** O painel pega as respostas pendentes e as digita no widget. */
  const typeOutbox = async () => {
    const { body } = await post("/ifood-chat/outbox/claim").expect(200);
    for (const item of body) await post(`/ifood-chat/outbox/${item.messageId}`, { status: "SENT" }).expect(204);
    return body as { messageId: string; conversationId: string; orderCode: string; text: string }[];
  };
  const ifoodOrder = (code: string, name: string, placedAt = minutesAgo(20)) =>
    admin.contact
      .create({
        data: { tenantId: fx.tenant.id, name, identities: { create: { tenantId: fx.tenant.id, channelType: "IFOOD", externalId: `cliente-${code}` } } },
      })
      .then((contact) =>
        admin.order.create({
          data: {
            tenantId: fx.tenant.id,
            contactId: contact.id,
            channelId: fx.ifood.id,
            externalOrderId: randomUUID(),
            displayCode: code,
            status: "CONFIRMED",
            subtotal: 40,
            deliveryFee: 5,
            total: 45,
            placedAt,
            raw: {},
          },
          select: { id: true, contactId: true },
        }),
      );

  beforeAll(async () => {
    [app, fx, other] = await Promise.all([
      createTestApp({ IFOOD_WIDGET_ID: "widget-teste", IFOOD_CHAT_BRIDGE: "true", IFOOD_EXTENSION_URL: EXTENSION_URL }),
      createChannelFixture(),
      createAuthFixture(),
    ]);
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    order = await ifoodOrder("6530", "Carlos Mendes");
  });

  afterAll(async () => {
    // As respostas ficam um minuto na fila à espera de um painel: saem daqui para não segurar os testes seguintes.
    for (const job of await app.get<Queue>(getQueueToken(QUEUES.outbound)).getDelayed()) await job.remove();
    await fx?.cleanup();
    await other?.cleanup();
    await app?.close();
  });

  it("o widget informa que o chat vai para a Inbox e onde instalar a extensão", async () => {
    const { body } = await request(app.getHttpServer()).get("/api/ifood-widget").set("Authorization", `Bearer ${token}`).expect(200);
    expect(body).toEqual({ widgetId: "widget-teste", merchantIds: [fx.ifood.externalId], chat: true, extensionUrl: EXTENSION_URL });
  });

  it("chat que o painel não conseguiu copiar: o motivo só vai para o log", async () => {
    await post("/ifood-chat/report", { orderCode: "3888", reason: "nenhuma mensagem lida", detail: "<div>#3888 - Cliente</div>" }).expect(204);
    await post("/ifood-chat/report", { orderCode: "#3888", reason: "" }).expect(400);
  });

  const automatic = shown("OUTBOUND", "Recebemos o seu pedido!", minutesAgo(19));
  const question = shown("INBOUND", "Oi, pode mandar sem cebola?", minutesAgo(10));
  const second = shown("INBOUND", "E sem picles", minutesAgo(9));

  it("conversa lida do widget: abre a conversa do cliente com o pedido e as mensagens, sem repetir na leitura seguinte", async () => {
    expect((await post("/ifood-chat/sync", { orderCode: "6530", messages: [automatic, question] }).expect(200)).body).toEqual({ found: true });

    // O cliente escreveu e a loja não tem a IA: é da equipe (aba Ativos).
    await settle();
    const chat = await conversation();
    expect(chat).toMatchObject({ contactId: order.contactId, status: "OPEN", unreadCount: 1, teamInvolved: true });
    expect((await timeline(chat.id)).slice(0, 4).map((m) => [m.direction, m.status, m.content])).toEqual([
      ["INTERNAL", null, { event: "conversation_opened", text: "Conversa aberta via iFood" }],
      ["INTERNAL", null, { event: "order", orderId: order.id }],
      ["OUTBOUND", "SENT", { text: "Recebemos o seu pedido!" }],
      ["INBOUND", "DELIVERED", { text: "Oi, pode mandar sem cebola?" }],
    ]);
    expect((await admin.order.findUniqueOrThrow({ where: { id: order.id } })).conversationId).toBe(chat.id);
  });

  it("cliente escreveu no chat: chama a equipe com o alarme, avisa o cliente e pede o telefone", async () => {
    await settle();
    const chat = await conversation();
    expect(chat.awaitingAgentSince).not.toBeNull();
    expect(chat).toMatchObject({
      awaitingAgentQuiet: false,
      automationState: { triage: "done", linkedOrder: { id: order.id, at: expect.any(String) }, phoneCollection: "awaiting_phone" },
    });
    const added = (await timeline(chat.id)).slice(4).map((m) => [m.direction, m.status, m.content]);
    expect(added).toHaveLength(2);
    expect(added).toContainEqual(["OUTBOUND", "PENDING", { automation: "handoff", text: "Olá! 👋 Estamos chamando um atendente. Enquanto ele chega, pode nos enviar seu número de telefone com DDD? É comum a conversa do iFood encerrar e ficarmos sem ter como entrar em contato." }]);
    expect(added).toContainEqual(["INTERNAL", null, { event: "handoff", text: "Cliente chamando pelo chat do iFood" }]);
    // O painel digita a resposta automática no widget, como as da equipe; o envio agenda a checagem de inatividade.
    expect(await typeOutbox()).toEqual([{ messageId: expect.any(String), conversationId: chat.id, orderCode: "6530", text: "Olá! 👋 Estamos chamando um atendente. Enquanto ele chega, pode nos enviar seu número de telefone com DDD? É comum a conversa do iFood encerrar e ficarmos sem ter como entrar em contato." }]);
    const delayed = await app.get<Queue>(getQueueToken(QUEUES.automations)).getJobs(["delayed"]);
    expect(delayed.some((job) => job.name === "inactivity" && job.data.conversationId === chat.id)).toBe(true);

    // A mesma conversa de novo, com uma mensagem nova no fim: o atendimento é o mesmo, sem outro chamado.
    await post("/ifood-chat/sync", { orderCode: "6530", messages: [automatic, question, second] }).expect(200);
    await settle();
    expect(await timeline(chat.id)).toHaveLength(7);
    expect(await conversation()).toMatchObject({ id: chat.id, unreadCount: 2, awaitingAgentSince: chat.awaitingAgentSince });
  });

  it("cliente manda o telefone: vai para o cadastro e a automação confirma", async () => {
    const phone = shown("INBOUND", "Meu número é (11) 97654-3210", minutesAgo(8));
    await post("/ifood-chat/sync", { orderCode: "6530", messages: [automatic, question, second, phone] }).expect(200);
    await settle();
    const chat = await conversation();
    expect(await admin.contact.findUniqueOrThrow({ where: { id: order.contactId } })).toMatchObject({
      phone: "+5511976543210",
      phoneSource: "informed_by_customer",
      phoneStatus: "ok",
    });
    expect(chat.automationState).toMatchObject({ phoneCollection: "phone_collected" });
    const contents = (await timeline(chat.id)).map((m) => m.content);
    expect(contents).toContainEqual({ event: "phone_collected", text: "Telefone informado e cadastrado" });
    expect(contents).toContainEqual({ automation: "phone_confirmation", text: "Obrigado! Já anotamos seu telefone." });
    expect((await typeOutbox()).map((item) => item.text)).toEqual(["Obrigado! Já anotamos seu telefone."]);
  });

  it("telefone pedido que chega antes de uma resposta da loja na mesma leitura: vai para o cadastro mesmo assim", async () => {
    const { contactId } = await ifoodOrder("6535", "Tito Baia");
    const asked = [shown("INBOUND", "O entregador pode deixar na portaria", minutesAgo(5))];
    await post("/ifood-chat/sync", { orderCode: "6535", messages: asked }).expect(200);
    await settle();
    await typeOutbox();
    const chat = await admin.conversation.findFirstOrThrow({ where: { contactId, channelId: fx.ifood.id } });
    expect(chat.automationState).toMatchObject({ phoneCollection: "awaiting_phone" });

    // O número chegou antes de o painel digitar a resposta da loja: a leitura termina na loja e nenhuma automação roda.
    const messages = [...asked, shown("INBOUND", "86988601738", minutesAgo(2)), shown("OUTBOUND", "Olá, boa noite! Ok.", minutesAgo(1))];
    await post("/ifood-chat/sync", { orderCode: "6535", messages }).expect(200);
    await settle();
    expect(await admin.contact.findUniqueOrThrow({ where: { id: contactId } })).toMatchObject({ phone: "+5586988601738", phoneSource: "informed_by_customer" });
    expect((await admin.conversation.findUniqueOrThrow({ where: { id: chat.id } })).automationState).toMatchObject({ phoneCollection: "phone_collected" });
    expect((await timeline(chat.id)).map((m) => m.content)).toContainEqual({ event: "phone_collected", text: "Telefone informado e cadastrado" });
  });

  it("conversa copiada bem depois, ou já respondida pela loja: entra como não lida, sem alarme nem resposta automática", async () => {
    const late = await ifoodOrder("6531", "Bruna Lima", minutesAgo(200));
    const old = [shown("INBOUND", "Cadê meu pedido?", minutesAgo(180))];
    await post("/ifood-chat/sync", { orderCode: "6531", messages: old }).expect(200);
    const answered = await ifoodOrder("6532", "Diego Alves");
    const replied = [shown("INBOUND", "Vai demorar?", minutesAgo(4)), shown("OUTBOUND", "Sai em 5 minutos!", minutesAgo(3))];
    await post("/ifood-chat/sync", { orderCode: "6532", messages: replied }).expect(200);
    await settle();
    for (const { contactId } of [late, answered]) {
      const chat = await admin.conversation.findFirstOrThrow({ where: { contactId, channelId: fx.ifood.id } });
      expect(chat).toMatchObject({ status: "OPEN", unreadCount: 1, awaitingAgentSince: null, automationState: {} });
      expect((await timeline(chat.id)).filter((m) => (m.content as { automation?: string }).automation)).toEqual([]);
    }
  });

  it("loja puxou a conversa (no widget ou pela Inbox) e o cliente respondeu: sem resposta automática, só o alarme até a loja responder", async () => {
    const called = await ifoodOrder("6533", "Iane Pimentel");
    const knock = [shown("OUTBOUND", "Boa tarde, entregador está no local!", minutesAgo(2)), shown("INBOUND", "Só um minuto", minutesAgo(1))];
    await post("/ifood-chat/sync", { orderCode: "6533", messages: knock }).expect(200);

    // Conversa resolvida em que a equipe escreve de novo pela Inbox.
    const resolved = await ifoodOrder("6534", "Caio Prado", minutesAgo(200));
    const old = shown("INBOUND", "Obrigado!", minutesAgo(180));
    await post("/ifood-chat/sync", { orderCode: "6534", messages: [old] }).expect(200);
    const chat = await admin.conversation.findFirstOrThrow({ where: { contactId: resolved.contactId, channelId: fx.ifood.id } });
    await admin.conversation.update({ where: { id: chat.id }, data: { status: "RESOLVED" } });
    await post(`/conversations/${chat.id}/messages`, { text: "Esquecemos o refrigerante, já vai!" }).expect(201);
    await typeOutbox();
    // O painel lê a resposta no widget e, numa leitura seguinte, a do cliente.
    const reply = shown("OUTBOUND", "Esquecemos o refrigerante, já vai!", new Date());
    await post("/ifood-chat/sync", { orderCode: "6534", messages: [old, reply] }).expect(200);
    const before = (await timeline(chat.id)).length;
    await post("/ifood-chat/sync", { orderCode: "6534", messages: [old, reply, shown("INBOUND", "Beleza", new Date(Date.now() + 2000))] }).expect(200);
    await settle();

    const knocked = await admin.conversation.findFirstOrThrow({ where: { contactId: called.contactId, channelId: fx.ifood.id } });
    expect(knocked).toMatchObject({ status: "OPEN", unreadCount: 1, awaitingAgentSince: expect.any(Date) });
    // Só o pedido do telefone, como em qualquer atendimento em andamento: sem mensagem de chamado nem aviso do pedido.
    expect((await timeline(knocked.id)).flatMap((m) => (m.content as { automation?: string }).automation ?? [])).toEqual(["phone_collection"]);
    expect(await admin.conversation.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ status: "OPEN", awaitingAgentSince: expect.any(Date) });
    expect((await timeline(chat.id)).slice(before).map((m) => m.content)).toEqual(
      expect.arrayContaining([{ text: "Beleza" }, { automation: "phone_collection", text: expect.any(String) }]),
    );
    expect(await timeline(chat.id)).toHaveLength(before + 2);
    await typeOutbox();
  });

  it("pedido que ainda não chegou pelo polling, ou de outro restaurante: nada é gravado", async () => {
    expect((await post("/ifood-chat/sync", { orderCode: "9999", messages: [shown("INBOUND", "Olá", new Date())] }).expect(200)).body).toEqual({ found: false });
    const outsider = await accessTokenFor(app, other.user.email, other.a.id);
    await post("/ifood-chat/sync", { orderCode: "6530", messages: [shown("INBOUND", "Invasor", new Date())] }, outsider).expect(200);
    expect(await admin.message.count({ where: { tenantId: fx.tenant.id, content: { path: ["text"], equals: "Invasor" } } })).toBe(0);
    expect(await admin.conversation.count({ where: { tenantId: fx.tenant.id, channelId: fx.ifood.id, contactId: order.contactId } })).toBe(1);
  });

  it("só as mensagens automáticas da loja: a conversa fica em Automáticos, sem chamado, e se resolve sozinha depois de parada", async () => {
    const delivered = await ifoodOrder("6591", "Gislene Oliveira", minutesAgo(50));
    const notice = shown("OUTBOUND", "Seu pedido acaba de ser entregue 🥳", minutesAgo(40));
    await post("/ifood-chat/sync", { orderCode: "6591", messages: [notice] }).expect(200);
    const where = { tenantId: fx.tenant.id, channelId: fx.ifood.id, contactId: delivered.contactId };
    const chat = await admin.conversation.findFirstOrThrow({ where });
    expect(chat).toMatchObject({ status: "OPEN", teamInvolved: false, awaitingAgentSince: null, unreadCount: 0 });
    const { body } = await request(app.getHttpServer()).get("/api/conversations?status=AUTO").set("Authorization", `Bearer ${token}`).expect(200);
    expect(body.items.map((c: { id: string }) => c.id)).toContain(chat.id);

    await app.get(InactivityService).resolveIdleOf(fx.tenant.id);
    expect((await admin.conversation.findUniqueOrThrow({ where: { id: chat.id } })).status).toBe("RESOLVED");
    expect((await timeline(chat.id)).filter((m) => m.direction === "OUTBOUND")).toHaveLength(1); // nada foi enviado
  });

  it("usuário de vários restaurantes: o widget recebe as mesmas lojas em qualquer contexto, e a ponte grava no restaurante do pedido", async () => {
    const store = (tenantId: string, status: "CONNECTED" | "ERROR" | "DISCONNECTED") =>
      admin.channel.create({ data: { tenantId, type: "IFOOD", name: "iFood", externalId: randomUUID(), credentials: Buffer.from("x"), status } });
    const [a, b] = await Promise.all([store(other.a.id, "CONNECTED"), store(other.b.id, "ERROR")]);
    await Promise.all([store(other.b.id, "DISCONNECTED"), store(other.c.id, "CONNECTED")]); // fora: desconectada e restaurante sem acesso
    const expected = [a.externalId, b.externalId].sort();
    const tokens = await Promise.all([other.a.id, other.b.id, "master"].map((context) => accessTokenFor(app, other.user.email, context)));
    for (const bearer of tokens) {
      const { body } = await request(app.getHttpServer()).get("/api/ifood-widget").set("Authorization", `Bearer ${bearer}`).expect(200);
      expect(body.merchantIds).toEqual(expected);
    }

    // Conversa de um pedido do restaurante B lida com o painel no restaurante A (antiga: sem automações no meio do teste).
    const contact = await admin.contact.create({ data: { tenantId: other.b.id, name: "Cliente B" } });
    await admin.order.create({
      data: { tenantId: other.b.id, contactId: contact.id, channelId: b.id, externalOrderId: randomUUID(), displayCode: "7001", status: "CONFIRMED", subtotal: 10, deliveryFee: 0, total: 10, placedAt: minutesAgo(200), raw: {} },
    });
    expect((await post("/ifood-chat/sync", { orderCode: "7001", messages: [shown("INBOUND", "Cadê meu pedido?", minutesAgo(180))] }, tokens[0]).expect(200)).body).toEqual({ found: true });
    expect(await admin.message.count({ where: { tenantId: other.b.id, content: { path: ["text"], equals: "Cadê meu pedido?" } } })).toBe(1);
  });

  it("resposta pela Inbox: fica pendente, um painel só a pega, e a conversa lida do widget confirma sem duplicar", async () => {
    const chat = await conversation();
    const { body: sent } = await post(`/conversations/${chat.id}/messages`, { text: "Pode sim, sem cebola e sem picles." }).expect(201);
    expect(sent).toMatchObject({ direction: "OUTBOUND", status: "PENDING" });

    const { body: claimed } = await post("/ifood-chat/outbox/claim").expect(200);
    expect(claimed).toEqual([{ messageId: sent.id, conversationId: chat.id, orderCode: "6530", text: "Pode sim, sem cebola e sem picles." }]);
    expect((await post("/ifood-chat/outbox/claim").expect(200)).body).toEqual([]); // outro painel não leva a mesma

    await post(`/ifood-chat/outbox/${sent.id}`, { status: "SENT" }).expect(204);
    expect(await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({ status: "SENT" });

    // O widget passa a mostrar a resposta: ela já está na conversa.
    await post("/ifood-chat/sync", { orderCode: "6530", messages: [shown("OUTBOUND", "Pode sim, sem cebola e sem picles.", new Date())] }).expect(200);
    const replies = (await timeline(chat.id)).filter((m) => (m.content as { text?: string }).text === "Pode sim, sem cebola e sem picles.");
    expect(replies).toHaveLength(1);
    const confirmed = await admin.message.findUniqueOrThrow({ where: { id: sent.id } });
    expect(confirmed.externalMessageId).toMatch(/^ifood-chat:/);
    expect(await conversation()).toMatchObject({ unreadCount: 0, awaitingAgentSince: null }); // responder leu a conversa e parou o alarme
  });

  it("nenhum painel com a extensão: a resposta falha depois da espera e pode ser reenviada", async () => {
    const chat = await conversation();
    const { body: sent } = await post(`/conversations/${chat.id}/messages`, { text: "Saiu para entrega!" }).expect(201);
    const job = { data: { tenantId: fx.tenant.id, messageId: sent.id }, timestamp: Date.now() - IFOOD_CHAT_WAIT_MS - 1, attemptsMade: 0, opts: {} };
    await app.get(OutboundProcessor).process(job as Job<OutboundJob>);
    expect(await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
      status: "FAILED",
      statusError: "Nenhum painel com a extensão do iFood aberta enviou a mensagem.",
    });

    await post(`/conversations/${chat.id}/messages/${sent.id}/retry`).expect(200);
    const { body: claimed } = await post("/ifood-chat/outbox/claim").expect(200);
    expect(claimed.map((item: { messageId: string }) => item.messageId)).toEqual([sent.id]);
    await post(`/ifood-chat/outbox/${sent.id}`, { status: "FAILED", error: "O chat deste pedido não está mais aberto no iFood." }).expect(204);
    expect(await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
      status: "FAILED",
      statusError: "O chat deste pedido não está mais aberto no iFood.",
    });
  });

  it("cliente parou de responder: o atendimento é encerrado sem pesquisa, e quem já tinha sido perguntado ainda dá a nota", async () => {
    const chat = await conversation();
    for (const { id, createdAt } of await admin.message.findMany({ where: { conversationId: chat.id } })) {
      await admin.message.update({ where: { id }, data: { createdAt: new Date(createdAt.getTime() - INACTIVITY_CLOSE_MS - 60_000) } });
    }
    await app.get(InactivityService).close(fx.tenant.id, chat.id);
    const closed = await conversation();
    expect(closed.status).toBe("RESOLVED");
    expect(closed.automationState).not.toHaveProperty("survey");
    expect((await timeline(chat.id)).at(-1)!.content).toMatchObject({ automation: "inactivity_close" });
    await typeOutbox();

    // Pesquisa enviada antes de ela sair do iFood: a resposta ainda vale.
    await admin.conversation.update({ where: { id: chat.id }, data: { automationState: { ...(closed.automationState as object), survey: "awaiting_rating" } } });

    await post("/ifood-chat/sync", { orderCode: "6530", messages: [shown("INBOUND", "5", new Date())] }).expect(200);
    await settle();
    expect(await admin.rating.findFirstOrThrow({ where: { conversationId: chat.id } })).toMatchObject({ score: 5, channelType: "IFOOD", orderId: order.id });
    // A nota não abre outro atendimento: a conversa continua resolvida, sem chamar a equipe.
    expect(await conversation()).toMatchObject({ status: "RESOLVED", awaitingAgentSince: null, automationState: { survey: "answered" } });
    expect((await timeline(chat.id)).at(-1)!.content).toEqual({ automation: "survey_thanks", text: "Obrigado pela avaliação! 😊" });
  });

  it("cliente escreveu no chat do pedido: as movimentações (pronto, saiu, entregue) vão para o chat enquanto a conversa está em andamento", async () => {
    const notices = app.get(OrderNoticeService);
    const tracked = await ifoodOrder("6570", "Rafa Nunes");
    await post("/ifood-chat/sync", { orderCode: "6570", messages: [shown("INBOUND", "Vai demorar?", new Date())] }).expect(200);
    await settle();
    await typeOutbox();
    const chat = await admin.conversation.findFirstOrThrow({ where: { contactId: tracked.contactId, channelId: fx.ifood.id } });
    const sentNotices = async () =>
      (await timeline(chat.id)).map((m) => m.content as { automation?: string; text?: string }).filter((c) => c.automation?.startsWith("order_"));

    await notices.statusChanged(fx.tenant.id, tracked.id, "READY");
    await notices.statusChanged(fx.tenant.id, tracked.id, "DISPATCHED");
    await notices.statusChanged(fx.tenant.id, tracked.id, "DELIVERED");
    expect(await sentNotices()).toEqual([
      { automation: "order_ready", text: "✅ Seu pedido #6570 ficou pronto!" },
      { automation: "order_dispatched", text: expect.stringMatching(/^🛵 Boa notícia! Seu pedido #6570 saiu para entrega às \d{2}:\d{2}\.$/) },
      { automation: "order_delivered", text: "✅ Seu pedido #6570 foi entregue! Bom apetite 😋" },
    ]);
    expect((await typeOutbox()).map((item) => item.orderCode)).toEqual(["6570", "6570", "6570"]);

    // Status atualizado mais de 2 h depois do pedido (a loja concluiu atrasada): sem aviso.
    await admin.order.update({ where: { id: tracked.id }, data: { placedAt: minutesAgo(121) } });
    await notices.statusChanged(fx.tenant.id, tracked.id, "DELIVERED");
    expect(await sentNotices()).toHaveLength(3);
    // Agendado: conta do horário prometido, não da hora em que o pedido foi feito.
    await admin.order.update({ where: { id: tracked.id }, data: { raw: { delivery: { deliveryDateTime: minutesAgo(30).toISOString() } } } });
    await notices.statusChanged(fx.tenant.id, tracked.id, "DELIVERED");
    expect(await sentNotices()).toHaveLength(4);
    await typeOutbox();

    // Conversa resolvida: o cliente não está mais no chat, nada é enviado.
    await admin.conversation.update({ where: { id: chat.id }, data: { status: "RESOLVED" } });
    await notices.statusChanged(fx.tenant.id, tracked.id, "DELIVERED");
    expect(await sentNotices()).toHaveLength(4);

    // Chat só com mensagens da loja (o cliente não escreveu): também não.
    const quiet = await ifoodOrder("6571", "Sara Dias");
    await post("/ifood-chat/sync", { orderCode: "6571", messages: [shown("OUTBOUND", "Recebemos o seu pedido!", new Date())] }).expect(200);
    await notices.statusChanged(fx.tenant.id, quiet.id, "READY");
    const silent = await admin.conversation.findFirstOrThrow({ where: { contactId: quiet.contactId, channelId: fx.ifood.id } });
    expect((await timeline(silent.id)).filter((m) => (m.content as { automation?: string }).automation)).toEqual([]);
  });

  it("pedido que já saiu quando o chat começa: o aviso da saída vai logo depois do chamado, uma vez só", async () => {
    const gone = await ifoodOrder("6575", "Aydane Gomez", minutesAgo(50));
    const dispatchedAt = minutesAgo(12);
    await admin.order.update({ where: { id: gone.id }, data: { status: "DISPATCHED", dispatchedAt } });
    const first = shown("INBOUND", "Oi", minutesAgo(1));
    await post("/ifood-chat/sync", { orderCode: "6575", messages: [first] }).expect(200);
    await settle();
    const chat = await admin.conversation.findFirstOrThrow({ where: { contactId: gone.contactId, channelId: fx.ifood.id } });
    const hora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(dispatchedAt);
    expect((await typeOutbox()).filter((item) => item.conversationId === chat.id).map((item) => item.text)).toEqual([
      expect.stringContaining("Estamos chamando um atendente"),
      `🛵 Boa notícia! Seu pedido #6575 saiu para entrega às ${hora}.`,
    ]);

    // Atendimento novo na mesma conversa (o cliente voltou depois de um tempo): a saída já foi avisada.
    for (const { id, createdAt } of await admin.message.findMany({ where: { conversationId: chat.id } })) {
      await admin.message.update({ where: { id }, data: { createdAt: new Date(createdAt.getTime() - INACTIVITY_CLOSE_MS - 60_000) } });
    }
    await post("/ifood-chat/sync", { orderCode: "6575", messages: [first, shown("INBOUND", "Alguém?", new Date())] }).expect(200);
    await settle();
    const notices = (await timeline(chat.id)).filter((m) => (m.content as { automation?: string }).automation === "order_dispatched");
    expect(notices).toHaveLength(1);
    await typeOutbox();
  });

  it("loja recém-conectada: o histórico do chat e os pedidos de antes da conexão entram sem nenhuma mensagem automática", async () => {
    await admin.channel.update({ where: { id: fx.ifood.id }, data: { connectedAt: minutesAgo(5) } });
    try {
      // Pedido e mensagem do cliente de antes da conexão (dentro da janela em que a automação responderia).
      const before = await ifoodOrder("6580", "Elisa Rocha", minutesAgo(40));
      const askedAt = minutesAgo(30); // um instante só: outra leitura do relógio pode cair no minuto seguinte e o widget (só mostra a hora) o trataria como mensagem nova
      await post("/ifood-chat/sync", { orderCode: "6580", messages: [shown("INBOUND", "Esqueci de pedir guardanapo", askedAt)] }).expect(200);
      await settle();
      const chat = await admin.conversation.findFirstOrThrow({ where: { contactId: before.contactId, channelId: fx.ifood.id } });
      expect(chat).toMatchObject({ unreadCount: 1, awaitingAgentSince: null, automationState: {} });
      // As movimentações desse pedido chegam depois da conexão, mas o pedido é de antes: sem aviso.
      await app.get(OrderNoticeService).statusChanged(fx.tenant.id, before.id, "DISPATCHED");
      expect((await timeline(chat.id)).filter((m) => (m.content as { automation?: string }).automation)).toEqual([]);

      // O cliente escreve de novo depois da conexão: aí sim a automação atende.
      await post("/ifood-chat/sync", {
        orderCode: "6580",
        messages: [shown("INBOUND", "Esqueci de pedir guardanapo", askedAt), shown("INBOUND", "Alguém aí?", new Date())],
      }).expect(200);
      // A fila pode estar vazia antes de o job da mensagem nova entrar: espera o resultado, não só a fila.
      await until(async () => expect((await admin.conversation.findUniqueOrThrow({ where: { id: chat.id } })).awaitingAgentSince).not.toBeNull());
      await settle();
      await typeOutbox();
    } finally {
      await admin.channel.update({ where: { id: fx.ifood.id }, data: { connectedAt: null } });
    }
  });

  it("telefone informado que já é de outro cadastro: não une os dois (nada prova o número) e avisa a equipe", async () => {
    const tenantId = fx.tenant.id;
    const known = await admin.contact.create({
      data: {
        tenantId,
        name: "Paula do WhatsApp",
        phone: "+5511912345678",
        phoneSource: "channel",
        phoneStatus: "ok",
        firstSeenAt: new Date(Date.now() - 90 * 24 * 60 * 60_000),
        identities: { create: { tenantId, channelType: "WHATSAPP", externalId: "5511912345678" } },
      },
    });
    const paula = await ifoodOrder("6560", "PAULA S");
    const complaint = shown("INBOUND", "Oi, veio errado", new Date());
    await post("/ifood-chat/sync", { orderCode: "6560", messages: [complaint] }).expect(200);
    await settle();
    await typeOutbox();
    await post("/ifood-chat/sync", { orderCode: "6560", messages: [complaint, shown("INBOUND", "É o 11 91234-5678", new Date())] }).expect(200);
    await settle();

    // Cada um fica no seu cadastro: o telefone vai para o do chat do iFood, e a equipe decide em Clientes → Duplicados.
    const chat = await admin.conversation.findFirstOrThrow({
      where: { channelId: fx.ifood.id, contactId: paula.contactId },
      include: { contact: { include: { identities: true } } },
    });
    expect(chat.contact).toMatchObject({ phone: "+5511912345678", phoneSource: "informed_by_customer" });
    expect(chat.contact.identities.map((identity) => identity.channelType)).toEqual(["IFOOD"]);
    expect(await admin.contactIdentity.count({ where: { contactId: known.id } })).toBe(1);
    expect((await admin.order.findUniqueOrThrow({ where: { id: paula.id } })).contactId).toBe(paula.contactId);
    expect((await timeline(chat.id)).map((m) => m.content)).toContainEqual({
      event: "possible_duplicate",
      text: "Paula do WhatsApp já tem este telefone. Se for a mesma pessoa, una os cadastros em Clientes → Duplicados",
    });
    await typeOutbox();
  });

  it("entregador avisa que chegou: o cliente recebe o aviso no chat do iFood do pedido e a conversa do entregador se resolve sozinha", async () => {
    const delivery = await ifoodOrder("6540", "Elaine Rocha");
    const waId = "5511970000031";
    await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "João Entregador", tags: ["Entregador"], identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: waId } } },
    });
    const courier = () =>
      admin.conversation.findFirstOrThrow({
        where: { channelId: fx.whatsapp.id, contact: { identities: { some: { channelType: "WHATSAPP", externalId: waId } } } },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
    const say = async (id: string, body: string, automation: string) => {
      const message = { from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } };
      await postMetaWebhook(app, metaPayload(fx.whatsapp.externalId, { contacts: [{ profile: { name: "João" }, wa_id: waId }], messages: [message] })).expect(200);
      await until(async () => expect((await courier()).messages.at(-1)!.content).toMatchObject({ automation }));
    };
    await say("wamid.CHG1", "Oi", "courier_menu");
    await say("wamid.CHG2", "1", "order_number_request");
    await say("wamid.CHG3", "6540", "courier_arrival_confirmed");

    const done = await courier();
    expect(done).toMatchObject({ status: "RESOLVED", unreadCount: 0, awaitingAgentSince: null });
    expect(done.messages.at(-1)!.content).toEqual({ automation: "courier_arrival_confirmed", text: "Pronto! Avisamos o cliente do pedido #6540 que você chegou." });
    // O aviso entra na conversa do cliente no iFood (nova, já resolvida: ninguém precisa responder) e sai pelo painel.
    const chat = await admin.conversation.findFirstOrThrow({ where: { contactId: delivery.contactId, channelId: fx.ifood.id } });
    expect(chat.status).toBe("RESOLVED");
    expect((await timeline(chat.id)).map((m) => [m.status, m.content])).toEqual([
      [null, { event: "conversation_opened", text: "Conversa aberta via iFood" }],
      [null, { event: "order", orderId: delivery.id }],
      ["PENDING", { automation: "courier_arrival", text: "O entregador nos avisou que está na sua porta! 🛵" }],
    ]);
    expect(await typeOutbox()).toContainEqual({
      messageId: expect.any(String),
      conversationId: chat.id,
      orderCode: "6540",
      text: "O entregador nos avisou que está na sua porta! 🛵",
    });

    // Sem telefone no cadastro, é pelo chat do iFood que a equipe fala com o cliente do pedido.
    const get = await request(app.getHttpServer()).get(`/api/orders/${delivery.id}/customer-chat`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(get.body).toEqual({ channel: "IFOOD", contactName: "Elaine Rocha" });
    expect((await post(`/orders/${delivery.id}/customer-chat`).expect(200)).body).toEqual({ conversationId: chat.id });

    // O cliente responde ao aviso: é um atendimento novo, com o alarme.
    const notice = shown("OUTBOUND", "O entregador nos avisou que está na sua porta! 🛵", new Date());
    await post("/ifood-chat/sync", { orderCode: "6540", messages: [notice, shown("INBOUND", "Não estou vendo ele", new Date())] }).expect(200);
    await settle();
    const reopened = await admin.conversation.findUniqueOrThrow({ where: { id: chat.id } });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.awaitingAgentSince).not.toBeNull();
    expect((await timeline(chat.id)).filter((m) => (m.content as { text?: string }).text === notice.text)).toHaveLength(1);
  });

  it("entregador avisa que chegou com um pedido que não é do iFood: a equipe é chamada, com o card do pedido", async () => {
    const cardapio = await admin.channel.create({
      data: { tenantId: fx.tenant.id, type: "CARDAPIO_WEB", name: "Cardápio Web", externalId: `cw-${randomUUID()}`, credentials: Buffer.from("-"), status: "CONNECTED" },
    });
    const contact = await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Marina Souza" } });
    const order = await admin.order.create({
      data: {
        tenantId: fx.tenant.id, contactId: contact.id, channelId: cardapio.id, externalOrderId: randomUUID(), displayCode: "6590",
        status: "DISPATCHED", subtotal: 40, deliveryFee: 5, total: 45, placedAt: minutesAgo(30), raw: {},
      },
    });
    const waId = "5511970000039";
    await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "Lucas Entregador", tags: ["Entregador"], identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: waId } } },
    });
    const courier = () =>
      admin.conversation.findFirstOrThrow({
        where: { channelId: fx.whatsapp.id, contact: { identities: { some: { channelType: "WHATSAPP", externalId: waId } } } },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
    const say = async (id: string, body: string, last: object) => {
      const message = { from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } };
      await postMetaWebhook(app, metaPayload(fx.whatsapp.externalId, { contacts: [{ profile: { name: "Pedro" }, wa_id: waId }], messages: [message] })).expect(200);
      await until(async () => expect((await courier()).messages.at(-1)!.content).toMatchObject(last));
    };
    await say("wamid.CWA1", "Oi", { automation: "courier_menu" });
    await say("wamid.CWA2", "1", { automation: "order_number_request" });
    await say("wamid.CWA3", "6590", { event: "handoff" });

    const called = await courier();
    expect(called).toMatchObject({ status: "OPEN", awaitingAgentQuiet: true });
    expect(called.awaitingAgentSince).not.toBeNull();
    const contents = called.messages.map((m) => m.content);
    expect(contents).toContainEqual({ event: "order", orderId: order.id, customerChat: true });
    expect(contents).toContainEqual({ event: "handoff", text: "Entregador avisou que chegou com o pedido #6590" });
    expect(contents.some((content) => (content as { automation?: string }).automation === "order_lookup")).toBe(false); // não diz "não encontramos"
  });

  it("entregador avisa que deixou na portaria: o cliente recebe o aviso no chat do iFood do pedido e a conversa do entregador se resolve sozinha", async () => {
    const delivery = await ifoodOrder("6541", "Rita Souza");
    const waId = "5511970000032";
    await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "Pedro Entregador", tags: ["Entregador"], identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: waId } } },
    });
    const courier = () =>
      admin.conversation.findFirstOrThrow({
        where: { channelId: fx.whatsapp.id, contact: { identities: { some: { channelType: "WHATSAPP", externalId: waId } } } },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
    const say = async (id: string, body: string, automation: string) => {
      const message = { from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } };
      await postMetaWebhook(app, metaPayload(fx.whatsapp.externalId, { contacts: [{ profile: { name: "Pedro" }, wa_id: waId }], messages: [message] })).expect(200);
      await until(async () => expect((await courier()).messages.at(-1)!.content).toMatchObject({ automation }));
    };
    await say("wamid.PRT1", "Oi", "courier_menu");
    await say("wamid.PRT2", "2", "order_number_request");
    // Número errado (6441): ele confere e manda de novo, e o aviso sai com o número certo.
    await say("wamid.PRT3", "6441", "order_lookup");
    await say("wamid.PRT4", "6541", "courier_front_desk_confirmed");

    const done = await courier();
    expect(done).toMatchObject({ status: "RESOLVED", unreadCount: 0, awaitingAgentSince: null });
    expect(done.messages.at(-1)!.content).toEqual({
      automation: "courier_front_desk_confirmed",
      text: "Pronto! Avisamos o cliente do pedido #6541 que o pedido ficou na portaria.",
    });
    const chat = await admin.conversation.findFirstOrThrow({ where: { contactId: delivery.contactId, channelId: fx.ifood.id } });
    expect(chat.status).toBe("RESOLVED");
    expect((await timeline(chat.id)).map((m) => m.content)).toContainEqual({
      automation: "courier_front_desk",
      text: "📦 O entregador deixou seu pedido na portaria! Bom apetite 😋",
    });
    expect(await typeOutbox()).toContainEqual({
      messageId: expect.any(String),
      conversationId: chat.id,
      orderCode: "6541",
      text: "📦 O entregador deixou seu pedido na portaria! Bom apetite 😋",
    });
    // O aviso não muda o status do pedido: a entrega vale pelo evento do iFood.
    expect((await admin.order.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe("CONFIRMED");
  });

  it("entregador escreve o aviso numa frase, ou manda o número antes da opção: sai sem passar pelo menu", async () => {
    await ifoodOrder("6542", "Bia Lima");
    await ifoodOrder("6543", "Caio Reis");
    const waId = "5511970000033";
    await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "Ronald Entregador", tags: ["Entregador"], identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: waId } } },
    });
    const courier = () =>
      admin.conversation.findFirstOrThrow({
        where: { channelId: fx.whatsapp.id, contact: { identities: { some: { channelType: "WHATSAPP", externalId: waId } } } },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
    const say = async (id: string, body: string, automation: string) => {
      const message = { from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } };
      await postMetaWebhook(app, metaPayload(fx.whatsapp.externalId, { contacts: [{ profile: { name: "Ronald" }, wa_id: waId }], messages: [message] })).expect(200);
      await until(async () => expect((await courier()).messages.at(-1)!.content).toMatchObject({ automation }));
    };
    const automations = async () => (await courier()).messages.map((m) => (m.content as { automation?: string }).automation).filter(Boolean);

    // Tudo numa frase, na primeira mensagem: o aviso sai direto.
    await say("wamid.FREE1", "6542 tá na portaria", "courier_front_desk_confirmed");
    expect(await automations()).toEqual(["courier_front_desk_confirmed"]);

    // Atendimento novo começando pelo número: o menu pergunta o aviso, e a opção usa o número sem pedir de novo.
    await admin.message.updateMany({ where: { conversationId: (await courier()).id }, data: { createdAt: minutesAgo(60) } });
    await say("wamid.FREE2", "6543", "courier_menu");
    expect((await courier()).automationState).toMatchObject({ triage: "awaiting_option", courierOrder: "6543" });
    await say("wamid.FREE3", "1", "courier_arrival_confirmed");
    expect((await courier()).messages.at(-1)!.content).toEqual({
      automation: "courier_arrival_confirmed",
      text: "Pronto! Avisamos o cliente do pedido #6543 que você chegou.",
    });
    await typeOutbox();
  });

  it("a loja responde ao cliente pelo Gestor: conta como resposta da equipe, mas a mensagem automática dela não conta", async () => {
    const order = await ifoodOrder("6544", "Dora Melo");
    await post("/ifood-chat/sync", { orderCode: "6544", messages: [shown("INBOUND", "Cadê meu pedido?", minutesAgo(3))] }).expect(200);
    await settle();
    const chat = await admin.conversation.findFirstOrThrow({ where: { contactId: order.contactId, channelId: fx.ifood.id } });
    expect((await admin.conversation.findUniqueOrThrow({ where: { id: chat.id } })).awaitingAgentSince).not.toBeNull();

    // A loja digitou a resposta no Gestor logo depois: o alarme para e a mensagem fica marcada como da equipe.
    await post("/ifood-chat/sync", {
      orderCode: "6544",
      messages: [shown("INBOUND", "Cadê meu pedido?", minutesAgo(3)), shown("OUTBOUND", "já saiu, chega em 10 min", minutesAgo(2))],
    }).expect(200);
    await settle();
    const replied = await admin.conversation.findUniqueOrThrow({ where: { id: chat.id } });
    expect(replied).toMatchObject({ awaitingAgentSince: null, teamInvolved: true });
    expect((await timeline(chat.id)).map((m) => m.content)).toContainEqual({ text: "já saiu, chega em 10 min", storeReply: true });

    // A mensagem automática da loja (o mesmo texto já foi a outros chats) não é resposta da equipe.
    const template = "Seu pedido acaba de ser entregue 🥳";
    const other = await ifoodOrder("6545", "Edu Paz");
    await post("/ifood-chat/sync", { orderCode: "6545", messages: [shown("OUTBOUND", template, minutesAgo(9))] }).expect(200);
    const late = await ifoodOrder("6546", "Fabi Rios");
    await post("/ifood-chat/sync", {
      orderCode: "6546",
      messages: [shown("INBOUND", "o molho veio derramado", minutesAgo(2)), shown("OUTBOUND", template, minutesAgo(1))],
    }).expect(200);
    await settle();
    const lateChat = await admin.conversation.findFirstOrThrow({ where: { contactId: late.contactId, channelId: fx.ifood.id } });
    expect((await timeline(lateChat.id)).map((m) => m.content)).toContainEqual({ text: template });
    expect(other.id).toBeDefined();

    // A mensagem que o widget mostra como não enviada não entra na Inbox.
    await post("/ifood-chat/sync", {
      orderCode: "6544",
      messages: [
        shown("INBOUND", "Cadê meu pedido?", minutesAgo(3)),
        shown("OUTBOUND", "já saiu, chega em 10 min", minutesAgo(2)),
        shown("OUTBOUND", "Pode deixar na portaria.Mensagem não enviada", minutesAgo(1)),
      ],
    }).expect(200);
    expect((await timeline(chat.id)).some((m) => ((m.content as { text?: string }).text ?? "").includes("Mensagem não enviada"))).toBe(false);
  });
});

describe("Chat do iFood com o módulo Atendimento com IA", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let llm: Awaited<ReturnType<typeof startMockGraph>>;
  let token: string;
  let llmDown = false;
  let llmText = "Oi! Já vamos ver isso para você.";

  beforeAll(async () => {
    llm = await startMockGraph();
    llm.reply(() =>
      llmDown
        ? { status: 500, body: {} }
        : {
            status: 200,
            body: { choices: [{ message: { content: JSON.stringify({ reply: llmText, handoff: false, reason: "", order: "none" }) } }] },
          },
    );
    app = await createTestApp({ IFOOD_WIDGET_ID: "widget-teste", IFOOD_CHAT_BRIDGE: "true", AI_BASE_URL: llm.url });
    fx = await createChannelFixture();
    await admin.tenantModule.create({ data: { tenantId: fx.tenant.id, module: "AI" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    for (const job of await app.get<Queue>(getQueueToken(QUEUES.outbound)).getDelayed()) await job.remove();
    await fx?.cleanup();
    await app?.close();
    await llm?.close();
  });

  it("a IA responde o cliente no lugar do chamado automático, sem alarme", async () => {
    const contact = await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "Rita Melo", identities: { create: { tenantId: fx.tenant.id, channelType: "IFOOD", externalId: "cliente-7001" } } },
    });
    await admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId: contact.id,
        channelId: fx.ifood.id,
        externalOrderId: randomUUID(),
        displayCode: "7001",
        status: "CONFIRMED",
        subtotal: 40,
        deliveryFee: 5,
        total: 45,
        placedAt: minutesAgo(20),
        raw: {},
      },
    });
    await request(app.getHttpServer())
      .post("/api/ifood-chat/sync")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderCode: "7001", messages: [shown("INBOUND", "Cadê meu pedido?", minutesAgo(1))] })
      .expect(200);
    await vi.waitFor(
      async () => {
        const chat = await admin.conversation.findFirstOrThrow({ where: { tenantId: fx.tenant.id, contactId: contact.id }, include: { messages: true } });
        expect(chat.messages.some((m) => (m.content as { aiReply?: boolean }).aiReply)).toBe(true);
        expect(chat.awaitingAgentSince).toBeNull();
        expect(chat.automationState).toMatchObject({ ai: "on", linkedOrder: { id: expect.any(String) } });
        expect(chat.messages.some((m) => (m.content as { automation?: string }).automation === "handoff")).toBe(false);
        // Só a IA atendeu: a conversa fica na aba Automáticos, não em Ativos.
        expect(chat).toMatchObject({ status: "OPEN", teamInvolved: false });
      },
      { timeout: 15_000, interval: 100 },
    );
    const chat = await admin.conversation.findFirstOrThrow({ where: { tenantId: fx.tenant.id, contactId: contact.id } });
    const tab = async (status: string) =>
      (await request(app.getHttpServer()).get(`/api/conversations?status=${status}`).set("Authorization", `Bearer ${token}`).expect(200)).body.items.map(
        (c: { id: string }) => c.id,
      );
    expect(await tab("AUTO")).toContain(chat.id);
    expect(await tab("ACTIVE")).not.toContain(chat.id);
  });
  it("sem resposta da IA, o chat do iFood chama a equipe e pede o telefone, sem o menu do WhatsApp", async () => {
    llmDown = true;
    onTestFinished(() => {
      llmDown = false;
    });
    const contact = await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "Cecília Duarte", identities: { create: { tenantId: fx.tenant.id, channelType: "IFOOD", externalId: "cliente-7002" } } },
    });
    await admin.order.create({
      data: {
        tenantId: fx.tenant.id, contactId: contact.id, channelId: fx.ifood.id, externalOrderId: randomUUID(), displayCode: "7002",
        status: "DISPATCHED", subtotal: 18, deliveryFee: 5, total: 23, placedAt: minutesAgo(20), raw: {},
      },
    });
    await request(app.getHttpServer())
      .post("/api/ifood-chat/sync")
      .set("Authorization", `Bearer ${token}`)
      .send({ orderCode: "7002", messages: [shown("INBOUND", "Eu coloquei o endereço errado", minutesAgo(1))] })
      .expect(200);
    await vi.waitFor(
      async () => {
        const chat = await admin.conversation.findFirstOrThrow({ where: { tenantId: fx.tenant.id, contactId: contact.id }, include: { messages: true } });
        const contents = chat.messages.map((m) => m.content as { automation?: string; event?: string; text?: string });
        expect(contents.some((c) => c.automation === "handoff")).toBe(true);
        expect(contents.some((c) => c.automation === "menu")).toBe(false);
        expect(contents.find((c) => c.event === "ai_fallback")?.text).toMatch(/^A IA não respondeu \(.+\): a equipe foi chamada$/);
        expect(chat.awaitingAgentSince).not.toBeNull();
        expect(chat.automationState).toMatchObject({ ai: "off", phoneCollection: "awaiting_phone" });
      },
      { timeout: 15_000, interval: 100 },
    );
  });

  /** Cliente com dois pedidos na loja: uma conversa só na Inbox, um chat por pedido no iFood. */
  const twoOrders = async (name: string, older: string, newer: string) => {
    const contact = await admin.contact.create({
      data: { tenantId: fx.tenant.id, name, identities: { create: { tenantId: fx.tenant.id, channelType: "IFOOD", externalId: `cliente-${older}` } } },
    });
    for (const [code, placedAt] of [[older, minutesAgo(50)], [newer, minutesAgo(40)]] as const) {
      await admin.order.create({
        data: {
          tenantId: fx.tenant.id, contactId: contact.id, channelId: fx.ifood.id, externalOrderId: randomUUID(), displayCode: code,
          status: "DISPATCHED", subtotal: 30, deliveryFee: 5, total: 35, placedAt, raw: {},
        },
      });
    }
    return contact;
  };
  const sync = (orderCode: string, messages: ReturnType<typeof shown>[]) =>
    request(app.getHttpServer()).post("/api/ifood-chat/sync").set("Authorization", `Bearer ${token}`).send({ orderCode, messages }).expect(200);

  it("cliente com dois pedidos escreve no chat de um: a IA só vê esse pedido e esse chat, e a resposta sai nele (13/11)", async () => {
    const contact = await twoOrders("Manoel Neto", "7101", "7102");
    // O chat do outro pedido já tinha uma mensagem da loja.
    await sync("7102", [shown("OUTBOUND", "Pedido 7102 recebido, obrigado!", minutesAgo(5))]);
    await sync("7101", [shown("INBOUND", "ola bom dia teve algum problema", minutesAgo(1))]);
    const chat = await vi.waitFor(
      async () => {
        const found = await admin.conversation.findFirstOrThrow({ where: { tenantId: fx.tenant.id, contactId: contact.id }, include: { messages: true } });
        expect(found.messages.some((m) => (m.content as { aiReply?: boolean }).aiReply)).toBe(true);
        return found;
      },
      { timeout: 15_000, interval: 100 },
    );
    const prompt = llm.requests
      .map((r) => JSON.stringify(r.body))
      .find((body) => body.includes("teve algum problema"))!;
    expect(prompt).toContain("#7101");
    expect(prompt).toContain("Este chat é só do pedido #7101");
    expect(prompt).not.toContain("7102");

    const { body } = await request(app.getHttpServer()).post("/api/ifood-chat/outbox/claim").set("Authorization", `Bearer ${token}`).expect(200);
    expect(body.filter((item: { conversationId: string }) => item.conversationId === chat.id)).toEqual([
      expect.objectContaining({ orderCode: "7101", text: "Oi! Já vamos ver isso para você." }),
    ]);
  });

  it("a resposta da IA cita outro número de pedido: não sai, e a equipe é chamada", async () => {
    llmText = "Pelo nosso registro, o pedido é o #7104 (e não o #7103 que citei antes).";
    onTestFinished(() => {
      llmText = "Oi! Já vamos ver isso para você.";
    });
    const contact = await twoOrders("Davi Reis", "7103", "7104");
    await sync("7103", [shown("INBOUND", "o pedido saiu para entrega, e até agora nada", minutesAgo(1))]);
    await vi.waitFor(
      async () => {
        const chat = await admin.conversation.findFirstOrThrow({ where: { tenantId: fx.tenant.id, contactId: contact.id }, include: { messages: true } });
        const contents = chat.messages.map((m) => m.content as { automation?: string; event?: string; text?: string; aiReply?: boolean });
        expect(contents.find((c) => c.event === "ai_fallback")?.text).toBe(
          "A IA não respondeu (a resposta citou o pedido #7104, e este chat é do #7103): a equipe foi chamada",
        );
        expect(contents.some((c) => c.automation === "handoff")).toBe(true);
        expect(contents.some((c) => c.aiReply)).toBe(false);
        expect(chat.awaitingAgentSince).not.toBeNull();
      },
      { timeout: 15_000, interval: 100 },
    );
  });
});
