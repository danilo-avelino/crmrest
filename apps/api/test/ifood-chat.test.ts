import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { INACTIVITY_CLOSE_MS, InactivityService } from "../src/automations/inactivity.service.js";
import { OrderNoticeService } from "../src/orders/order-notice.service.js";
import { IFOOD_CHAT_WAIT_MS, OutboundProcessor } from "../src/outbound/outbound.processor.js";
import { type OutboundJob, QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createAuthFixture, createChannelFixture, createTestApp, metaPayload, postMetaWebhook } from "./helpers.js";

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

  const automatic = shown("OUTBOUND", "Recebemos o seu pedido!", minutesAgo(19));
  const question = shown("INBOUND", "Oi, pode mandar sem cebola?", minutesAgo(10));
  const second = shown("INBOUND", "E sem picles", minutesAgo(9));

  it("conversa lida do widget: abre a conversa do cliente com o pedido e as mensagens, sem repetir na leitura seguinte", async () => {
    expect((await post("/ifood-chat/sync", { orderCode: "6530", messages: [automatic, question] }).expect(200)).body).toEqual({ found: true });

    const chat = await conversation();
    expect(chat).toMatchObject({ contactId: order.contactId, status: "OPEN", unreadCount: 1 });
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

  it("pedido que ainda não chegou pelo polling, ou de outro restaurante: nada é gravado", async () => {
    expect((await post("/ifood-chat/sync", { orderCode: "9999", messages: [shown("INBOUND", "Olá", new Date())] }).expect(200)).body).toEqual({ found: false });
    const outsider = await accessTokenFor(app, other.user.email, other.a.id);
    await post("/ifood-chat/sync", { orderCode: "6530", messages: [shown("INBOUND", "Invasor", new Date())] }, outsider).expect(200);
    expect(await admin.message.count({ where: { tenantId: fx.tenant.id, content: { path: ["text"], equals: "Invasor" } } })).toBe(0);
    expect(await admin.conversation.count({ where: { tenantId: fx.tenant.id, channelId: fx.ifood.id, contactId: order.contactId } })).toBe(1);
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

  it("cliente parou de responder: o atendimento é encerrado e a avaliação pedida; a nota fica marcada com o canal iFood", async () => {
    const chat = await conversation();
    for (const { id, createdAt } of await admin.message.findMany({ where: { conversationId: chat.id } })) {
      await admin.message.update({ where: { id }, data: { createdAt: new Date(createdAt.getTime() - INACTIVITY_CLOSE_MS - 60_000) } });
    }
    await app.get(InactivityService).close(fx.tenant.id, chat.id);
    expect(await conversation()).toMatchObject({ status: "RESOLVED", automationState: { survey: "awaiting_rating" } });
    expect((await timeline(chat.id)).slice(-2).map((m) => (m.content as { automation?: string }).automation)).toEqual(["inactivity_close", "survey"]);
    expect((await typeOutbox()).at(-1)!.text).toBe("Qual nota você dá para nosso atendimento? Digite de 1 a 5");

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

    // Conversa resolvida: o cliente não está mais no chat, nada é enviado.
    await admin.conversation.update({ where: { id: chat.id }, data: { status: "RESOLVED" } });
    await notices.statusChanged(fx.tenant.id, tracked.id, "DELIVERED");
    expect(await sentNotices()).toHaveLength(3);

    // Chat só com mensagens da loja (o cliente não escreveu): também não.
    const quiet = await ifoodOrder("6571", "Sara Dias");
    await post("/ifood-chat/sync", { orderCode: "6571", messages: [shown("OUTBOUND", "Recebemos o seu pedido!", new Date())] }).expect(200);
    await notices.statusChanged(fx.tenant.id, quiet.id, "READY");
    const silent = await admin.conversation.findFirstOrThrow({ where: { contactId: quiet.contactId, channelId: fx.ifood.id } });
    expect((await timeline(silent.id)).filter((m) => (m.content as { automation?: string }).automation)).toEqual([]);
  });

  it("loja recém-conectada: o histórico do chat e os pedidos de antes da conexão entram sem nenhuma mensagem automática", async () => {
    await admin.channel.update({ where: { id: fx.ifood.id }, data: { connectedAt: minutesAgo(5) } });
    try {
      // Pedido e mensagem do cliente de antes da conexão (dentro da janela em que a automação responderia).
      const before = await ifoodOrder("6580", "Elisa Rocha", minutesAgo(40));
      await post("/ifood-chat/sync", { orderCode: "6580", messages: [shown("INBOUND", "Esqueci de pedir guardanapo", minutesAgo(30))] }).expect(200);
      await settle();
      const chat = await admin.conversation.findFirstOrThrow({ where: { contactId: before.contactId, channelId: fx.ifood.id } });
      expect(chat).toMatchObject({ unreadCount: 1, awaitingAgentSince: null, automationState: {} });
      // As movimentações desse pedido chegam depois da conexão, mas o pedido é de antes: sem aviso.
      await app.get(OrderNoticeService).statusChanged(fx.tenant.id, before.id, "DISPATCHED");
      expect((await timeline(chat.id)).filter((m) => (m.content as { automation?: string }).automation)).toEqual([]);

      // O cliente escreve de novo depois da conexão: aí sim a automação atende.
      await post("/ifood-chat/sync", {
        orderCode: "6580",
        messages: [shown("INBOUND", "Esqueci de pedir guardanapo", minutesAgo(30)), shown("INBOUND", "Alguém aí?", new Date())],
      }).expect(200);
      await settle();
      expect((await admin.conversation.findUniqueOrThrow({ where: { id: chat.id } })).awaitingAgentSince).not.toBeNull();
      await typeOutbox();
    } finally {
      await admin.channel.update({ where: { id: fx.ifood.id }, data: { connectedAt: null } });
    }
  });

  it("telefone informado que já é de outro cadastro: os dois viram um, com os canais e os pedidos de ambos", async () => {
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

    // Fica o cadastro mais antigo (o do WhatsApp), agora também com o iFood; a conversa e o pedido passam para ele.
    const chat = await admin.conversation.findFirstOrThrow({
      where: { channelId: fx.ifood.id, contactId: known.id },
      include: { contact: { include: { identities: true } } },
    });
    expect(chat.contact).toMatchObject({ name: "Paula do WhatsApp", phone: "+5511912345678", phoneSource: "channel" });
    expect(chat.contact.identities.map((identity) => identity.channelType).sort()).toEqual(["IFOOD", "WHATSAPP"]);
    expect(await admin.contact.findUnique({ where: { id: paula.contactId } })).toBeNull();
    expect((await admin.order.findUniqueOrThrow({ where: { id: paula.id } })).contactId).toBe(known.id);
    expect((await timeline(chat.id)).map((m) => m.content)).toContainEqual({
      event: "contacts_merged",
      text: "Cadastro unificado com o de Paula do WhatsApp, que já tinha este telefone",
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
});
