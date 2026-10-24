import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AiEvaluationService } from "../src/ai/ai-evaluation.service.js";
import { keepsFacts } from "../src/ai/ai-review.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp, drainQueues, metaPayload, postMetaWebhook, startMockGraph } from "./helpers.js";

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
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", META_GRAPH_URL: graph.url, AI_BASE_URL: llm.url });
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
    answers.atendimento = { reply: "Abrimos às 11h! 😊", handoff: false, reason: "" };
    await say("5511980000001", "wamid.AI-1", "Que horas vocês abrem?");
    await settle();

    const all = await contents("5511980000001");
    expect(all.some((c) => c.automation === "menu")).toBe(false);
    expect(all.at(-1)).toEqual({ text: "Abrimos às 11h! 😊", aiReply: true });
    expect(sentText()).toBe("Abrimos às 11h! 😊");
    const [system, user] = (llmCalls("atendimento").at(-1)!.body as LlmBody).messages;
    expect(system!.content).toContain("Personalidade do atendimento: Cordial");
    expect(user!.content).toContain("Restaurante: Restaurante Pipeline");
    expect(user!.content).toContain("CONVERSA\nCliente: Que horas vocês abrem?");
    expect((await conversationOf("5511980000001")).automationState).toMatchObject({ ai: "on", aiReplies: 1 });
  });

  it("mensagens seguidas do cliente recebem uma resposta só", async () => {
    const before = llmCalls("atendimento").length;
    answers.atendimento = { reply: "Temos sim!", handoff: false, reason: "" };
    await say("5511980000001", "wamid.AI-2", "Vocês entregam");
    await say("5511980000001", "wamid.AI-3", "no Centro?");
    await settle();

    expect(llmCalls("atendimento").length).toBe(before + 1);
    expect((await contents("5511980000001")).filter((c) => c.text === "Temos sim!")).toHaveLength(1);
  });

  it("a resposta do atendente é revisada pela IA antes do envio, e a IA sai da conversa", async () => {
    const { id } = await conversationOf("5511980000001");
    answers.revisao = { text: "Claro! Seu pedido chega às 20:40." };
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
    expect((await contents("5511980000001")).at(-1)).toEqual({ text: "Obrigada!" });
  });

  it("revisão que muda um dado não sai: vai o texto do atendente", async () => {
    const { id } = await conversationOf("5511980000001");
    answers.revisao = { text: "Seu pedido chega às 21:00." };
    const { body: sent } = await reply(id, "chega 20:40");
    await settle();

    expect((await admin.message.findUniqueOrThrow({ where: { id: sent.id } })).content).toEqual({ text: "chega 20:40", aiReview: "kept" });
    expect(sentText()).toBe("chega 20:40");
  });

  it("a IA passa para a equipe quando não pode resolver, e para de responder", async () => {
    answers.atendimento = { reply: "Sinto muito! Alguém da equipe já vai falar com você.", handoff: true, reason: "Cliente reclamou do atraso" };
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

  it("restaurante sem o módulo continua com o menu de atendimento", async () => {
    const calls = llm.requests.length;
    await say("5511980000004", "wamid.AI-8", "Oi", withoutAi.whatsapp);
    await settle();

    const conversation = await conversationOf("5511980000004", withoutAi.tenant.id);
    expect(conversation.messages.map((m) => (m.content as Content).automation)).toContain("menu");
    expect(llm.requests.length).toBe(calls);
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
