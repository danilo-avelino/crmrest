import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPhone, PhoneCollectionService } from "../src/automations/phone-collection.service.js";
import { parseInstagram } from "../src/connectors/instagram.connector.js";
import {
  admin,
  createChannelFixture,
  createTestApp,
  drainQueues,
  instagramPayload,
  instagramText,
  postMetaWebhook,
  startMockGraph,
} from "./helpers.js";

describe("webhook do Instagram", () => {
  it("lê texto e anexos, ignora ecos e converte leitura em status", () => {
    const now = Date.now();
    const { messages, statuses } = parseInstagram("01a10330-b8c8-750e-95d2-fcb1c581d8de", [
      { sender: { id: "IGSID1" }, recipient: { id: "IG" }, timestamp: now, message: { mid: "m1", text: "Oi" } },
      {
        sender: { id: "IGSID1" },
        timestamp: now,
        message: { mid: "m2", attachments: [{ type: "image", payload: { url: "https://cdn.example/foto.jpg" } }] },
      },
      { sender: { id: "IGSID1" }, timestamp: now, message: { mid: "m3", attachments: [{ type: "story_mention", payload: {} }] } },
      { sender: { id: "IG" }, timestamp: now, message: { mid: "m4", text: "resposta da loja", is_echo: true } },
      { sender: { id: "IGSID1" }, timestamp: now, read: { mid: "mid.OUT1" } },
    ]);
    expect(messages.map((m) => [m.externalMessageId, m.type, m.text])).toEqual([
      ["m1", "TEXT", "Oi"],
      ["m2", "IMAGE", undefined],
      ["m3", "TEXT", "Mencionou o restaurante nos stories."],
    ]);
    expect(messages[1]!.media).toEqual({ mimeType: "image/*", url: "https://cdn.example/foto.jpg" });
    expect(statuses).toEqual([expect.objectContaining({ externalMessageId: "mid.OUT1", status: "READ" })]);
  });

  it("acha o telefone no meio da resposta do cliente", () => {
    expect(extractPhone("meu número é (11) 97654-3210, obrigada")).toBe("+5511976543210");
    expect(extractPhone("11976543210")).toBe("+5511976543210");
    expect(extractPhone("pedido 485329 de ontem")).toBeNull();
  });
});

describe("Instagram e coleta de telefone (§5.3)", () => {
  const IG_APP_SECRET = "segredo-do-app-do-instagram";
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;

  beforeAll(async () => {
    graph = await startMockGraph();
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", INSTAGRAM_GRAPH_URL: graph.url, INSTAGRAM_APP_SECRET: IG_APP_SECRET });
    fx = await createChannelFixture();
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await graph?.close();
  });

  const send = async (senderId: string, mid: string, text: string) => {
    await postMetaWebhook(app, instagramPayload(fx.instagram.externalId, [instagramText(senderId, fx.instagram.externalId, mid, text)])).expect(200);
    await drainQueues(app);
  };
  const conversationOf = (senderId: string) =>
    admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, contact: { identities: { some: { channelType: "INSTAGRAM", externalId: senderId } } } },
      include: { contact: { include: { identities: true } }, messages: { orderBy: { createdAt: "asc" } } },
    });

  const automationsOf = (conversation: Awaited<ReturnType<typeof conversationOf>>) =>
    conversation.messages.map((m) => (m.content as { automation?: string }).automation).filter(Boolean);

  it("primeiro contato: cliente com nome do perfil e menu de atendimento", async () => {
    await send("IGSID-FERNANDA", "mid.in1", "Oi, boa noite");
    const conversation = await conversationOf("IGSID-FERNANDA");

    expect(conversation.contact).toMatchObject({ name: "Fernanda Lima", phone: null });
    expect(conversation.contact.identities[0]!.profile).toMatchObject({ username: "fe.lima" });
    expect(conversation.automationState).toEqual({ triage: "awaiting_option" });

    const menu = conversation.messages.find((m) => (m.content as { automation?: string }).automation === "menu");
    expect(menu).toMatchObject({ direction: "OUTBOUND", status: "SENT", externalMessageId: expect.stringMatching(/^mid\.MOCK/) });
    expect((menu!.content as { text: string }).text).toMatch(/^Olá, Fernanda! 👋 Em que podemos ajudar\?/);
    expect(graph.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/${fx.instagram.externalId}/messages`,
      body: { recipient: { id: "IGSID-FERNANDA" }, message: { text: expect.stringContaining("1 - Falar sobre um pedido") } },
    });
  });

  it("outro assunto: encaminha para a equipe e pede o telefone", async () => {
    await send("IGSID-FERNANDA", "mid.in1b", "3");
    const conversation = await conversationOf("IGSID-FERNANDA");

    expect(conversation.automationState).toEqual({ triage: "done", phoneCollection: "awaiting_phone" });
    expect(automationsOf(conversation)).toEqual(["menu", "handoff", "phone_collection"]);
    expect(graph.requests.at(-1)).toMatchObject({
      body: { recipient: { id: "IGSID-FERNANDA" }, message: { text: expect.stringContaining("telefone com DDD") } },
    });
  });

  it("resposta com o telefone: cadastro, evento na conversa e confirmação", async () => {
    await send("IGSID-FERNANDA", "mid.in2", "claro, é (11) 97654-3210");
    const conversation = await conversationOf("IGSID-FERNANDA");

    expect(conversation.contact).toMatchObject({ phone: "+5511976543210", phoneSource: "informed_by_customer", phoneStatus: "ok" });
    expect(conversation.automationState).toEqual({ triage: "done", phoneCollection: "phone_collected" });
    const content = conversation.messages.map((m) => m.content as { event?: string; automation?: string });
    expect(content.some((c) => c.event === "phone_collected")).toBe(true);
    expect(content.some((c) => c.automation === "phone_confirmation")).toBe(true);

    // Novas mensagens não disparam a coleta de novo.
    const before = conversation.messages.length;
    await send("IGSID-FERNANDA", "mid.in3", "obrigada!");
    expect((await conversationOf("IGSID-FERNANDA")).messages.length).toBe(before + 1);
  });

  it("sem resposta: um lembrete e depois o telefone fica pendente", async () => {
    await send("IGSID-SILENCIOSO", "mid.in4", "Oi");
    // Uma pergunta em vez de uma opção do menu: segue com a equipe, e a coleta de telefone começa.
    await send("IGSID-SILENCIOSO", "mid.in4b", "Vocês abrem amanhã?");
    const { id } = await conversationOf("IGSID-SILENCIOSO");
    const phoneCollection = app.get(PhoneCollectionService);

    await phoneCollection.remind(fx.tenant.id, id);
    await phoneCollection.remind(fx.tenant.id, id); // só um lembrete
    await drainQueues(app);
    let conversation = await conversationOf("IGSID-SILENCIOSO");
    expect(automationsOf(conversation)).toEqual(["menu", "phone_collection", "phone_reminder"]);

    await phoneCollection.giveUp(fx.tenant.id, id);
    conversation = await conversationOf("IGSID-SILENCIOSO");
    expect(conversation.automationState).toMatchObject({ phoneCollection: "phone_skipped" });
    expect(conversation.contact.phoneStatus).toBe("pending");
    expect(conversation.messages.at(-1)!.content).toMatchObject({ event: "phone_pending" });
  });

  it("aceita o webhook assinado com o segredo do app do Instagram", async () => {
    const payload = instagramPayload(fx.instagram.externalId, [instagramText("IGSID-ASSINADO", fx.instagram.externalId, "mid.in5", "Oi")]);
    await postMetaWebhook(app, payload, "segredo-errado").expect(401);
    await postMetaWebhook(app, payload, IG_APP_SECRET).expect(200);
    await drainQueues(app);
    const { messages } = await conversationOf("IGSID-ASSINADO");
    expect(messages.find((m) => m.externalMessageId === "mid.in5")).toMatchObject({ direction: "INBOUND" });
  });

  it("falar sobre um pedido: acha o pedido do iFood ligado ao mesmo cadastro, sem pedir o número", async () => {
    await send("IGSID-PAULO", "mid.p1", "Oi");
    const { contactId } = await conversationOf("IGSID-PAULO");
    // Cadastro com o Instagram e o iFood vinculados (ex.: unidos antes): o pedido do iFood é dele.
    const order = await admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId,
        channelId: fx.ifood.id,
        externalOrderId: `pedido-ig-${Date.now()}`,
        displayCode: "3131",
        status: "CONFIRMED",
        subtotal: "30.00",
        deliveryFee: "0.00",
        total: "30.00",
        placedAt: new Date(),
        raw: {},
        items: { create: { tenantId: fx.tenant.id, name: "Açaí 500ml", quantity: 1, unitPrice: "30.00" } },
      },
    });

    await send("IGSID-PAULO", "mid.p2", "1");
    const conversation = await conversationOf("IGSID-PAULO");
    expect(conversation.automationState).toEqual({ triage: "awaiting_order_confirmation", foundOrderId: order.id, autoFound: true });
    expect(automationsOf(conversation)).toEqual(["menu", "order_lookup"]);
    expect((conversation.messages.at(-1)!.content as { text: string }).text).toMatch(/^Encontramos o pedido #3131 \(confirmado\):\n• 1x Açaí 500ml/);
  });

  it("canal que já informa o telefone (WhatsApp) não dispara a coleta", async () => {
    const whatsapp = (id: string, body: string) =>
      postMetaWebhook(app, {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: fx.whatsapp.externalId },
                  messages: [{ from: "5511944443333", id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
                },
              },
            ],
          },
        ],
      }).expect(200);
    await whatsapp("wamid.SEMCOLETA", "Oi");
    await drainQueues(app);
    await whatsapp("wamid.SEMCOLETA2", "3"); // fim do menu: aqui o Instagram pediria o telefone
    await drainQueues(app);
    const conversation = await admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, contact: { phone: "+5511944443333" } },
    });
    expect(conversation.automationState).toEqual({ triage: "done" });
  });
});
