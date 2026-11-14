import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ORDER_ARRIVAL_WAIT_MS, orderFactsOf, orderNumbersIn, otherOrderNumber, periodGreeting, systemPrompt, teamRepliedSince } from "../src/ai/ai-attendant.service.js";
import { AiEvaluationService, EVALUATION_DELAY_MS, scorePercent } from "../src/ai/ai-evaluation.service.js";
import { AiForwardService } from "../src/ai/ai-forward.service.js";
import { transcript } from "../src/ai/prompts.js";
import { firstName } from "../src/automations/automation.js";
import { courierShortcut, onlyOrder } from "../src/automations/courier-menu.service.js";
import { InactivityService } from "../src/automations/inactivity.service.js";
import { PresenceService } from "../src/realtime/presence.service.js";
import { echoes, keepsFacts } from "../src/ai/ai-review.service.js";
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
  let jev: Awaited<ReturnType<typeof startMockGraph>>;
  let aiQueue: Queue;
  let token: string;
  // O que a LLM falsa responde, por tarefa (o nome do schema); sem resposta, ela devolve HTTP 500.
  const answers: Record<string, unknown> = {};
  // O que o Jev falso responde na avaliação; sem resposta, HTTP 500.
  let jevAnswers: Record<string, unknown> | undefined;

  beforeAll(async () => {
    graph = await startMockGraph();
    llm = await startMockGraph();
    llm.reply((req) => {
      const answer = answers[(req.body as LlmBody).response_format.json_schema.name];
      if (answer === undefined) return { status: 500, body: {} };
      return { status: 200, body: { choices: [{ message: { content: JSON.stringify(answer) } }] } };
    });
    jev = await startMockGraph();
    jev.reply(() => (jevAnswers ? { status: 200, body: { model: "typesafe/jev-1.14-20261101", answers: jevAnswers, usage: { input_tokens: 2000, output_tokens: 8, cost: 0.000084 } } } : { status: 500, body: {} }));
    app = await createTestApp({
      CHANNELS_DRY_RUN: "false",
      META_GRAPH_URL: graph.url,
      INSTAGRAM_GRAPH_URL: graph.url,
      AI_BASE_URL: llm.url,
      JEV_API_KEY: "chave-de-teste",
      JEV_URL: `${jev.url}/api/alpha/decisions`,
    });
    aiQueue = app.get<Queue>(getQueueToken(QUEUES.ai));
    fx = await createChannelFixture();
    withoutAi = await createChannelFixture();
    await admin.tenantModule.create({ data: { tenantId: fx.tenant.id, module: "AI" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
  });

  // Alguém da equipe com o Dish Desk aberto (a presença que o gateway registra): a IA pode passar a conversa.
  beforeEach(async () => {
    await app.get(PresenceService).join("painel-de-teste", [fx.tenant.id]);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await withoutAi?.cleanup();
    await app?.close();
    await graph?.close();
    await llm?.close();
    await jev?.close();
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
  /** A hora em que a avaliação roda: passado o tempo de espera desde a última mensagem. */
  const later = () => new Date(Date.now() + EVALUATION_DELAY_MS);
  type JevBody = { state: { conversa: string }; questions: Record<string, unknown>; provider?: unknown };
  const evaluationCalls = () => jev.requests.filter((req) => "resolved" in (req.body as JevBody).questions);
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

  it("a primeira resposta cumprimenta pelo horário e pelo nome; as seguintes, não", async () => {
    answers.atendimento = { reply: "Boa noite, Ana! Em que posso ajudar?", handoff: false, reason: "", order: "none" };
    await say("5511980000009", "wamid.AI-GREET-1", "teste");
    await settle();
    const first = (llmCalls("atendimento").at(-1)!.body as LlmBody).messages[1]!.content;
    expect(first).toMatch(/Cumprimento: esta é a sua primeira resposta neste atendimento\. Comece com "(Bom dia|Boa tarde|Boa noite), Ana!"/);

    await say("5511980000009", "wamid.AI-GREET-2", "Que horas vocês abrem?");
    await settle();
    const second = (llmCalls("atendimento").at(-1)!.body as LlmBody).messages[1]!.content;
    expect(second).toContain("Cumprimento: você já cumprimentou o cliente neste atendimento");
  });

  it("o período do cumprimento segue o horário de Brasília", () => {
    expect(periodGreeting(new Date("2026-11-07T08:00:00-03:00"))).toBe("Bom dia");
    expect(periodGreeting(new Date("2026-11-07T12:00:00-03:00"))).toBe("Boa tarde");
    expect(periodGreeting(new Date("2026-11-07T18:25:00-03:00"))).toBe("Boa noite");
    expect(periodGreeting(new Date("2026-11-08T02:00:00-03:00"))).toBe("Boa noite");
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
          tenantId: fx.tenant.id,
          conversationId: id,
          contactName: "Ana Souza",
          agentName: "Atendente Pipeline",
          original: "cala a boca vc",
          reason: "Mandou o cliente calar a boca",
          createdAt: message.createdAt.toISOString(),
        },
      ]);
      // Revisão automática: uma resposta reescrita e uma mantida, com a reescrita como exemplo.
      expect(body.ai.reviews).toEqual([{ userId: fx.user.id, name: "Atendente Pipeline", rewritten: 1, kept: 1 }]);
      expect(body.ai.rewriteExample).toMatchObject({
        agentName: "Atendente Pipeline",
        original: "claro, chega as 20:40",
        text: "Claro! Seu pedido chega às 20:40.",
      });
    } finally {
      await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role } });
    }
  });

  it("a IA escolhe não responder (despedida repetida, divulgação): nada sai e ela continua no atendimento", async () => {
    answers.atendimento = { reply: "Este canal é para o atendimento dos nossos clientes.", handoff: false, reason: "", order: "none" };
    await say("5511980000031", "wamid.AI-SKIP-1", "Sou o Max, do Hits. Posso te apresentar uma oferta?");
    await settle();
    const sent = graph.requests.length;

    answers.atendimento = { reply: "-", handoff: false, reason: "", order: "none", skip: true };
    await say("5511980000031", "wamid.AI-SKIP-2", "Obrigado! Um ótimo dia para vocês 😊");
    await settle();

    // Reply vazio com skip (13/11, robô de dedetização): também não sai nada, e o atendimento não cai no menu.
    answers.atendimento = { reply: "", handoff: false, reason: "", order: "none", skip: true };
    await say("5511980000031", "wamid.AI-SKIP-3", "Solicite um orçamento sem compromisso!");
    await settle();

    expect(graph.requests.length).toBe(sent);
    expect((await contents("5511980000031")).filter((c) => c.aiReply)).toHaveLength(1);
    expect((await contents("5511980000031")).some((c) => c.event === "ai_fallback")).toBe(false);
    expect((await conversationOf("5511980000031")).automationState).toMatchObject({ ai: "on", aiReplies: 1 });
  });

  it("conversa resolvida em que o cliente só responde \"ok\": a IA não responde e ela continua resolvida", async () => {
    answers.atendimento = { reply: "Abrimos às 18h.", handoff: false, reason: "", order: "none" };
    await say("5511980000014", "wamid.AI-RE-1", "Que horas vocês abrem?");
    await settle();
    const { id } = await conversationOf("5511980000014");
    await request(app.getHttpServer()).patch(`/api/conversations/${id}`).set("Authorization", `Bearer ${token}`).send({ status: "RESOLVED" }).expect(200);
    const sent = graph.requests.length;

    answers.atendimento = { reply: "-", handoff: false, reason: "", order: "none", skip: true };
    await say("5511980000014", "wamid.AI-RE-2", "Ok, boa noite");
    await settle();

    // A IA soube que a conversa estava resolvida.
    expect((llmCalls("atendimento").at(-1)!.body as LlmBody).messages[1]!.content).toContain("Retomada: a conversa já tinha sido atendida e resolvida");
    expect(graph.requests.length).toBe(sent);
    const conversation = await conversationOf("5511980000014");
    expect(conversation).toMatchObject({ status: "RESOLVED", unreadCount: 0, teamInvolved: false, awaitingAgentSince: null });
    expect(conversation.messages.at(-1)!.content).toEqual({
      event: "ai_skip",
      text: "O cliente só respondeu ao fim do atendimento: a conversa continua resolvida",
    });
  });

  it("a IA acha que é um entregador: a conversa pergunta à equipe, e o sim põe a tag Entregador", async () => {
    answers.atendimento = {
      reply: "Certo, alguém da equipe já vai falar com você.",
      handoff: true,
      reason: "Parece ser um entregador: pede para avisar o cliente do pedido 117",
      order: "none",
      courier: true,
    };
    await say("5511980000042", "wamid.AI-COURIER-1", "Avisa pro cliente do pedido 117 que tô aqui");
    await settle();
    const { id, contactId } = await conversationOf("5511980000042");
    const api = request(app.getHttpServer());
    const opened = await api.get(`/api/conversations/${id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(opened.body.courierCheck).toEqual({ reason: "Parece ser um entregador: pede para avisar o cliente do pedido 117" });

    const answered = await api.post(`/api/conversations/${id}/courier-check`).set("Authorization", `Bearer ${token}`).send({ courier: true }).expect(200);
    expect(answered.body.courierCheck).toBeNull();
    expect((await admin.contact.findUniqueOrThrow({ where: { id: contactId } })).tags).toContain("Entregador");
    expect((await contents("5511980000042")).filter((c) => c.event === "courier_check").map((c) => c.text)).toEqual([
      "A IA acha que quem escreve é um entregador: a equipe confirma",
      "A equipe confirmou que é um entregador: o cadastro ganhou a tag Entregador",
    ]);
    await api.post(`/api/conversations/${id}/courier-check`).set("Authorization", `Bearer ${token}`).send({ courier: "sim" }).expect(400);
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

  it("passando para a equipe, a IA pede o telefone de quem não o tem no cadastro (Instagram) e o cadastra", async () => {
    const ask = "Vou chamar um atendente. Enquanto isso, quer deixar seu telefone com DDD para receber cupons pelo WhatsApp?";
    answers.atendimento = { reply: ask, handoff: true, reason: "Cliente pediu um atendente", order: "none" };
    const dm = async (mid: string, text: string) => {
      await postMetaWebhook(app, instagramPayload(fx.instagram.externalId, [instagramText("IGSID-TEL", fx.instagram.externalId, mid, text)])).expect(200);
      await drainQueues(app);
      await settle();
    };
    const chat = () =>
      admin.conversation.findFirstOrThrow({
        where: { tenantId: fx.tenant.id, channelId: fx.instagram.id, contact: { identities: { some: { externalId: "IGSID-TEL" } } } },
        include: { contact: true, messages: { orderBy: { createdAt: "asc" } } },
      });
    await dm("mid.AI-TEL-1", "Quero falar com um atendente");
    // Passa para a equipe com a pergunta do telefone, sem trocá-la pela mensagem automática.
    let current = await chat();
    expect(current.messages.map((m) => m.content as Content).some((c) => c.text === ask && c.aiReply)).toBe(true);
    expect(current.automationState).toMatchObject({ ai: "off", phoneCollection: "awaiting_phone" });
    expect(llmCalls("atendimento").at(-1) && (llmCalls("atendimento").at(-1)!.body as LlmBody).messages[1]!.content).toContain("O telefone do cliente não está no cadastro.");

    await dm("mid.AI-TEL-2", "(11) 97654-0002");
    current = await chat();
    expect(current.contact).toMatchObject({ phone: "+5511976540002", phoneSource: "informed_by_customer" });
  });

  it("fechado, a conversa espera a equipe; sem dizer quando o restaurante volta, sai o aviso de fora do horário", async () => {
    // Abre só um minuto por semana: fechado agora, com dia e hora para voltar.
    const days = [{ open: "03:00", close: "03:01" }, null, null, null, null, null, null];
    const hours = { enabled: true, days, closedMessage: "Estamos fechados. Voltamos {retorno}." };
    await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: { businessHours: hours } } });
    answers.atendimento = { reply: "Certo! Um atendente já vai falar com você.", handoff: true, reason: "Cliente pediu um atendente", order: "none" };
    try {
      await say("5511980000008", "wamid.AI-F1", "Quero falar com alguém");
      await settle();
      // Ainda fechado: mesmo com alguém online, a conversa continua esperando.
      await app.get(AiForwardService).forward(fx.tenant.id);
    } finally {
      await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: {} } });
    }

    const conversation = await conversationOf("5511980000008");
    const all = conversation.messages.map((m) => m.content as Content);
    expect(all.at(-2)).toEqual({ text: expect.stringMatching(/^Estamos fechados\. Voltamos .+ às 03:00\.$/), automation: "after_hours" });
    expect(all.at(-1)).toMatchObject({ event: "awaiting_agent", text: expect.stringContaining("o restaurante está fechado") });
    expect(conversation).toMatchObject({ status: "PENDING", awaitingAgentSince: null, automationState: { ai: "on", aiWaiting: true } });

    // Aberto (sem horário configurado), com alguém online: a conversa vai para a equipe.
    await app.get(AiForwardService).forward(fx.tenant.id);
    const forwarded = await conversationOf("5511980000008");
    expect(forwarded).toMatchObject({ status: "OPEN", automationState: { ai: "off" } });
    expect(forwarded.awaitingAgentSince).not.toBeNull();
    expect(forwarded.automationState).not.toHaveProperty("aiWaiting");
    expect(forwarded.messages.at(-1)!.content).toMatchObject({ event: "handoff", text: "IA passou o atendimento para a equipe: Cliente pediu um atendente" });
  });

  it("ninguém online: a IA continua atendendo e a conversa vai para quem chegar", async () => {
    await app.get(PresenceService).leave("painel-de-teste", [fx.tenant.id]);
    const notice = "No momento estamos sem atendentes online. Assim que um chegar, sua conversa será encaminhada.";
    answers.atendimento = { reply: notice, handoff: true, reason: "Cliente reclamou do atraso", order: "none" };
    await say("5511980000010", "wamid.AI-O1", "Meu pedido está atrasado!");
    await settle();

    let conversation = await conversationOf("5511980000010");
    expect(conversation.messages.map((m) => m.content as Content).slice(-2)).toMatchObject([
      { text: notice, aiReply: true },
      { event: "awaiting_agent", waitingReason: "offline", text: expect.stringContaining("não há atendente online") },
    ]);
    expect(conversation).toMatchObject({ status: "PENDING", awaitingAgentSince: null, automationState: { ai: "on", aiWaiting: true } });

    // A IA segue respondendo enquanto ninguém chega, e o atendimento não é encerrado por inatividade.
    answers.atendimento = { reply: "Abrimos às 11h.", handoff: false, reason: "", order: "none" };
    await say("5511980000010", "wamid.AI-O2", "Que horas vocês abrem?");
    await settle();
    conversation = await conversationOf("5511980000010");
    expect(conversation.messages.at(-1)!.content).toEqual({ text: "Abrimos às 11h.", aiReply: true });
    await app.get(InactivityService).close(fx.tenant.id, conversation.id, new Date(Date.now() + 25 * 60_000));
    expect((await conversationOf("5511980000010")).status).not.toBe("RESOLVED");

    // Alguém abriu o Dish Desk.
    await app.get(PresenceService).join("painel-de-teste", [fx.tenant.id]);
    await app.get(AiForwardService).forward(fx.tenant.id);
    conversation = await conversationOf("5511980000010");
    expect(conversation).toMatchObject({ status: "OPEN", automationState: { ai: "off" } });
    expect(conversation.awaitingAgentSince).not.toBeNull();
  });

  it("ninguém online e a IA perguntando sem avisar que não há atendente: a pergunta sai e o aviso vai logo depois", async () => {
    await app.get(PresenceService).leave("painel-de-teste", [fx.tenant.id]);
    answers.atendimento = { reply: "Sinto muito pelo atraso! Qual o número do pedido?", handoff: true, reason: "Atraso", order: "none" };
    await say("5511980000012", "wamid.AI-N1", "Meu pedido atrasou");
    await settle();

    expect((await contents("5511980000012")).slice(-3)).toMatchObject([
      { text: "Sinto muito pelo atraso! Qual o número do pedido?", aiReply: true },
      { automation: "no_agents_online" },
      { event: "awaiting_agent" },
    ]);
  });

  it("100% automático: a IA nunca chama a equipe; desligado, as conversas que esperavam vão para ela", async () => {
    const put = (bearer: string, enabled: boolean) =>
      request(app.getHttpServer()).put(`/api/ai/${fx.tenant.id}/full-auto`).set("Authorization", `Bearer ${bearer}`).send({ enabled });
    // Configuração do restaurante: o atendente não liga; o administrador, sim.
    await put(token, true).expect(403);
    const member = { where: { tenantId: fx.tenant.id, userId: fx.user.id } };
    await admin.tenantMember.updateMany({ ...member, data: { role: "ADMIN" } });
    onTestFinished(() => admin.tenantMember.updateMany({ ...member, data: { role: "AGENT" } }).then(() => undefined));
    const adminToken = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const toggle = (enabled: boolean) => put(adminToken, enabled).expect(200);
    const { body: on } = await toggle(true);
    expect(on).toMatchObject({ tenantId: fx.tenant.id, fullAuto: true, closed: false, agentsOnline: true });
    const before = (on as { waiting: number }).waiting; // conversas que outros testes deixaram esperando

    // O cliente pede uma pessoa: a IA avisa que não há atendentes e a conversa espera um.
    const notice = "No momento estamos sem atendentes online. Assim que um chegar, sua conversa será encaminhada para ele.";
    answers.atendimento = { reply: notice, handoff: true, reason: "Cliente pediu um atendente", order: "none" };
    await say("5511980000011", "wamid.AI-A1", "Quero falar com uma pessoa");
    await settle();
    let conversation = await conversationOf("5511980000011");
    expect(conversation.messages.map((m) => m.content as Content).slice(-2)).toMatchObject([
      { text: notice, aiReply: true },
      { event: "awaiting_agent", text: expect.stringContaining("o 100% automático está ligado") },
    ]);
    const { body: list } = await request(app.getHttpServer()).get("/api/ai/attendance").set("Authorization", `Bearer ${token}`).expect(200);
    expect(list).toMatchObject([{ tenantId: fx.tenant.id, fullAuto: true, waiting: before + 1 }]);

    await toggle(false);
    // O encaminhamento roda no worker (job "ai-forward" da fila automations).
    await vi.waitFor(async () => expect((await conversationOf("5511980000011")).awaitingAgentSince).not.toBeNull(), { timeout: 10_000 });
    conversation = await conversationOf("5511980000011");
    expect(conversation).toMatchObject({ status: "OPEN", automationState: { ai: "off" } });
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

  it("resposta que fala dos links sem os endereços sai com os links no fim, uma vez só", async () => {
    const orderLinks = [{ label: "Cardápio", url: "https://pedir.exemplo.com/loja" }];
    await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: { orderLinks } } });
    const reply = "O preço do combo está nos links de pedido. Quer que eu chame um atendente?";
    answers.atendimento = { reply, handoff: false, reason: "Preço", order: "none" };
    try {
      await say("5511980000013", "wamid.AI-L2", "Qual o valor do combo especial?");
      await settle();
      expect((await conversationOf("5511980000013")).messages.at(-1)!.content).toEqual({
        text: `${reply}\nCardápio: https://pedir.exemplo.com/loja`,
        aiReply: true,
      });
      // Os links já estão na conversa: a próxima resposta não os repete.
      await say("5511980000013", "wamid.AI-L3", "36 peças");
      await settle();
    } finally {
      await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: {} } });
    }
    expect((await conversationOf("5511980000013")).messages.at(-1)!.content).toEqual({ text: reply, aiReply: true });
  });

  it("sem a principal e sem a reserva, o atendimento segue no menu até o fim", async () => {
    delete answers.atendimento;
    await say("5511980000003", "wamid.AI-7", "Oi");
    await settle();

    const conversation = await conversationOf("5511980000003");
    expect(conversation.messages.map((m) => m.content as Content).slice(-2)).toMatchObject([
      // A causa vai junto, para a equipe (aqui, o HTTP 500 da LLM falsa).
      { event: "ai_fallback", text: "A IA não respondeu (A LLM respondeu HTTP 500.): o atendimento segue no menu" },
      { automation: "menu" },
    ]);
    expect(conversation.automationState).toMatchObject({ ai: "off", triage: "awaiting_option" });

    // A resposta ao menu segue no menu, sem chamar a LLM: a opção 3 chama a equipe.
    const calls = llmCalls("atendimento").length;
    await say("5511980000003", "wamid.AI-7b", "3");
    await settle();
    expect(llmCalls("atendimento").length).toBe(calls);
    expect((await contents("5511980000003")).slice(-2)).toMatchObject([{ automation: "handoff" }, { event: "handoff" }]);
  });

  it("resolvida, a IA avalia o atendimento uma vez", async () => {
    const { id } = await conversationOf("5511980000001");
    await request(app.getHttpServer())
      .patch(`/api/conversations/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "RESOLVED" })
      .expect(200);
    // Agendada para 1 hora depois (espera a reação do cliente e a conversa retomada): aqui, roda na hora.
    const evaluations = async () => (await aiQueue.getDelayed()).filter((job) => job.name === "evaluate" && job.data.conversationId === id);
    const scheduled = await evaluations();
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!.remove();
    const service = app.get(AiEvaluationService);
    // Rodando antes de 1 hora da última mensagem (o cliente escreveu depois de resolvida): não avalia, remarca.
    const calls = evaluationCalls().length;
    await service.evaluate(fx.tenant.id, id);
    expect(evaluationCalls()).toHaveLength(calls);
    const rescheduled = await evaluations();
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0]!.delay).toBeGreaterThan(EVALUATION_DELAY_MS - 60_000);
    await rescheduled[0]!.remove();

    // A nota vem como a posição na escala (0 a 4, fracionada) e vira porcentagem: 3,6 é 90%.
    jevAnswers = {
      resolved: { type: "noul", noul: 0.93 },
      satisfaction: { type: "choice", choice: "satisfeito", confidence: 0.9, probabilities: {} },
      score: { type: "score", score: 3.6, legend: {}, probabilities: {} },
      teamReason: { type: "choice", choice: "atraso" },
      subject: { type: "choice", choice: "andamento_pedido" },
      issue: { type: "choice", choice: "nada" },
      fault: { type: "choice", choice: "nenhuma" },
      churnRisk: { type: "noul", noul: 0.08 },
    };
    await service.evaluate(fx.tenant.id, id, later());
    await service.evaluate(fx.tenant.id, id, later()); // nada novo do cliente: não avalia de novo

    const rows = await admin.conversationEvaluation.findMany({ where: { conversationId: id } });
    expect(rows).toMatchObject([
      {
        resolved: true,
        satisfied: true,
        score: 90,
        summary: null,
        teamReason: "atraso",
        // "nada" e "nenhuma" não são gravados: sem problema e sem falha.
        subject: "andamento_pedido",
        issue: null,
        fault: null,
        churnRisk: 0.08,
        userId: fx.user.id,
        model: "typesafe/jev-1.14-20261101",
      },
    ]);
    const sent = evaluationCalls().at(-1)!;
    expect(evaluationCalls()).toHaveLength(calls + 1);
    expect(sent.authorization).toBe("Bearer chave-de-teste");
    expect((sent.body as JevBody).provider).toEqual({ data_collection: "deny" }); // conversa de cliente: sem guardar para treino
    expect(await admin.aiUsage.findMany({ where: { tenantId: fx.tenant.id, provider: "JEV" } })).toMatchObject([
      { model: "typesafe/jev-1.14-20261101", inputTokens: 2000, outputTokens: 8, costMicroUsd: 84 },
    ]);
    const conversation = (sent.body as JevBody).state.conversa;
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

  it("avaliação de antes da nota em porcentagem fica de fora da conversa e do relatório", async () => {
    const { role } = await admin.tenantMember.findFirstOrThrow({ where: { tenantId: fx.tenant.id, userId: fx.user.id } });
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    onTestFinished(async () => {
      await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role } });
    });
    const adminToken = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const { id } = await conversationOf("5511980000001");
    const legacy = await admin.conversationEvaluation.create({
      data: { tenantId: fx.tenant.id, conversationId: id, userId: fx.user.id, resolved: false, score: 2, legacy: true, model: "jev" },
    });
    onTestFinished(async () => {
      await admin.conversationEvaluation.delete({ where: { id: legacy.id } });
    });

    const { body } = await request(app.getHttpServer()).get(`/api/conversations/${id}/messages`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    // Só a avaliação nova, do teste anterior.
    expect(body.evaluations.map((row: { id: string; score: number }) => [row.id === legacy.id, row.score])).toEqual([[false, 90]]);
    const report = (await request(app.getHttpServer()).get(`/api/reports/ratings?tenantId=${fx.tenant.id}&period=today`).set("Authorization", `Bearer ${adminToken}`).expect(200)).body;
    expect(report.ai.recent.map((row: { id: string }) => row.id)).not.toContain(legacy.id);
  });

  it("sem resposta da equipe não chama a IA: só registra, e o atendimento seguinte não relê o anterior", async () => {
    answers.atendimento = { reply: "Abrimos às 11h.", handoff: false, reason: "", order: "none" };
    answers.revisao = { misconduct: false, reason: "", text: "Já estou vendo, um instante." };
    // Recusa na reação, no motivo e no assunto: fica sem reação, com outro motivo e sem assunto.
    jevAnswers = {
      resolved: { type: "noul", noul: 0.2 },
      satisfaction: { type: "refusal" },
      score: { type: "score", score: 2 },
      teamReason: { type: "refusal" },
      subject: { type: "refusal" },
      issue: { type: "choice", choice: "demora" },
      fault: { type: "choice", choice: "operacao" },
      churnRisk: { type: "noul", noul: 0.8 },
    };
    await say("5511980000077", "wamid.AI-SO-IA-1", "Vocês abrem hoje?");
    await settle();
    const { id } = await conversationOf("5511980000077");
    const evaluation = app.get(AiEvaluationService);
    const resolve = () =>
      request(app.getHttpServer()).patch(`/api/conversations/${id}`).set("Authorization", `Bearer ${token}`).send({ status: "RESOLVED" }).expect(200);
    const { role } = await admin.tenantMember.findFirstOrThrow({ where: { tenantId: fx.tenant.id, userId: fx.user.id } });
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    onTestFinished(async () => {
      await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role } });
    });
    const adminToken = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const report = async () =>
      (await request(app.getHttpServer()).get(`/api/reports/ratings?tenantId=${fx.tenant.id}&period=today`).set("Authorization", `Bearer ${adminToken}`).expect(200)).body.ai;
    const before = await report();

    // Nota interna não é resposta ao cliente.
    await request(app.getHttpServer()).post(`/api/conversations/${id}/notes`).set("Authorization", `Bearer ${token}`).send({ text: "Cliente antigo" }).expect(201);
    await resolve();
    const calls = evaluationCalls().length;
    await evaluation.evaluate(fx.tenant.id, id, later());
    await evaluation.evaluate(fx.tenant.id, id, later()); // nada novo do cliente: não conta de novo

    expect(evaluationCalls()).toHaveLength(calls);
    expect(await admin.conversationEvaluation.count({ where: { conversationId: id } })).toBe(0);
    expect(await admin.aiOnlyAttendance.count({ where: { conversationId: id } })).toBe(1);
    expect((await report()).onlyAi).toBe(before.onlyAi + 1);

    // O cliente volta e a equipe responde: esse é avaliado, sem o atendimento anterior na leitura.
    await say("5511980000077", "wamid.AI-SO-IA-2", "Meu pedido atrasou");
    await settle();
    await request(app.getHttpServer()).post(`/api/conversations/${id}/messages`).set("Authorization", `Bearer ${token}`).send({ text: "Já estou vendo, um instante." }).expect(201);
    await settle();
    await resolve();
    await evaluation.evaluate(fx.tenant.id, id, later());

    expect(await admin.conversationEvaluation.findMany({ where: { conversationId: id, userId: fx.user.id } })).toMatchObject([
      { resolved: false, satisfied: null, score: 50, teamReason: "outro", subject: null, issue: "demora", fault: "operacao", churnRisk: 0.8 },
    ]);
    // Risco de perder o cliente: a tag entra na hora, e o relatório conta.
    const { contact } = await admin.conversation.findUniqueOrThrow({ where: { id }, select: { contact: { select: { tags: true } } } });
    expect(contact.tags).toContain("Em recuperação");
    const after = await report();
    expect(after.atRisk).toBe(before.atRisk + 1);
    expect(after.faults.operacao).toBe(before.faults.operacao + 1);
    expect(after.issues).toContainEqual({ issue: "demora", count: expect.any(Number) });
    expect(after.recent[0]).toMatchObject({ subject: null, issue: "demora", fault: "operacao", churnRisk: 0.8 });
    const read = (evaluationCalls().at(-1)!.body as JevBody).state.conversa;
    expect(read).toContain("Meu pedido atrasou");
    expect(read).not.toContain("Vocês abrem hoje?");
    expect((await report()).withTeam).toBe(before.withTeam + 1);
  });

  it("Instagram: a IA acha o pedido pelo número, mas o telefone digitado não une os cadastros", async () => {
    // Cliente que já pediu, com telefone no cadastro. Quem escreve no Instagram diz o número e o telefone dela.
    const bruna = await admin.contact.create({
      data: {
        tenantId: fx.tenant.id,
        name: "Bruna Alves",
        phone: "+5511976540001",
        phoneSource: "channel",
        firstSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
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

    const byNumber = "Pedido que pode ser do cliente (achado pelo número que ele informou; ainda não confirmado por ele):\n#4321 (iFood)";
    await dm("mid.AI-IG-2", "Pedido Nº 4321\nFeito às 13:44");
    expect(lastPrompt()).toContain(byNumber);

    // O telefone fica no cadastro do Instagram, sem unir ao da Bruna: a equipe vê o aviso e decide em Duplicados.
    await dm("mid.AI-IG-3", "(11) 97654-0001");
    const conversation = await admin.conversation.findFirstOrThrow({
      where: { tenantId: fx.tenant.id, channelId: fx.instagram.id, contact: { identities: { some: { externalId: "IGSID-BRUNA" } } } },
      include: { contact: { include: { identities: true } }, messages: { orderBy: { createdAt: "asc" } } },
    });
    expect(conversation.contactId).not.toBe(bruna.id);
    expect(conversation.contact).toMatchObject({ phone: "+5511976540001", phoneSource: "informed_by_customer" });
    expect(conversation.messages.map((m) => m.content as Content).filter((c) => c.event).slice(-2)).toEqual([
      { event: "phone_collected", text: "Telefone informado e cadastrado" },
      { event: "possible_duplicate", text: "Bruna Alves já tem este telefone. Se for a mesma pessoa, una os cadastros em Clientes → Duplicados" },
    ]);
    expect(lastPrompt()).toContain(byNumber);
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

  it("mensagem pronta do Cardápio Web antes de o pedido chegar: a IA espera e procura de novo, sem chamar a equipe", async () => {
    answers.atendimento = { reply: "Encontrei o pedido #7123. É esse?", handoff: false, reason: "", order: "none" };
    const calls = llmCalls("atendimento").length;
    await say("5511980000041", "wamid.AI-CW-1", "Olá, meu nome é *Antônio* e gostaria de saber informações sobre meu pedido de número *7123* feito hoje às 12:19");
    // A resposta não saiu: o job foi agendado de novo, para depois do tempo de espera.
    const { id } = await conversationOf("5511980000041");
    const retry = await vi.waitFor(
      async () => {
        const job = (await aiQueue.getJobs(["delayed"])).find((item) => item.name === "reply" && item.data.conversationId === id && item.opts.delay === ORDER_ARRIVAL_WAIT_MS);
        expect(job).toBeDefined();
        return job!;
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(llmCalls("atendimento").length).toBe(calls);
    expect(retry.opts.delay).toBe(ORDER_ARRIVAL_WAIT_MS);

    await orderFor("7123");
    await retry.promote();
    await settle();
    expect(promptOf()).toContain("#7123 (iFood)");
    expect((await contents("5511980000041")).some((c) => c.event === "handoff")).toBe(false);
  });

  it("como no menu, a IA mostra o pedido e só dá o andamento depois da confirmação, que une os cadastros", async () => {
    // O cliente já escreveu antes; depois, um pedido entra em outro cadastro com o mesmo telefone do WhatsApp.
    answers.atendimento = { reply: "Olá! Em que posso ajudar?", handoff: false, reason: "", order: "none" };
    await say("5511980000005", "wamid.AI-C0", "Oi");
    await settle();
    const order = await orderFor("8765", "+5511980000005");
    // Mostrar o pedido não é confirmar: mesmo que a LLM diga "confirmed", o pedido ainda não tinha sido mostrado ao cliente.
    answers.atendimento = { reply: "É o pedido #8765, com 1 Pizza Margherita (R$ 40,00)?", handoff: false, reason: "", order: "confirmed" };
    await say("5511980000005", "wamid.AI-C1", "Pedido #8765");
    await settle();
    expect(promptOf()).toContain("Pedido que pode ser do cliente (ligado ao cadastro dele; ainda não confirmado por ele):\n#8765");
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

  it("pedido que o cliente diz não ser dele: a IA acha outro pelo número, e confirmá-lo não une os cadastros", async () => {
    const mine = await orderFor("5556", "+5511980000006");
    const other = await orderFor("5557");
    answers.atendimento = { reply: "É o pedido #5556?", handoff: false, reason: "", order: "none" };
    await say("5511980000006", "wamid.AI-D1", "Cadê meu pedido?");
    await settle();
    expect(promptOf()).toContain("Pedido que pode ser do cliente (ligado ao cadastro dele; ainda não confirmado por ele):\n#5556");

    answers.atendimento = { reply: "Qual o número do seu pedido?", handoff: false, reason: "", order: "denied" };
    await say("5511980000006", "wamid.AI-D2", "Não é esse");
    await settle();
    expect((await conversationOf("5511980000006")).automationState).toMatchObject({ aiDeniedOrderIds: [mine.id] });

    // O #5557 é de outro cadastro, sem telefone (como os do iFood): a IA o acha pelo número.
    answers.atendimento = { reply: "É o pedido #5557, com 1 Pizza Margherita?", handoff: false, reason: "", order: "none" };
    await say("5511980000006", "wamid.AI-D3", "Pedido nº 5557");
    await settle();
    expect(promptOf()).toContain("Pedido que pode ser do cliente (achado pelo número que ele informou; ainda não confirmado por ele):\n#5557");

    // Confirmado: o card entra na conversa, mas o cadastro não é unido ao do pedido (saber o número não prova que é dele).
    answers.atendimento = { reply: "Certo! Ele está sendo preparado.", handoff: false, reason: "", order: "confirmed" };
    await say("5511980000006", "wamid.AI-D4", "Sim, é esse");
    await settle();
    const conversation = await conversationOf("5511980000006");
    expect(conversation.automationState).toMatchObject({ linkedOrder: { id: other.id } });
    expect((await admin.order.findUniqueOrThrow({ where: { id: other.id } })).contactId).not.toBe(conversation.contactId);
    expect(conversation.messages.map((m) => m.content as Content).filter((c) => c.event).slice(-2)).toMatchObject([
      { event: "order" },
      {
        event: "possible_duplicate",
        text: "O cliente confirmou o pedido #5557 pelo número, mas ele está no cadastro de Cliente 5557. Se for a mesma pessoa, una os cadastros em Clientes → Duplicados",
      },
    ]);
  });

  it("o atendente pede uma sugestão de resposta: nada é enviado e um dado inventado não vale", async () => {
    const conversation = await conversationOf("5511980000005");
    const sent = graph.requests.length;
    const suggest = () =>
      request(app.getHttpServer()).post(`/api/conversations/${conversation.id}/suggestion`).set("Authorization", `Bearer ${token}`);

    answers.sugestao = { text: "O seu pedido #8765 já está com a gente!" };
    const { body } = await suggest().expect(200);
    expect(body).toEqual({ text: "O seu pedido #8765 já está com a gente!" });
    const [system, user] = (llmCalls("sugestao").at(-1)!.body as LlmBody).messages;
    expect(system!.content).toContain("Personalidade do atendimento: Cordial");
    expect(user!.content).toContain("Pedido do cliente (ele confirmou que é dele):\n#8765");
    expect(user!.content).toContain("Cliente: Obrigado");

    // Um prazo que não está nos dados nem na conversa: a sugestão não vale. Acima de 59, para não bater com o minuto do
    // "Agora" dos DADOS.
    answers.sugestao = { text: "Chega em 97 minutos!" };
    await suggest().expect(503);
    delete answers.sugestao;
    await suggest().expect(503);

    expect((await conversationOf("5511980000005")).messages).toHaveLength(conversation.messages.length);
    expect(graph.requests.length).toBe(sent);
  });

  it("entregador e funcionário ficam sem IA: ela não atende, não revisa a resposta, não sugere e não avalia", async () => {
    const evaluations = evaluationCalls().length;
    for (const [waId, tag] of [
      ["5511980000081", "Entregador"],
      ["5511980000082", "Funcionário"],
    ] as const) {
      await admin.contact.create({
        data: { tenantId: fx.tenant.id, name: "Equipe", tags: [tag], identities: { create: { tenantId: fx.tenant.id, channelType: "WHATSAPP", externalId: waId } } },
      });
      const before = llm.requests.length;
      await say(waId, `wamid.NOAI-${waId}-1`, "Oi");
      await settle();
      const { id } = await conversationOf(waId);
      const { body: sent } = await reply(id, "pode subir");
      expect(sent.content).toEqual({ text: "pode subir" });
      await settle();
      await request(app.getHttpServer()).post(`/api/conversations/${id}/suggestion`).set("Authorization", `Bearer ${token}`).expect(422);
      await request(app.getHttpServer()).patch(`/api/conversations/${id}`).set("Authorization", `Bearer ${token}`).send({ status: "RESOLVED" }).expect(200);
      await app.get(AiEvaluationService).evaluate(fx.tenant.id, id, later());
      expect(llm.requests.length).toBe(before);
    }
    expect(evaluationCalls()).toHaveLength(evaluations);
    // O entregador vai direto para o menu dele; o funcionário não recebe automação nenhuma.
    expect((await contents("5511980000081")).find((c) => c.automation)?.automation).toBe("courier_menu");
    expect((await contents("5511980000082")).filter((c) => c.automation || c.aiReply)).toEqual([]);
  });

  it("restaurante sem o módulo continua com o menu de atendimento", async () => {
    const calls = llm.requests.length;
    await say("5511980000004", "wamid.AI-8", "Oi", withoutAi.whatsapp);
    await settle();

    const conversation = await conversationOf("5511980000004", withoutAi.tenant.id);
    expect(conversation.messages.map((m) => (m.content as Content).automation)).toContain("menu");
    expect(llm.requests.length).toBe(calls);

    const other = await accessTokenFor(app, withoutAi.user.email, withoutAi.tenant.id);
    await request(app.getHttpServer()).post(`/api/conversations/${conversation.id}/suggestion`).set("Authorization", `Bearer ${other}`).expect(404);
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

  it("entregador: lê o aviso escrito numa frase, sem o menu", () => {
    expect(courierShortcut("1024 tá na portaria")).toEqual({ kind: "front_desk", code: "1024" });
    expect(courierShortcut("8240 avisa q tá na portaria")).toEqual({ kind: "front_desk", code: "8240" });
    expect(courierShortcut("0535 Entregue na portaria")).toEqual({ kind: "front_desk", code: "0535" });
    expect(courierShortcut("Avisa pro pedido 3289")).toEqual({ kind: "arrival", code: "3289" });
    expect(courierShortcut("2141 pedi pra aguardar na entrada da lateral")).toEqual({ kind: "arrival", code: "2141" });
    expect(courierShortcut("6552")).toEqual({ kind: "number", code: "6552" });
    expect(courierShortcut("pedido 41867")).toEqual({ kind: "number", code: "41867" });
    expect(courierShortcut("Vim buscar")).toEqual({ kind: "pickup" });
    expect(courierShortcut("Máquina que tou tá com defeito")).toEqual({ kind: "problem" });
    expect(courierShortcut("Ja tô aqui a 10 minutos")).toBeNull();
    expect(courierShortcut("Oi")).toBeNull();
    expect(courierShortcut("Pedido 089p")).toBeNull();
    expect(courierShortcut("86994990211")).toBeNull();
  });

  it("entregador: com o mesmo número de ontem ou de outra loja, vale o pedido em andamento ou o único de hoje", () => {
    const now = new Date("2026-11-13T23:41:00Z"); // 20:41 em Brasília
    const yesterday = { id: "ontem", status: "DELIVERED" as const, placedAt: new Date("2026-11-12T16:11:00Z") };
    const today = { id: "hoje", status: "DISPATCHED" as const, placedAt: new Date("2026-11-13T22:54:00Z") };
    expect(onlyOrder([yesterday, today], now)?.id).toBe("hoje");
    expect(onlyOrder([yesterday, { ...today, status: "DELIVERED" as const }], now)?.id).toBe("hoje");
    expect(onlyOrder([today, { ...today, id: "outra loja" }], now)).toBeNull();
    expect(onlyOrder([yesterday], now)?.id).toBe("ontem");
    expect(onlyOrder([], now)).toBeNull();
  });

  it("lê o número da mensagem pronta do Cardápio Web, com o negrito do WhatsApp", () => {
    const text = "Olá, meu nome é *Gabriela Cordeiro* e gostaria de saber informações sobre meu pedido de número *0098* feito hoje às 18:26";
    expect(orderNumbersIn([text])).toEqual(["0098", "98"]);
  });
});

describe("atendimento com IA: o que a IA lê", () => {
  const message = (content: object, sentByUserId: string | null = null) => ({
    direction: "OUTBOUND",
    type: "TEXT" as const,
    content,
    sentByUserId,
    createdAt: new Date(),
  });

  it("a conversa diz quem escreveu: atendente (painel ou celular), IA, automação ou a loja pelo portal do canal", () => {
    const lines = transcript([
      { ...message({ text: "ventania eletro" }), direction: "INBOUND" },
      message({ text: "Já vou ver" }, "user-1"),
      message({ text: "pedido em produção", fromPhone: true }),
      message({ text: "Abrimos às 11h", aiReply: true }),
      message({ text: "Seu pedido saiu", automation: "order_dispatched" }),
      message({ text: "qual nome do local de entrega?" }),
    ]).split("\n");
    expect(lines).toEqual([
      "Cliente: ventania eletro",
      "Restaurante (atendente): Já vou ver",
      "Restaurante (atendente): pedido em produção",
      "Restaurante (IA): Abrimos às 11h",
      "Restaurante (automação): Seu pedido saiu",
      "Restaurante (loja): qual nome do local de entrega?",
    ]);
  });

  it("o cumprimento usa só nome com letras, com a inicial maiúscula", () => {
    expect(firstName("Ana Souza")).toBe("Ana");
    expect(firstName("PATRICIA AGUIAR DE ALMEIDA")).toBe("Patricia");
    expect(firstName("carlos eduardo")).toBe("Carlos");
    expect(firstName("João Vitor Mendes 😁")).toBe("João");
    expect(firstName("😃")).toBeUndefined();
    expect(firstName("✨")).toBeUndefined();
    expect(firstName(null)).toBeUndefined();
    expect(firstName("rafaelsilvasilva9400")).toBeUndefined();
  });

  it("no chat do iFood o pedido é o do chat, sem confirmação, e o telefone é pedido sem falar em cupom", () => {
    const order = {
      displayCode: "5467",
      externalOrderId: "x",
      channelType: "IFOOD" as const,
      placedAt: new Date("2026-11-12T19:04:00-03:00"),
      status: "DISPATCHED" as const,
      items: [{ quantity: 1, name: "Pepperoni" }],
      total: "47.01",
      update: { text: "Saiu para entrega às 19:15." },
      confirmed: true,
      byNumber: false,
      chatOrder: true,
    };
    const facts = orderFactsOf(order, false);
    expect(facts).toContain("Pedido do cliente (é o pedido deste chat do iFood: não pergunte se é dele):\n#5467");
    expect(facts).toContain("Andamento agora: Saiu para entrega às 19:15.");
    expect(facts).toContain("Este chat é só do pedido #5467, e o número não muda: não peça o número do pedido e não fale de nenhum outro número");

    expect(systemPrompt("Aglio Nero", "IFOOD", {})).not.toContain("cupons");
    expect(systemPrompt("Aglio Nero", "IFOOD", {})).toContain("caso a conversa caia");
    expect(systemPrompt("Aglio Nero", "WHATSAPP", {})).toContain("para receber cupons pelo WhatsApp");
    // Pagamento: a IA só diz que chama a equipe, sem falar do que vê ou não vê (pedido do usuário, 14/11/2026).
    expect(systemPrompt("Aglio Nero", "WHATSAPP", {})).toContain("Não diga se você vê ou não o pagamento");
  });

  it("pedido cancelado: a IA recebe o motivo que a loja deu", () => {
    const order = {
      displayCode: "56",
      externalOrderId: "x",
      channelType: "CARDAPIO_WEB" as const,
      placedAt: new Date("2026-11-13T11:52:00-03:00"),
      status: "CANCELED" as const,
      items: [{ quantity: 1, name: "Arroz de costela" }],
      total: "54.39",
      update: null,
      confirmed: false,
      byNumber: false,
      cancellationReason: "Pedido fora da área de entrega",
    };
    expect(orderFactsOf(order, false)).toContain("Motivo do cancelamento, dado pela loja: Pedido fora da área de entrega.");
    expect(orderFactsOf({ ...order, status: "DELIVERED" as const }, false)).not.toContain("Motivo do cancelamento");
  });

  it("trava do chat do iFood: acha na resposta outro número de pedido, com ou sem os zeros à esquerda", () => {
    expect(otherOrderNumber("Pelo nosso registro, o pedido é o #8270 (e não o #0028 que citei antes).", "8270")).toBe("0028");
    expect(otherOrderNumber("Seu pedido #0028 saiu para entrega às 12:31.", "8270")).toBe("0028");
    expect(otherOrderNumber("O pedido nº 1234 não é deste chat.", "0028")).toBe("1234");
    expect(otherOrderNumber("Seu pedido #0028 saiu às 12:31, total de R$ 31,89, há 30 minutos.", "0028")).toBeNull();
    expect(otherOrderNumber("Seu pedido #28 saiu para entrega.", "0028")).toBeNull();
    expect(otherOrderNumber("Me chama no 89 99463-0817 se precisar; seu pedido 2 pizzas saiu.", "0028")).toBeNull();
  });

  it("depois do horário, conta como atendente a equipe que respondeu na conversa há pouco (painel ou celular da loja)", () => {
    const at = new Date("2026-11-14T02:04:00Z");
    const message = (content: object, sentByUserId: string | null, minutes: number, direction = "OUTBOUND") => ({
      direction,
      content,
      sentByUserId,
      createdAt: new Date(at.getTime() - minutes * 60_000),
    });
    const since = at.getTime() - 15 * 60_000;
    expect(teamRepliedSince([message({ text: "É nessa rua." }, "user-1", 8)], since)).toBe(true);
    expect(teamRepliedSince([message({ text: "ok", fromPhone: true }, null, 3)], since)).toBe(true);
    expect(teamRepliedSince([message({ text: "É nessa rua." }, "user-1", 40)], since)).toBe(false);
    expect(teamRepliedSince([message({ text: "Boa noite!", aiReply: true }, null, 2), message({ text: "Oi" }, null, 1, "INBOUND")], since)).toBe(false);
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

  it("recusa a reescrita que repete outra mensagem da conversa, mas aceita o reenvio de propósito", () => {
    const history = [{ content: { text: "Avisa pro cliente do pedido 117 que tô aqui" } }, { content: { text: "É do app, o número está na comanda." } }];
    expect(echoes("É do app, o número está na comanda.", "para tentar contato", history)).toBe(true);
    expect(echoes("Para tentar contato.", "para tentar contato", history)).toBe(false);
    expect(echoes("É do app, o número está na comanda.", "é do app, o número está na comanda", history)).toBe(false);
  });
});

describe("nota da IA em porcentagem", () => {
  it("o pior nível (atendimento rude) é 1%, o melhor (tudo resolvido, bem atendido) é 100%", () => {
    expect(scorePercent(0)).toBe(1);
    expect(scorePercent(2)).toBe(50);
    expect(scorePercent(4)).toBe(100);
    expect(scorePercent(3.6)).toBe(90);
  });
});
