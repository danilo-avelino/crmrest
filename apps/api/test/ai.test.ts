import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { orderNumbersIn } from "../src/ai/ai-attendant.service.js";
import { AiEvaluationService } from "../src/ai/ai-evaluation.service.js";
import { keepsFacts } from "../src/ai/ai-review.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import {
  accessTokenFor,
  admin,
  createChannelFixture,
  createTestApp,
  drainQueues,
  instagramPayload,
  instagramText,
  metaPayload,
  postMetaWebhook,
  startMockGraph,
} from "./helpers.js";

type Content = { text?: string; automation?: string; event?: string; aiReply?: boolean; aiReview?: string; original?: string };
type LlmBody = { response_format: { json_schema: { name: string } }; messages: { role: string; content: string }[] };

describe("atendimento com IA: resposta, revisão e avaliação", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let withoutAi: Awaited<ReturnType<typeof createChannelFixture>>;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let llm: Awaited<ReturnType<typeof startMockGraph>>;
  let aiQueue: Queue;
  let token: string;
  // O que a LLM falsa responde, por tarefa (o nome do schema); sem resposta, ela devolve HTTP 500.
  const answers: Record<string, unknown> = {};

  beforeAll(async () => {
    graph = await startMockGraph();
    llm = await startMockGraph();
    llm.reply((req) => {
      const answer = answers[(req.body as LlmBody).response_format.json_schema.name];
      if (answer === undefined) return { status: 500, body: {} };
      return { status: 200, body: { choices: [{ message: { content: JSON.stringify(answer) } }] } };
    });
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", META_GRAPH_URL: graph.url, INSTAGRAM_GRAPH_URL: graph.url, AI_BASE_URL: llm.url });
    aiQueue = app.get<Queue>(getQueueToken(QUEUES.ai));
    fx = await createChannelFixture();
    withoutAi = await createChannelFixture();
    await admin.tenantModule.create({ data: { tenantId: fx.tenant.id, module: "AI" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await withoutAi?.cleanup();
    await app?.close();
    await graph?.close();
    await llm?.close();
  });

  /** Espera as respostas da IA (fila ai) e os envios que elas geram; as avaliações ficam agendadas para depois. */
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
  const say = async (waId: string, id: string, body: string, channel = fx.whatsapp) => {
    await postMetaWebhook(
      app,
      metaPayload(channel.externalId, {
        contacts: [{ profile: { name: "Ana Souza" }, wa_id: waId }],
        messages: [{ from: waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
      }),
    ).expect(200);
    await drainQueues(app);
  };
  const conversationOf = (waId: string, tenantId = fx.tenant.id) =>
    admin.conversation.findFirstOrThrow({
      where: { tenantId, contact: { identities: { some: { channelType: "WHATSAPP", externalId: waId } } } },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  const contents = async (waId: string) => (await conversationOf(waId)).messages.map((m) => m.content as Content);
  const llmCalls = (name: string) => llm.requests.filter((req) => (req.body as LlmBody).response_format.json_schema.name === name);
  const sentText = () => (graph.requests.at(-1)!.body as { text: { body: string } }).text.body;
  const reply = (conversationId: string, text: string) =>
    request(app.getHttpServer())
      .post(`/api/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text })
      .expect(201);

  it("a IA responde no lugar do menu, no tom do restaurante e com os dados dele", async () => {
    answers.atendimento = { reply: "Abrimos às 11h! 😊", handoff: false, reason: "", order: "none" };
    await say("5511980000001", "wamid.AI-1", "Que horas vocês abrem?");
    await settle();

    const all = await contents("5511980000001");
    expect(all.some((c) => c.automation === "menu")).toBe(false);
    expect(all.at(-1)).toEqual({ text: "Abrimos às 11h! 😊", aiReply: true });
    expect(sentText()).toBe("Abrimos às 11h! 😊");
    const [system, user] = (llmCalls("atendimento").at(-1)!.body as LlmBody).messages;
    expect(system!.content).toContain("Personalidade do atendimento: Cordial");
    expect(system!.content).toContain("Mensagem sem relação com pedido ou com o restaurante");
    expect(user!.content).toContain("Restaurante: Restaurante Pipeline");
    expect(user!.content).toContain("CONVERSA\nCliente: Que horas vocês abrem?");
    expect((await conversationOf("5511980000001")).automationState).toMatchObject({ ai: "on", aiReplies: 1 });
  });

  it("mensagens seguidas do cliente recebem uma resposta só", async () => {
    const before = llmCalls("atendimento").length;
    answers.atendimento = { reply: "Temos sim!", handoff: false, reason: "", order: "none" };
    await say("5511980000001", "wamid.AI-2", "Vocês entregam");
    await say("5511980000001", "wamid.AI-3", "no Centro?");
    await settle();

    expect(llmCalls("atendimento").length).toBe(before + 1);
    expect((await contents("5511980000001")).filter((c) => c.text === "Temos sim!")).toHaveLength(1);
  });

  it("a resposta do atendente é revisada pela IA antes do envio, e a IA sai da conversa", async () => {
    const { id } = await conversationOf("5511980000001");
    answers.revisao = { misconduct: false, reason: "", text: "Claro! Seu pedido chega às 20:40." };
    const { body: sent } = await reply(id, "claro, chega as 20:40");
    expect(sent.content).toMatchObject({ text: "claro, chega as 20:40", aiReview: "pending" });
    await settle();

    const message = await admin.message.findUniqueOrThrow({ where: { id: sent.id } });
    expect(message.content).toEqual({ text: "Claro! Seu pedido chega às 20:40.", original: "claro, chega as 20:40", aiReview: "rewritten" });
    expect(message.status).toBe("SENT");
    expect(sentText()).toBe("Claro! Seu pedido chega às 20:40.");
    expect((await conversationOf("5511980000001")).automationState).toMatchObject({ ai: "off" });

    // Com a equipe na conversa, a IA não responde mais o cliente.
    const calls = llmCalls("atendimento").length;
    await say("5511980000001", "wamid.AI-4", "Obrigada!");
    await settle();
    expect(llmCalls("atendimento").length).toBe(calls);
    expect((await contents("5511980000001")).at(-1)).toEqual({ from: "5511980000001", text: "Obrigada!" });
  });

  it("revisão que muda um dado não sai: vai o texto do atendente", async () => {
    const { id } = await conversationOf("5511980000001");
    answers.revisao = { misconduct: false, reason: "", text: "Seu pedido chega às 21:00." };
    const { body: sent } = await reply(id, "chega 20:40");
    await settle();

    expect((await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).content).toEqual({ text: "chega 20:40", aiReview: "kept" });
    expect(sentText()).toBe("chega 20:40");
  });

  it("resposta ofensiva não sai: vira alerta de má conduta para o atendente e vai para as Avaliações", async () => {
    const { id } = await conversationOf("5511980000001");
    answers.revisao = { misconduct: true, reason: "Mandou o cliente calar a boca", text: "Por favor, mantenha o respeito no atendimento." };
    const sentBefore = graph.requests.length;
    const { body: sent } = await reply(id, "cala a boca vc");
    await settle();

    const message = await admin.message.findUniqueOrThrow({ where: { id: sent.id } });
    expect(message).toMatchObject({ direction: "INTERNAL", status: null, sentByUserId: fx.user.id });
    expect(message.content).toEqual({ original: "cala a boca vc", misconduct: "Mandou o cliente calar a boca", aiReview: "blocked" });
    expect(graph.requests.length).toBe(sentBefore);
    expect((llmCalls("revisao").at(-1)!.body as LlmBody).messages[0]!.content).toContain("É má conduta quando a mensagem xinga");

    // O gestor vê o alerta, com o texto original e a conversa, na aba Atendimento das Avaliações.
    const { role } = await admin.tenantMember.findFirstOrThrow({ where: { tenantId: fx.tenant.id, userId: fx.user.id } });
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    try {
      const adminToken = await accessTokenFor(app, fx.user.email, fx.tenant.id);
      const { body } = await request(app.getHttpServer())
        .get(`/api/reports/ratings?tenantId=${fx.tenant.id}&period=today`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(body.ai.misconduct).toEqual([
        {
          messageId: sent.id,
          conversationId: id,
          contactName: "Ana Souza",
          agentName: "Atendente Pipeline",
          original: "cala a boca vc",
          reason: "Mandou o cliente calar a boca",
          createdAt: message.createdAt.toISOString(),
        },
      ]);
    } finally {
      await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role } });
    }
  });

  it("a IA passa para a equipe quando não pode resolver, e para de responder", async () => {
    answers.atendimento = { reply: "Sinto muito! Alguém da equipe já vai falar com você.", handoff: true, reason: "Cliente reclamou do atraso", order: "none" };
    await say("5511980000002", "wamid.AI-5", "Meu pedido está atrasado há uma hora!");
    await settle();

    const conversation = await conversationOf("5511980000002");
    const all = conversation.messages.map((m) => m.content as Content);
    expect(all.at(-2)).toEqual({ text: "Sinto muito! Alguém da equipe já vai falar com você.", aiReply: true });
    expect(all.at(-1)).toMatchObject({ event: "handoff", text: "IA passou o atendimento para a equipe: Cliente reclamou do atraso" });
    expect(conversation.awaitingAgentSince).not.toBeNull();
    expect(conversation.automationState).toMatchObject({ ai: "off" });

    const calls = llmCalls("atendimento").length;
    await say("5511980000002", "wamid.AI-6", "Alguém?");
    await settle();
    expect(llmCalls("atendimento").length).toBe(calls);
  });

  it("passando para a equipe com uma pergunta, sai a mensagem automática no lugar", async () => {
    answers.atendimento = { reply: "Pode me contar o que aconteceu?", handoff: true, reason: "Cliente mandou uma foto", order: "none" };
    await say("5511980000007", "wamid.AI-H1", "Olha isso");
    await settle();

    const all = await contents("5511980000007");
    expect(all.at(-2)).toEqual({ text: "Certo! Um atendente já vai falar com você.", automation: "handoff" });
    expect(all.at(-1)).toMatchObject({ event: "handoff", text: "IA passou o atendimento para a equipe: Cliente mandou uma foto" });
  });

  it("fechado, passar para a equipe sem dizer quando o restaurante volta: sai o aviso de fora do horário", async () => {
    // Abre só um minuto por semana: fechado agora, com dia e hora para voltar.
    const days = [{ open: "03:00", close: "03:01" }, null, null, null, null, null, null];
    const hours = { enabled: true, days, closedMessage: "Estamos fechados. Voltamos {retorno}." };
    await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: { businessHours: hours } } });
    answers.atendimento = { reply: "Certo! Um atendente já vai falar com você.", handoff: true, reason: "Cliente pediu um atendente", order: "none" };
    try {
      await say("5511980000008", "wamid.AI-F1", "Quero falar com alguém");
      await settle();
    } finally {
      await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: {} } });
    }

    const all = await contents("5511980000008");
    expect(all.at(-2)).toEqual({ text: expect.stringMatching(/^Estamos fechados\. Voltamos .+ às 03:00\.$/), automation: "after_hours" });
    expect((await conversationOf("5511980000008")).status).toBe("PENDING");
  });

  it("resposta com os links para pedir não chama a equipe, mesmo que a LLM peça", async () => {
    const orderLinks = [{ label: "Cardápio", url: "https://pedir.exemplo.com/loja" }];
    await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: { orderLinks } } });
    answers.atendimento = { reply: "O cardápio e os preços estão aqui: https://pedir.exemplo.com/loja", handoff: true, reason: "Preço", order: "none" };
    try {
      await say("5511980000009", "wamid.AI-L1", "Quanto custa a pizza?");
      await settle();
    } finally {
      await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: {} } });
    }

    const conversation = await conversationOf("5511980000009");
    expect(conversation.messages.at(-1)!.content).toEqual({ text: "O cardápio e os preços estão aqui: https://pedir.exemplo.com/loja", aiReply: true });
    expect(conversation.automationState).toMatchObject({ ai: "on" });
    expect(conversation.awaitingAgentSince).toBeNull();
  });

  it("sem a LLM, o cliente não fica sem resposta: a equipe é chamada", async () => {
    delete answers.atendimento;
    await say("5511980000003", "wamid.AI-7", "Oi");
    await settle();

    const all = await contents("5511980000003");
    expect(all.at(-2)).toEqual({ text: "Certo! Um atendente já vai falar com você.", automation: "handoff" });
    expect(all.at(-1)).toMatchObject({ event: "handoff", text: "IA passou o atendimento para a equipe" });
  });

  it("resolvida, a IA avalia o atendimento uma vez", async () => {
    const { id } = await conversationOf("5511980000001");
    await request(app.getHttpServer())
      .patch(`/api/conversations/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "RESOLVED" })
      .expect(200);
    // Agendada para alguns minutos depois (espera a reação do cliente): aqui, roda na hora.
    const scheduled = (await aiQueue.getDelayed()).filter((job) => job.name === "evaluate" && job.data.conversationId === id);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!.remove();

    answers.avaliacao = { resolved: true, satisfaction: "satisfeito", score: 5, summary: "Cliente perguntou o horário e agradeceu." };
    const evaluation = app.get(AiEvaluationService);
    await evaluation.evaluate(fx.tenant.id, id);
    await evaluation.evaluate(fx.tenant.id, id); // nada novo do cliente: não avalia de novo

    const rows = await admin.conversationEvaluation.findMany({ where: { conversationId: id } });
    expect(rows).toMatchObject([
      { resolved: true, satisfied: true, score: 5, summary: "Cliente perguntou o horário e agradeceu.", userId: fx.user.id, model: "gemma4:12b" },
    ]);
    const conversation = (llmCalls("avaliacao").at(-1)!.body as LlmBody).messages[1]!.content;
    expect(conversation).toMatch(/^\[\d\d:\d\d\] Cliente: Que horas vocês abrem\?/);
    expect(conversation).toContain("Restaurante (IA): Abrimos às 11h! 😊");
    expect(conversation).toContain("Restaurante (atendente): Claro! Seu pedido chega às 20:40.");

    // A avaliação é só do administrador: o atendente não a recebe com as mensagens.
    const { body } = await request(app.getHttpServer())
      .get(`/api/conversations/${id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(body.evaluations).toEqual([]);
  });

  it("Instagram: a IA acha o pedido pelo número, cadastra o telefone e responde ao perfil que escreveu", async () => {
    // Cliente que já pediu, com telefone e um perfil antigo do Instagram no cadastro.
    const bruna = await admin.contact.create({
      data: {
        tenantId: fx.tenant.id,
        name: "Bruna Alves",
        phone: "+5511976540001",
        firstSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        identities: { create: { tenantId: fx.tenant.id, channelType: "INSTAGRAM", externalId: "IGSID-BRUNA-ANTIGO" } },
      },
    });
    await admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId: bruna.id,
        channelId: fx.ifood.id,
        externalOrderId: `pedido-ia-${Date.now()}`,
        displayCode: "4321",
        status: "PREPARING",
        subtotal: "30.00",
        deliveryFee: "0.00",
        total: "30.00",
        placedAt: new Date(),
        raw: {},
        items: { create: { tenantId: fx.tenant.id, name: "Açaí 500ml", quantity: 1, unitPrice: "30.00" } },
      },
    });
    const dm = async (mid: string, text: string) => {
      await postMetaWebhook(app, instagramPayload(fx.instagram.externalId, [instagramText("IGSID-BRUNA", fx.instagram.externalId, mid, text)])).expect(200);
      await drainQueues(app);
      await settle();
    };
    const lastPrompt = () => (llmCalls("atendimento").at(-1)!.body as LlmBody).messages[1]!.content;
    const recipient = () => (graph.requests.at(-1)!.body as { recipient: { id: string } }).recipient.id;
    answers.atendimento = { reply: "Pode me passar o número do pedido?", handoff: false, reason: "", order: "none" };

    await dm("mid.AI-IG-1", "Qual a previsão do meu pedido?");
    expect(lastPrompt()).toContain("nenhum pedido de hoje ou de ontem no cadastro nem com um número informado na conversa. O telefone do cliente não está no cadastro.");

    await dm("mid.AI-IG-2", "Pedido Nº 4321\nFeito às 13:44");
    expect(lastPrompt()).toContain("Pedido que pode ser do cliente (achado pelo número que ele informou; ainda não confirmado por ele):\n#4321 (iFood)");

    // O telefone une o cadastro ao da Bruna, que tem dois perfis do Instagram: a resposta vai para o que escreveu.
    await dm("mid.AI-IG-3", "(11) 97654-0001");
    const conversation = await admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, channelId: fx.instagram.id, contactId: bruna.id },
      include: { contact: { include: { identities: true } }, messages: { orderBy: { createdAt: "asc" } } },
    });
    expect(conversation.contact.identities.map((i) => i.externalId).sort()).toEqual(["IGSID-BRUNA", "IGSID-BRUNA-ANTIGO"]);
    expect(conversation.messages.map((m) => (m.content as Content).event).filter(Boolean).slice(-2)).toEqual(["phone_collected", "contacts_merged"]);
    expect(lastPrompt()).toContain("Pedido que pode ser do cliente (ligado ao cadastro dele; ainda não confirmado por ele):\n#4321 (iFood)");
    expect(conversation.automationState).toMatchObject({ ai: "on" });
    expect(conversation.messages.at(-1)).toMatchObject({ status: "SENT", content: { aiReply: true } });
    expect(recipient()).toBe("IGSID-BRUNA");
  });

  /** Pedido de hoje no iFood, no cadastro de outro cliente (ou de um sem telefone, como o iFood manda). */
  const orderFor = async (code: string, phone?: string) => {
    const contact = await admin.contact.create({ data: { tenantId: fx.tenant.id, name: `Cliente ${code}`, ...(phone && { phone }) } });
    return admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId: contact.id,
        channelId: fx.ifood.id,
        externalOrderId: `pedido-ia-${code}-${Date.now()}`,
        displayCode: code,
        status: "CONFIRMED",
        subtotal: "40.00",
        deliveryFee: "0.00",
        total: "40.00",
        placedAt: new Date(),
        raw: {},
        items: { create: { tenantId: fx.tenant.id, name: "Pizza Margherita", quantity: 1, unitPrice: "40.00" } },
      },
    });
  };
  const promptOf = () => (llmCalls("atendimento").at(-1)!.body as LlmBody).messages[1]!.content;

  it("como no menu, a IA mostra o pedido e só dá o andamento depois da confirmação, que une os cadastros", async () => {
    const order = await orderFor("8765");
    // Informar o número não é confirmar: mesmo que a LLM diga "confirmed", o pedido ainda não foi mostrado ao cliente.
    answers.atendimento = { reply: "É o pedido #8765, com 1 Pizza Margherita (R$ 40,00)?", handoff: false, reason: "", order: "confirmed" };
    await say("5511980000005", "wamid.AI-C1", "Pedido #8765");
    await settle();
    expect(promptOf()).toContain("Pedido que pode ser do cliente (achado pelo número que ele informou; ainda não confirmado por ele):\n#8765");
    const offered = await conversationOf("5511980000005");
    expect(offered.automationState).toMatchObject({ aiOfferedOrderId: order.id });
    expect(offered.automationState).not.toHaveProperty("linkedOrder");

    answers.atendimento = { reply: "Ótimo! Seu pedido está confirmado.", handoff: false, reason: "", order: "confirmed" };
    await say("5511980000005", "wamid.AI-C2", "Sim, é esse");
    await settle();
    const conversation = await conversationOf("5511980000005");
    expect(conversation.automationState).toMatchObject({ ai: "on", linkedOrder: { id: order.id } });
    // O cadastro do WhatsApp foi unido ao do pedido.
    expect((await admin.order.findUniqueOrThrow({ where: { id: order.id } })).contactId).toBe(conversation.contactId);
    const events = conversation.messages.map((m) => m.content as Content).filter((c) => c.event);
    expect(events.slice(-2)).toMatchObject([{ event: "order" }, { event: "contacts_merged", text: "Cadastro unificado com o do pedido #8765 (iFood)" }]);

    answers.atendimento = { reply: "Por nada!", handoff: false, reason: "", order: "none" };
    await say("5511980000005", "wamid.AI-C3", "Obrigado");
    await settle();
    expect(promptOf()).toContain("Pedido do cliente (ele confirmou que é dele):\n#8765");
  });

  it("pedido que o cliente diz não ser dele: a IA procura outro pelo número", async () => {
    const mine = await orderFor("5556", "+5511980000006");
    await orderFor("5557");
    answers.atendimento = { reply: "É o pedido #5556?", handoff: false, reason: "", order: "none" };
    await say("5511980000006", "wamid.AI-D1", "Cadê meu pedido?");
    await settle();
    expect(promptOf()).toContain("Pedido que pode ser do cliente (ligado ao cadastro dele; ainda não confirmado por ele):\n#5556");

    answers.atendimento = { reply: "Qual o número do seu pedido?", handoff: false, reason: "", order: "denied" };
    await say("5511980000006", "wamid.AI-D2", "Não é esse");
    await settle();
    expect((await conversationOf("5511980000006")).automationState).toMatchObject({ aiDeniedOrderIds: [mine.id] });

    answers.atendimento = { reply: "É o pedido #5557?", handoff: false, reason: "", order: "none" };
    await say("5511980000006", "wamid.AI-D3", "Pedido nº 5557");
    await settle();
    expect(promptOf()).toContain("(achado pelo número que ele informou; ainda não confirmado por ele):\n#5557");
  });

  it("restaurante sem o módulo continua com o menu de atendimento", async () => {
    const calls = llm.requests.length;
    await say("5511980000004", "wamid.AI-8", "Oi", withoutAi.whatsapp);
    await settle();

    const conversation = await conversationOf("5511980000004", withoutAi.tenant.id);
    expect(conversation.messages.map((m) => (m.content as Content).automation)).toContain("menu");
    expect(llm.requests.length).toBe(calls);
  });
});

describe("atendimento com IA: número do pedido informado pelo cliente", () => {
  it("lê o número do pedido, mas não números soltos no meio do texto", () => {
    expect(orderNumbersIn(["4321"])).toEqual(["4321"]);
    expect(orderNumbersIn(["#0042"])).toEqual(["0042", "42"]);
    expect(orderNumbersIn(["é o 5557", "o 88", "nº 12"])).toEqual(["5557", "88", "12"]);
    expect(orderNumbersIn(["o pedido 5150 já saiu?", "meu pedido 31, cadê"])).toEqual(["5150", "31"]);
    expect(orderNumbersIn(["pedido 2 pizzas", "fiz o pedido 30 minutos atrás"])).toEqual([]);
    expect(orderNumbersIn(["Pedido Nº 1\nFeito às 13:44"])).toEqual(["1"]);
    expect(orderNumbersIn(["o número do pedido é 5150", "pedido: 77"])).toEqual(["5150", "77"]);
    expect(orderNumbersIn(["quero 2 pizzas", "fiz o pedido há 30 minutos", "86999731647", "(86) 99973-1647"])).toEqual([]);
  });
});

describe("revisão por IA: dados que não podem mudar", () => {
  it("aceita só a reescrita com os mesmos números, links e @", () => {
    expect(keepsFacts("vc pedido ta atrasado uns 15 min, chega as 20:40", "Seu pedido está atrasado uns 15 minutos e chega às 20:40.")).toBe(true);
    expect(keepsFacts("o total ficou R$ 52,90", "O total ficou R$ 52,00.")).toBe(false);
    expect(keepsFacts("ja saiu", "Já saiu! Chega em 10 minutos.")).toBe(false); // dado novo
    expect(keepsFacts("pede por https://loja.exemplo.com/pedir", "Peça por aqui: https://loja.exemplo.com/pedir.")).toBe(true);
    expect(keepsFacts("segue no @restaurante", "Siga a gente no Instagram!")).toBe(false);
  });
});
