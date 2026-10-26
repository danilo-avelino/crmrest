import type { PageSnapshot } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Decision, guard } from "../src/agent/agent-guard.js";
import { FIRST_QUESTION } from "../src/agent/agent.service.js";
import { INTAKE_QUESTIONS } from "../src/agent/intake.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp, startMockGraph } from "./helpers.js";

type LlmBody = { response_format: { json_schema: { name: string } }; messages: { role: string; content: string }[] };

const decision = (patch: Partial<Decision>): Decision => ({ say: "Vou fazer.", action: "click", ref: 1, value: "", irreversible: false, reason: "", ...patch });
const page = (url: string, elements: PageSnapshot["elements"]): PageSnapshot => ({ url, title: "Página", elements, text: "" });
const ALLOWED = ["dishdesk.com.br", "portal.ifood.com.br"];

describe("agente da extensão: travas", () => {
  const portal = page("https://portal.ifood.com.br/apps", [
    { ref: 1, role: "botão", name: "Aplicativos" },
    { ref: 2, role: "campo", name: "E-mail" },
    { ref: 3, role: "campo", name: "Senha" },
    { ref: 4, role: "campo", name: "Token", sensitive: "code" },
    { ref: 5, role: "botão", name: "Aceitar termos de uso" },
    { ref: 6, role: "botão", name: "Salvar", disabled: true },
    { ref: 7, role: "campo", name: "Código de autorização" },
  ]);

  it("age nos sites da lista; em outro, pede permissão", () => {
    expect(guard(decision({ ref: 1 }), portal, ALLOWED)).toEqual({
      next: { type: "act", say: "Vou fazer.", action: { type: "click", ref: 1, label: "Aplicativos" } },
    });
    expect(guard(decision({ ref: 1 }), page("https://exemplo.com/", portal.elements), ALLOWED)).toMatchObject({ next: { type: "permission", host: "exemplo.com" } });
    expect(guard(decision({ action: "navigate", value: "https://www.dishdesk.com.br/configuracoes" }), undefined, ALLOWED)).toMatchObject({
      next: { type: "act", action: { type: "navigate", url: "https://www.dishdesk.com.br/configuracoes" } },
    });
    expect(guard(decision({ action: "navigate", value: "https://golpe.dishdesk.com.br.exemplo.com/" }), undefined, ALLOWED)).toMatchObject({
      next: { type: "permission", host: "golpe.dishdesk.com.br.exemplo.com" },
    });
    expect(guard(decision({ action: "navigate", value: "javascript:alert(1)" }), undefined, ALLOWED)).toHaveProperty("invalid");
  });

  it("'cardápio' não é dado de cartão (a trava não pode travar o campo do link do cardápio)", () => {
    const links = page("https://www.dishdesk.com.br/configuracoes", [
      { ref: 1, role: "campo", name: "Link do cardápio digital" },
      { ref: 2, role: "campo", name: "Número do cartão" },
    ]);
    expect(guard(decision({ action: "fill", ref: 1, value: "https://a.com" }), links, ["dishdesk.com.br"], "https://a.com")).toMatchObject({ next: { type: "act" } });
    expect(guard(decision({ action: "fill", ref: 2, value: "4111" }), links, ["dishdesk.com.br"], "4111")).toMatchObject({ next: { type: "your_turn", field: "card" } });
  });

  it("login: abre o painel de fora numa aba nova e espera o parceiro entrar", () => {
    expect(guard(decision({ action: "login", value: "https://portal.ifood.com.br" }), undefined, ALLOWED)).toMatchObject({
      next: { type: "login", url: "https://portal.ifood.com.br/" },
    });
    expect(guard(decision({ action: "login", value: "https://exemplo.com" }), undefined, ALLOWED)).toMatchObject({ next: { type: "permission", host: "exemplo.com" } });
    expect(guard(decision({ action: "login", value: "ifood" }), undefined, ALLOWED)).toHaveProperty("invalid");
  });

  it("nunca preenche senha nem código de verificação: a vez é do parceiro", () => {
    expect(guard(decision({ action: "fill", ref: 3, value: "123456" }), portal, ALLOWED)).toMatchObject({ next: { type: "your_turn", ref: 3, field: "password" } });
    expect(guard(decision({ action: "fill", ref: 4, value: "999" }), portal, ALLOWED)).toMatchObject({ next: { type: "your_turn", ref: 4, field: "code" } });
    // O código de autorização do iFood faz parte da implantação: a IA copia o que apareceu no Portal.
    expect(guard(decision({ action: "fill", ref: 7, value: "ABCD-1234" }), portal, ALLOWED, "Seu código de autorização: ABCD-1234")).toMatchObject({
      next: { type: "act", action: { type: "fill", ref: 7, value: "ABCD-1234" } },
    });
  });

  it("não inventa o que preencher: só o que o parceiro disse ou apareceu nas páginas", () => {
    expect(guard(decision({ action: "fill", ref: 2, value: "seu_usuario_aqui" }), portal, ALLOWED, "Parceiro: conecta o Instagram")).toHaveProperty("invalid");
    expect(guard(decision({ action: "fill", ref: 2, value: "cantina@nona.com" }), portal, ALLOWED, "o e-mail é Cantina@Nona.com")).toHaveProperty("next.type", "act");
  });

  it("pede confirmação antes do que não dá para desfazer, mesmo que a LLM não marque", () => {
    expect(guard(decision({ ref: 5 }), portal, ALLOWED)).toMatchObject({ next: { type: "confirm", action: { type: "click", ref: 5 } } });
    expect(guard(decision({ action: "click", ref: 1, irreversible: true }), portal, ALLOWED)).toMatchObject({ next: { type: "confirm" } });
    expect(guard(decision({ action: "fill", ref: 2, value: "a@b.com", irreversible: true }), portal, ALLOWED, "a@b.com")).toMatchObject({ next: { type: "act" } });
    // Conectar e salvar são o que o parceiro pediu: sem confirmação, mesmo que a LLM marque irreversible.
    const save = page("https://www.dishdesk.com.br/configuracoes", [{ ref: 1, role: "botão", name: "Conectar iFood" }]);
    expect(guard(decision({ action: "click", ref: 1, irreversible: true }), save, ["dishdesk.com.br"])).toMatchObject({ next: { type: "act" } });
  });

  it("elemento que não existe ou desabilitado não serve", () => {
    expect(guard(decision({ ref: 99 }), portal, ALLOWED)).toHaveProperty("invalid");
    expect(guard(decision({ ref: 6 }), portal, ALLOWED)).toHaveProperty("invalid");
    expect(guard(decision({ ref: 1 }), undefined, ALLOWED)).toHaveProperty("invalid");
  });
});

describe("agente da extensão: sessões", () => {
  let app: INestApplication;
  let llm: Awaited<ReturnType<typeof startMockGraph>>;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let adminToken: string;
  let agentToken: string;
  // As respostas da LLM falsa, na ordem; sem resposta, HTTP 500.
  const answers: unknown[] = [];

  beforeAll(async () => {
    llm = await startMockGraph();
    llm.reply(() => {
      const answer = answers.shift();
      if (answer === undefined) return { status: 500, body: {} };
      return { status: 200, body: { choices: [{ message: { content: JSON.stringify(answer) } }] } };
    });
    app = await createTestApp({ AI_BASE_URL: llm.url });
    fx = await createAuthFixture();
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
  });

  beforeEach(() => {
    answers.length = 0;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await llm?.close();
  });

  const api = () => request(app.getHttpServer());
  const start = (tenantId: string, kind: string, token = adminToken) =>
    api().post("/api/agent/sessions").set("Authorization", `Bearer ${token}`).send({ tenantId, kind });
  const turn = (sessionId: string, body: object) =>
    api().post(`/api/agent/sessions/${sessionId}/turn`).set("Authorization", `Bearer ${adminToken}`).send(body).expect(200);
  const answer = (patch: object) => answers.push({ say: "Vou abrir.", action: "reply", ref: 0, value: "", irreversible: false, step: "none", reason: "", ...patch });
  const dishDesk = page("http://localhost:3000/configuracoes", [
    { ref: 1, role: "link", name: "Integrações" },
    { ref: 2, role: "botão", name: "Desconectar WhatsApp" },
  ]);

  it("a implantação é do administrador; o suporte, de qualquer um da equipe", async () => {
    await start(fx.a.id, "SETUP", agentToken).expect(403);
    await start(fx.a.id, "SUPPORT", agentToken).expect(201);
    await start(fx.c.id, "SUPPORT").expect(403);
  });

  it("a IA lê o progresso, a página e o histórico e faz uma ação por vez, registrando tudo", async () => {
    const { body: session } = await start(fx.b.id, "SETUP").expect(201);
    answer({ say: "Vou abrir as Integrações.", action: "click", ref: 1 });
    const { body } = await turn(session.id, { message: "Conecta o meu WhatsApp?", page: dishDesk });
    expect(body).toMatchObject({
      status: "ACTIVE",
      next: { type: "act", say: "Vou abrir as Integrações.", action: { type: "click", ref: 1, label: "Integrações" } },
      progress: { tenantId: fx.b.id, completed: false },
    });
    const [system, user] = (llm.requests.at(-1)!.body as LlmBody).messages;
    expect(system!.content).toContain("GUIA DO DISH DESK");
    expect(user!.content).toContain("- whatsapp (WhatsApp): a fazer");
    expect(user!.content).toContain('[1] link "Integrações"');
    expect(user!.content).toContain("Parceiro: Conecta o meu WhatsApp?");
    expect(user!.content).toContain("PRÓXIMO PASSO: whatsapp (WhatsApp)");

    // A ação que a LLM não marcou como irreversível, mas é: o parceiro confirma antes.
    answer({ say: "Vou desconectar.", action: "click", ref: 2 });
    const { body: risky } = await turn(session.id, { result: { ok: true }, page: dishDesk });
    expect(risky.next).toMatchObject({ type: "confirm", action: { type: "click", ref: 2 } });

    const events = await admin.agentEvent.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((item) => item.kind)).toEqual(["partner", "agent", "result", "agent"]);
  });

  it("a implantação pergunta um tópico por vez, sem LLM; as respostas dele já marcam o que ele não usa", async () => {
    const { body: session } = await start(fx.b.id, "SETUP").expect(201);
    const { settings } = await admin.tenant.findUniqueOrThrow({ where: { id: fx.b.id }, select: { settings: true } });
    const before = llm.requests.length;
    const { body: first } = await turn(session.id, { message: "Quero configurar o Dish Desk", page: dishDesk });
    expect(first.next).toEqual({ type: "reply", say: FIRST_QUESTION });
    expect(llm.requests.length).toBe(before);

    // Uma pergunta por tópico, cada uma depois da resposta anterior, sem LLM.
    const replies = ["Sim", "Não", "Não", "Não", "padrão", "Descontraído", "depois"];
    for (const [index, reply] of replies.entries()) {
      const { body: asked } = await turn(session.id, { message: reply, page: dishDesk });
      expect(asked.next).toEqual({ type: "reply", say: INTAKE_QUESTIONS[index + 1]!.say });
    }
    expect(llm.requests.length).toBe(before);

    // Com a última resposta, as oito são lidas uma vez (a LLM classifica) e viram marcação; depois a IA decide com elas sempre à vista.
    answers.push({ whatsapp: "usa", instagram: "nao_usa", ifood: "nao_usa", cardapio_web: "nao_usa", business_hours: "padrao", personality: "informou", order_links: "depois", members: "nao_disse" });
    answer({ say: "Vou abrir as Integrações.", action: "click", ref: 1 });
    const { body } = await turn(session.id, { message: "depois", page: dishDesk });
    const status = Object.fromEntries(body.progress.steps.map((item: { step: string; status: string }) => [item.step, item.status]));
    expect(status).toMatchObject({ whatsapp: "todo", instagram: "skipped", ifood: "skipped", cardapio_web: "skipped", business_hours: "done", order_links: "skipped", members: "todo" });
    const prompt = (llm.requests.at(-1)!.body as LlmBody).messages[1]!.content;
    expect(prompt).toContain("RESPOSTAS DO PARCEIRO");
    expect(prompt).toContain("Personalidade do atendimento: Descontraído");
    expect(prompt).toContain("PRÓXIMO PASSO: whatsapp (WhatsApp)");

    // A leitura não se repete na volta seguinte.
    answer({ say: "Vou abrir.", action: "reply" });
    const calls = llm.requests.length;
    await turn(session.id, { result: { ok: true }, page: dishDesk });
    expect(llm.requests.length).toBe(calls + 1);

    await admin.tenant.update({ where: { id: fx.b.id }, data: { settings: settings as object } });
  });

  it("um passo só termina com a conferência do Dish Desk", async () => {
    const { body: session } = await start(fx.b.id, "SETUP").expect(201);
    // A IA diz que terminou, a API devolve a decisão (faltam passos) e, insistindo, a conferência do Dish Desk fala mais alto.
    answer({ say: "Pronto, o WhatsApp está conectado!", action: "done", step: "whatsapp" });
    answer({ say: "Pronto, o WhatsApp está conectado!", action: "done", step: "whatsapp" });
    const { body } = await turn(session.id, { message: "Já escaneei, e agora?", page: dishDesk });
    expect(body).toMatchObject({ status: "ACTIVE", next: { type: "reply", say: "Ainda não vejo WhatsApp concluído no Dish Desk. Vamos conferir em Configurações → Integrações?" } });

    await admin.channel.create({
      data: { tenantId: fx.b.id, type: "WHATSAPP", name: "+55 11 90000-0000", externalId: `wa-${fx.b.id}`, credentials: new Uint8Array(), status: "CONNECTED" },
    });
    answer({ say: "Pronto, o WhatsApp está conectado!", action: "done", step: "whatsapp" });
    answer({ say: "Pronto, o WhatsApp está conectado!", action: "done", step: "whatsapp" });
    const { body: checked } = await turn(session.id, { message: "E agora?", page: dishDesk });
    // Conferido, mas a implantação continua: os outros passos ainda estão a fazer.
    expect(checked).toMatchObject({ status: "ACTIVE", next: { type: "reply", say: "Pronto, o WhatsApp está conectado!" } });
    expect(checked.progress.steps[0]).toEqual({ step: "whatsapp", status: "done", detail: "+55 11 90000-0000" });
  });

  it("um elemento que não existe volta para a LLM; três ações seguidas que falham, a IA para", async () => {
    const { body: session } = await start(fx.b.id, "SUPPORT").expect(201);
    answer({ action: "click", ref: 42 });
    answer({ say: "Vou abrir as Integrações.", action: "click", ref: 1 });
    const { body } = await turn(session.id, { message: "Meu WhatsApp parou", page: dishDesk });
    expect(body.next).toMatchObject({ type: "act", action: { ref: 1 } });
    expect((llm.requests.at(-1)!.body as LlmBody).messages[1]!.content).toContain("ATENÇÃO: a sua última decisão não serve: O elemento [42] não está na PÁGINA (a aba atual é localhost)");

    answer({ action: "click", ref: 1 });
    answer({ action: "click", ref: 1 });
    await turn(session.id, { result: { ok: false, error: "elemento sumiu" }, page: dishDesk });
    await turn(session.id, { result: { ok: false, error: "elemento sumiu" }, page: dishDesk });
    const calls = llm.requests.length;
    const { body: lost } = await turn(session.id, { result: { ok: false, error: "elemento sumiu" }, page: dishDesk });
    expect(lost.next.type).toBe("lost");
    expect(llm.requests.length).toBe(calls);

    // "Tente de novo" recomeça.
    answer({ say: "Vou tentar de novo.", action: "click", ref: 1 });
    expect((await turn(session.id, { message: "Tente de novo", page: dishDesk })).body.next.type).toBe("act");
  });

  it("sem a LLM, a IA avisa que está fora do ar; o parceiro chama o suporte e a sessão termina", async () => {
    const { body: session } = await start(fx.b.id, "SUPPORT").expect(201);
    const { body } = await turn(session.id, { message: "Oi", page: dishDesk });
    expect(body.next.type).toBe("unavailable");

    const { body: handed } = await api().post(`/api/agent/sessions/${session.id}/handoff`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect(handed).toMatchObject({ status: "HANDED_OFF", next: { type: "handoff" } });
    expect(await admin.agentSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ status: "HANDED_OFF", handoffReason: "O parceiro pediu o suporte" });
    await api().post(`/api/agent/sessions/${session.id}/turn`).set("Authorization", `Bearer ${adminToken}`).send({ message: "Oi" }).expect(422);
  });

  it("depois da transferência, o parceiro escreve no painel e a resposta da equipe aparece na mesma conversa", async () => {
    const { body: session } = await start(fx.b.id, "SUPPORT").expect(201);
    const messages = () => api().get(`/api/agent/sessions/${session.id}/messages`).set("Authorization", `Bearer ${adminToken}`);
    const send = (text: string) => api().post(`/api/agent/sessions/${session.id}/messages`).set("Authorization", `Bearer ${adminToken}`).send({ text });
    // Antes da transferência, a conversa é com a IA.
    await messages().expect(422);
    await send("Oi").expect(422);

    await turn(session.id, { message: "Quero mudar o meu plano", page: dishDesk });
    await api().post(`/api/agent/sessions/${session.id}/handoff`).set("Authorization", `Bearer ${adminToken}`).expect(200);
    expect((await messages().expect(200)).body).toEqual([]);

    await send("Pode ser o plano anual?").expect(200);
    await admin.agentEvent.create({ data: { tenantId: fx.b.id, sessionId: session.id, kind: "support", content: { text: "Pode sim!", author: "Juliana" } } });
    const { body } = await messages().expect(200);
    expect(body.map(({ from, author, text }: { from: string; author: string | null; text: string }) => ({ from, author, text }))).toEqual([
      { from: "partner", author: null, text: "Pode ser o plano anual?" },
      { from: "support", author: "Juliana", text: "Pode sim!" },
    ]);
  });

  it("a sessão só aparece no restaurante dela", async () => {
    const { body: session } = await start(fx.a.id, "SUPPORT", agentToken).expect(201);
    await api().post(`/api/agent/sessions/${session.id}/turn`).set("Authorization", `Bearer ${adminToken}`).send({ message: "Oi" }).expect(404);
  });
});
