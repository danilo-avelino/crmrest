import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicLlmProvider, type MessagesApi } from "../src/ai/llm-provider.js";
import type { Env } from "../src/config/env.js";
import { interactiveLayout } from "../src/connectors/connector.js";
import { WhatsAppConnector } from "../src/connectors/whatsapp.connector.js";
import { DatabaseService } from "../src/core/database.service.js";
import { normalizeChoice, numberedText, OFFER_TTL_MS, resolveChoice } from "../src/menu-agent/choices.js";
import { ORDER_AGENT_LLM, OrderAgentService } from "../src/menu-agent/order-agent.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { PresenceService } from "../src/realtime/presence.service.js";
import { admin, createChannelFixture, createTestApp, drainQueues, metaPayload, postMetaWebhook, startMockGraph } from "./helpers.js";

type Content = { text?: string; aiReply?: boolean; event?: string; choices?: { question: string; options: { id: string; title: string }[] } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicBody = any;

const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const text = (value: string) => ({ content: [{ type: "text", text: value }], stop_reason: "end_turn", usage });
const toolUse = (id: string, name: string, input: unknown) => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage });
const SIZES = [
  { id: "g", titulo: "Grande" },
  { id: "m", titulo: "Média" },
];
const offer = (options = SIZES) => [toolUse("o1", "oferecer_opcoes", { pergunta: "Qual tamanho?", opcoes: options }), text("Qual tamanho você quer?")];

describe("opções fechadas em texto numerado e botões da Cloud API (F4-05): lógica", () => {
  const options = [
    { id: "g", title: "Grande" },
    { id: "m", title: "Média" },
    { id: "b", title: "Brotinho" },
  ];

  it("resolve número, palavra, ordinal, título sem acento e id de botão", () => {
    const pick = (value: string) => resolveChoice(options, value)?.id;
    expect(pick("2")).toBe("m");
    expect(pick("2.")).toBe("m");
    expect(pick("dois")).toBe("m");
    expect(pick("Dois!")).toBe("m");
    expect(pick("a segunda")).toBe("m");
    expect(pick("o terceiro")).toBe("b");
    expect(pick("opção 1")).toBe("g");
    expect(pick("quero a 3")).toBe("b");
    expect(pick("media")).toBe("m");
    expect(pick("MÉDIA")).toBe("m");
    expect(pick("quero a brotinho")).toBe("b");
    expect(pick("brot")).toBe("b");
    expect(resolveChoice(options, "qualquer coisa", "g")?.id).toBe("g");
    expect(resolveChoice(options, "Grande", "x")).toBeNull(); // id de outra oferta: não vale
  });

  it("não é escolha: fora do intervalo, texto livre, vazio ou parte ambígua", () => {
    for (const value of ["4", "zero", "quero uma pizza de calabresa", "", "   ", "!!!", "a", "é"]) expect(resolveChoice(options, value), value).toBeNull();
    const ambiguous = [
      { id: "1", title: "Pizza grande" },
      { id: "2", title: "Pizza média" },
    ];
    expect(resolveChoice(ambiguous, "pizza")).toBeNull();
    expect(resolveChoice(ambiguous, "grande")?.id).toBe("1");
    expect(resolveChoice(options, undefined)).toBeNull();
    expect(normalizeChoice("  A   Segunda! ")).toBe("a segunda");
  });

  it("texto numerado e limites de botões e lista", () => {
    expect(numberedText("Qual tamanho?", options, "Responda com o número da opção.")).toBe("Qual tamanho?\n\n1. Grande\n2. Média\n3. Brotinho\n\nResponda com o número da opção.");
    expect(interactiveLayout({ body: "?", options })).toBe("buttons");
    expect(interactiveLayout({ body: "?", options: [...options, { id: "x", title: "Gigante" }] })).toBe("list");
    expect(interactiveLayout({ body: "?", options: [{ id: "a", title: "x".repeat(21) }] })).toBe("list");
    expect(interactiveLayout({ body: "?", options: [{ id: "a", title: "x".repeat(25) }] })).toBeNull();
    expect(interactiveLayout({ body: "?", options: Array.from({ length: 11 }, (_, i) => ({ id: String(i), title: "o" })) })).toBeNull();
    expect(interactiveLayout({ body: "x".repeat(1025), options })).toBeNull();
    expect(interactiveLayout({ body: "", options })).toBeNull();
  });

  it("conector da Cloud API monta botões e lista", async () => {
    const sent: { url: string; body: { to: string; type: string; interactive: Record<string, unknown> } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
    });
    try {
      const cloud = new WhatsAppConnector({ META_GRAPH_URL: "http://graph", CHANNELS_DRY_RUN: false, META_APP_ID: "a", META_APP_SECRET: "b" });
      expect(cloud.capabilities).toEqual({ interactive: true });
      const target = { externalChannelId: "123", recipientId: "5511999990000", accessToken: "t" };
      await cloud.sendInteractive(target, { body: "Qual tamanho?", options });
      await cloud.sendInteractive(target, { body: "Qual?", options: [...options, { id: "x", title: "Gigante" }] });
      expect(sent[0]!.url).toBe("http://graph/123/messages");
      expect(sent[0]!.body.interactive).toEqual({
        type: "button",
        body: { text: "Qual tamanho?" },
        action: { buttons: options.map((o) => ({ type: "reply", reply: { id: o.id, title: o.title } })) },
      });
      expect(sent[1]!.body.interactive).toMatchObject({ type: "list", action: { button: "Ver opções", sections: [{ rows: [{ id: "g", title: "Grande" }, {}, {}, { id: "x" }] }] } });
      await expect(cloud.sendInteractive(target, { body: "?", options: [{ id: "a", title: "x".repeat(30) }] })).rejects.toThrow("não cabem");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("agente de pedidos: opções no WhatsApp da API oficial e por QR Code (F4-05)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let llm: Awaited<ReturnType<typeof startMockGraph>>;
  let qrChannelId: string;
  let aiQueue: Queue;
  let script: unknown[] = [];
  let anthropicCalls: AnthropicBody[] = [];
  let sentCount = 0;
  const api = {
    create: async (body: unknown) => {
      anthropicCalls.push(structuredClone(body));
      const next = script.shift();
      if (!next) throw new Error("API do Claude fora do ar");
      return next;
    },
  } as unknown as MessagesApi;

  beforeAll(async () => {
    graph = await startMockGraph();
    llm = await startMockGraph(); // o atendente com IA (triage) só precisa de um endereço; o agente usa o SDK falso
    llm.reply(() => ({ status: 500, body: {} }));
    graph.reply((req) =>
      req.path.startsWith("/message/sendText/")
        ? { status: 201, body: { key: { id: `3EB0QR${++sentCount}` } } }
        : { status: 200, body: { messages: [{ id: `wamid.CH${++sentCount}` }] } },
    );
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", META_GRAPH_URL: graph.url, EVOLUTION_API_URL: graph.url, AI_BASE_URL: llm.url }, (builder) =>
      builder
        .overrideProvider(ORDER_AGENT_LLM)
        .useFactory({ factory: (db: DatabaseService) => new AnthropicLlmProvider({} as Env, db, api), inject: [DatabaseService] }),
    );
    aiQueue = app.get<Queue>(getQueueToken(QUEUES.ai));
    fx = await createChannelFixture();
    await admin.tenantModule.createMany({
      data: [
        { tenantId: fx.tenant.id, module: "AI" },
        { tenantId: fx.tenant.id, module: "MENU" },
      ],
    });
    const menu = await admin.menu.create({ data: { tenantId: fx.tenant.id, name: "Cardápio" } });
    const category = await admin.menuCategory.create({ data: { tenantId: fx.tenant.id, menuId: menu.id, name: "Pizzas" } });
    await admin.menuItem.create({
      data: { tenantId: fx.tenant.id, categoryId: category.id, name: "Calabresa", sizes: { create: [{ tenantId: fx.tenant.id, name: "G", priceCents: 5000 }] } },
    });
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
    const qr = await admin.channel.create({
      data: {
        tenantId: fx.tenant.id,
        type: "WHATSAPP",
        name: "WhatsApp QR",
        externalId: "5511900000000",
        credentials: encrypt(JSON.stringify({ accessToken: "token-qr", instance: "inst-choices" }), key),
        status: "CONNECTED",
      },
    });
    qrChannelId = qr.id;
  });

  beforeEach(async () => {
    await app.get(PresenceService).join("painel-de-teste", [fx.tenant.id]);
    script = [];
    anthropicCalls = [];
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await graph?.close();
    await llm?.close();
  });

  const settle = async () => {
    await drainQueues(app);
    await vi.waitFor(
      async () => {
        const jobs = await aiQueue.getJobs(["waiting", "active", "delayed", "prioritized"]);
        expect(jobs.filter((job) => job.name === "reply")).toHaveLength(0);
      },
      { timeout: 15_000, interval: 100 },
    );
    await drainQueues(app);
  };
  const post = async (waId: string, message: Record<string, unknown>) => {
    await postMetaWebhook(
      app,
      metaPayload(fx.whatsapp.externalId, {
        contacts: [{ profile: { name: "Ana Souza" }, wa_id: waId }],
        messages: [{ from: waId, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
      }),
    ).expect(200);
    await settle();
  };
  const say = (waId: string, id: string, body: string) => post(waId, { id, type: "text", text: { body } });
  const conversationOf = (waId: string) =>
    admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, contact: { identities: { some: { channelType: "WHATSAPP", externalId: waId } } } },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  const lastReply = async (waId: string) =>
    (await conversationOf(waId)).messages
      .map((m) => m.content as Content)
      .filter((c) => c.aiReply)
      .at(-1)!;
  const lastUser = () => anthropicCalls[0].messages.at(-1).content as string;

  it("API oficial: botões no WhatsApp, o texto numerado na Inbox e as opções guardadas na conversa", async () => {
    script = offer();
    await say("5511980000001", "wamid.CH-1", "Quero uma calabresa");
    const reply = await lastReply("5511980000001");
    expect(reply.text).toBe("Qual tamanho você quer?\n\n1. Grande\n2. Média\n\nResponda com o número da opção.");
    expect(reply.choices).toEqual({
      question: "Qual tamanho você quer?",
      options: [
        { id: "g", title: "Grande" },
        { id: "m", title: "Média" },
      ],
    });
    const body = graph.requests.at(-1)!.body as { type: string; interactive: Record<string, unknown> };
    expect(body.type).toBe("interactive");
    expect(body.interactive).toEqual({
      type: "button",
      body: { text: "Qual tamanho você quer?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "g", title: "Grande" } },
          { type: "reply", reply: { id: "m", title: "Média" } },
        ],
      },
    });
    expect((await conversationOf("5511980000001")).automationState).toMatchObject({
      offered: {
        options: [
          { id: "g", title: "Grande" },
          { id: "m", title: "Média" },
        ],
      },
    });
    expect(anthropicCalls[0].tools.map((tool: { name: string }) => tool.name)).toContain("oferecer_opcoes");
  });

  it("toque no botão: o id vira a escolha; o texto do cliente segue como ele mandou", async () => {
    script = offer();
    await say("5511980000002", "wamid.CH-2a", "Quero uma calabresa");
    script = [text("Média, anotado!")];
    anthropicCalls = [];
    await post("5511980000002", { id: "wamid.CH-2b", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "m", title: "Média" } } });
    expect(lastUser()).toBe("Média\n(cliente escolheu: Média)");
    const state = (await conversationOf("5511980000002")).automationState as { offered?: unknown };
    expect(state.offered).toBeUndefined(); // sem nova oferta, a anterior é limpa
  });

  it('"2", "dois" e o título resolvem a opção; texto sem relação não', async () => {
    const cases = [
      ["2", "Média"],
      ["dois", "Média"],
      ["a primeira", "Grande"],
      ["MEDIA", "Média"],
    ] as const;
    for (const [index, [reply, expected]] of cases.entries()) {
      const waId = `551198000010${index}`;
      script = offer();
      await say(waId, `wamid.CH-3a${index}`, "Quero uma calabresa");
      script = [text("Anotado.")];
      anthropicCalls = [];
      await say(waId, `wamid.CH-3b${index}`, reply);
      expect(lastUser(), reply).toBe(`${reply}\n(cliente escolheu: ${expected})`);
    }
    script = offer();
    await say("5511980000200", "wamid.CH-4a", "Quero uma calabresa");
    script = [text("Certo.")];
    anthropicCalls = [];
    await say("5511980000200", "wamid.CH-4b", "e tem refri?");
    expect(lastUser()).toBe("e tem refri?");
  }, 90_000);

  it("opções vencidas (mais de 30 minutos) são ignoradas", async () => {
    script = offer();
    await say("5511980000003", "wamid.CH-5a", "Quero uma calabresa");
    const conversation = await conversationOf("5511980000003");
    const state = conversation.automationState as { offered: { options: unknown[]; at: string } };
    await admin.conversation.update({
      where: { id: conversation.id },
      data: { automationState: { ...state, offered: { options: state.offered.options, at: new Date(Date.now() - OFFER_TTL_MS - 60_000).toISOString() } } as object },
    });
    script = [text("Qual tamanho?")];
    anthropicCalls = [];
    await say("5511980000003", "wamid.CH-5b", "2");
    expect(lastUser()).toBe("2");
  });

  it("mais de 3 opções (até 24 caracteres): lista do WhatsApp", async () => {
    script = offer(["P", "M", "G", "GG"].map((id) => ({ id, titulo: `Tamanho ${id}` })));
    await say("5511980000004", "wamid.CH-6", "Quero uma calabresa");
    const body = graph.requests.at(-1)!.body as { interactive: { type: string; action: { button: string; sections: { rows: unknown[] }[] } } };
    expect(body.interactive.type).toBe("list");
    expect(body.interactive.action.sections[0]!.rows).toEqual(["P", "M", "G", "GG"].map((id) => ({ id, title: `Tamanho ${id}` })));
  });

  it("título longo demais para a Cloud API: sai o texto numerado", async () => {
    script = offer([
      { id: "a", titulo: "Pizza calabresa grande com borda recheada" },
      { id: "b", titulo: "Outra" },
    ]);
    await say("5511980000005", "wamid.CH-7", "Quero uma calabresa");
    const body = graph.requests.at(-1)!.body as { type: string; text: { body: string } };
    expect(body.type).toBe("text");
    expect(body.text.body).toContain("1. Pizza calabresa grande com borda recheada");
  });

  it("QR Code (Evolution): sempre texto numerado, sem botões, o mesmo texto da Inbox", async () => {
    const contact = await admin.contact.create({
      data: { tenantId: fx.tenant.id, name: "Davi", identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: "5511980000006" } } },
    });
    const conversation = await admin.conversation.create({
      data: { tenantId: fx.tenant.id, contactId: contact.id, channelId: qrChannelId, status: "OPEN", automationState: { ai: "on" } },
    });
    await admin.message.create({
      data: {
        tenantId: fx.tenant.id,
        conversationId: conversation.id,
        channelId: qrChannelId,
        direction: "INBOUND",
        type: "TEXT",
        content: { text: "Quero uma calabresa", from: "5511980000006" },
      },
    });
    script = offer();
    await app.get(OrderAgentService).reply(fx.tenant.id, conversation.id);
    await drainQueues(app);
    const sent = graph.requests.at(-1)!;
    expect(sent.path).toBe("/message/sendText/inst-choices");
    expect(sent.body).toEqual({ number: "5511980000006", text: "Qual tamanho você quer?\n\n1. Grande\n2. Média\n\nResponda com o número da opção." });
    const outbound = await admin.message.findMany({ where: { conversationId: conversation.id, direction: "OUTBOUND" } });
    expect((outbound.at(-1)!.content as Content).text).toBe((sent.body as { text: string }).text);
    expect(outbound.at(-1)!.status).toBe("SENT");
  });

  it("valor em R$ no título da opção que não veio do sistema: a equipe assume e nada sai", async () => {
    script = [
      toolUse("o1", "oferecer_opcoes", {
        pergunta: "Qual?",
        opcoes: [
          { id: "a", titulo: "Grande R$ 1,00" },
          { id: "b", titulo: "Média" },
        ],
      }),
      text("Qual tamanho?"),
      text("Qual tamanho?"),
    ];
    await say("5511980000007", "wamid.CH-8", "Quero uma calabresa");
    const conversation = await conversationOf("5511980000007");
    expect(conversation.automationState).toMatchObject({ ai: "off" });
    expect(conversation.messages.some((m) => (m.content as Content).choices)).toBe(false);
  });
});
