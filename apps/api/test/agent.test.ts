import { ONBOARDING_STEPS, type OnboardingDto, type OnboardingStepStatus, type PageSnapshot } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Decision, guard } from "../src/agent/agent-guard.js";
import { FIRST_QUESTION, firstMessageTurn } from "../src/agent/agent.service.js";
import { type CardapioWebCredentials, cardapioWebRail, credentialsOf } from "../src/agent/cardapio-web-rail.js";
import { authCodeOf, ifoodRail, linkCodeOf } from "../src/agent/ifood-rail.js";
import { INTAKE_INTRO, INTAKE_QUESTIONS } from "../src/agent/intake.js";
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

  it("numa ação, a IA diz o que está fazendo: instruções ao parceiro viram a descrição da ação", () => {
    const say = "Agora que você está logado, siga estes passos: 1. Clique no botão Integrações. 2. Copie o código e cole aqui.";
    expect(guard(decision({ say, ref: 1 }), portal, ALLOWED)).toMatchObject({ next: { type: "act", say: "Vou clicar em Aplicativos." } });
    expect(guard(decision({ say, action: "navigate", value: "https://portal.ifood.com.br/apps" }), portal, ALLOWED)).toMatchObject({
      next: { say: "Vou abrir portal.ifood.com.br/apps." },
    });
    expect(guard(decision({ say: "Vou abrir os aplicativos.", ref: 1 }), portal, ALLOWED)).toMatchObject({ next: { say: "Vou abrir os aplicativos." } });
  });
});

describe("agente da extensão: o caminho do Cardápio Web", () => {
  const at = (path: string, elements: PageSnapshot["elements"]): PageSnapshot => ({ url: `https://portal.cardapioweb.com${path}`, title: "Cardápio Web", elements, text: "" });
  const menu = [
    { ref: 1, role: "link", name: "CW App Store" },
    { ref: 2, role: "link", name: "settings Configurações" },
  ];
  const rail = (page: PageSnapshot, credentials: CardapioWebCredentials | null = null) => cardapioWebRail({ page, panelHost: "www.dishdesk.com.br", credentials });
  const TOKEN = "1hd0B9TykVb2JPVPCAnLnGWqoLcnvXyZ0123456789abcdefABCDEF012345";

  it("lê o código da loja e o token inteiro no texto da gaveta", () => {
    const text = `Terra Querida Configurações Geral Integrações API de integração Utilize o Token abaixo. Código da loja 69156 Copiar ${TOKEN} Copiar token GERAR UM NOVO TOKEN`;
    expect(credentialsOf(text)).toEqual({ storeId: "69156", apiKey: TOKEN });
    expect(credentialsOf("Código da loja 69156 Copiar")).toBeNull();
  });

  it("no Dish Desk, preenche o código da loja e o token no modal e clica no Conectar dele", () => {
    const credentials = { storeId: "69156", apiKey: TOKEN };
    const modal = (store: string, key: string): PageSnapshot => ({
      url: "https://www.dishdesk.com.br/configuracoes?tab=integracoes",
      title: "Dish Desk",
      text: "Cardápio Web Nova integração Código da loja Chave de API | Integrações",
      elements: [
        { ref: 3, role: "botão", name: "Conectar" },
        { ref: 20, role: "campo", name: "Código da loja", ...(store && { value: store }) },
        { ref: 21, role: "campo", name: "Chave de API", ...(key && { value: key }) },
        { ref: 22, role: "botão", name: "Conectar" },
      ],
    });
    expect(rail(modal("9", ""), credentials)).toMatchObject({ action: "fill", ref: 20, value: "69156" });
    expect(rail(modal("69156", ""), credentials)).toMatchObject({ action: "fill", ref: 21, value: TOKEN });
    expect(rail(modal("69156", TOKEN), credentials)).toMatchObject({ action: "click", ref: 22 });
    // Sem o que foi lido no portal, a LLM decide.
    expect(rail(modal("", ""))).toBeNull();
  });

  it("Configurações → Integrações → API de integração → volta ao Dish Desk, sem clicar de novo em Configurações", () => {
    expect(rail(at("/", menu))).toMatchObject({ action: "click", ref: 2 });
    // O menu das Configurações (itens de div, que a extensão lê pelo cursor), em qualquer endereço.
    const settings = at("/settings", [...menu, { ref: 3, role: "botão", name: "Geral" }, { ref: 4, role: "botão", name: "Integrações" }]);
    expect(rail(settings)).toMatchObject({ action: "click", ref: 4 });
    expect(rail(at("/configuracoes/integracoes", [...menu, { ref: 5, role: "botão", name: "API de integração" }]))).toMatchObject({ action: "click", ref: 5 });
    const drawer = at("/configuracoes/integracoes", [
      { ref: 6, role: "campo", name: "Código da loja", value: "13047" },
      { ref: 7, role: "botão", name: "Copiar token" },
      { ref: 8, role: "botão", name: "Gerar um novo token" },
      ...menu,
    ]);
    expect(rail(drawer)).toMatchObject({ action: "switch", value: "www.dishdesk.com.br" });
    // Fora do portal, a LLM decide.
    expect(rail({ ...at("/", menu), url: "https://www.dishdesk.com.br/configuracoes" })).toBeNull();
  });
});

describe("agente da extensão: o caminho do iFood", () => {
  const panelHost = "www.dishdesk.com.br";
  const at = (url: string, elements: PageSnapshot["elements"], text = ""): PageSnapshot => ({ url, title: "Página", elements, text });
  const rail = (page: PageSnapshot, patch: Partial<Parameters<typeof ifoodRail>[0]> = {}) =>
    ifoodRail({ page, panelHost, linkCode: "KMQP-JDRF", authCode: null, opened: [], submitted: false, connected: false, ...patch });
  const boxes = (values: string[]) => values.map((value, index) => ({ ref: 10 + index, role: "campo", name: "", ...(value && { value }) }));

  it("lê os códigos: o de vinculação no modal do Dish Desk e o de autorização no portal", () => {
    expect(linkCodeOf("Exemplo ABCD-EFGH. Abra o Portal e confira este código. Clique em Autorizar. KMQP-JDRF Abrir o Portal")).toBe("KMQP-JDRF");
    expect(linkCodeOf("Integrações")).toBeNull();
    expect(authCodeOf("Código KMQP-JDRF autorizado. Código de autorização: LHQX-ZZZZ", "KMQP-JDRF")).toBe("LHQX-ZZZZ");
    expect(authCodeOf("Código KMQP-JDRF", "KMQP-JDRF")).toBeNull();
    // Um código longe de "autorização" (ex.: outro código da página) não é o de autorização.
    expect(authCodeOf("Pedido ABCD-1234 entregue. Integrações ativas.", "KMQP-JDRF")).toBeNull();
    // O modal "Integração autorizada" do portal: o código vem no campo, e o texto da página é cortado antes do modal.
    expect(authCodeOf("Endereço: https://portal.ifood.com.br/apps\ncampo: JPVM-MVWN\nIntegrações Minhas integrações Dish Desk", "KMQP-JDRF")).toBe("JPVM-MVWN");
  });

  it("no portal: abre /apps, clica em Ativar integração por código, digita o código e continua", () => {
    expect(rail(at("https://portal.ifood.com.br/integracoes", [{ ref: 1, role: "link", name: "Financeiro" }]))).toMatchObject({
      action: "navigate",
      value: "https://portal.ifood.com.br/apps",
    });
    const apps = at("https://portal.ifood.com.br/apps", [
      { ref: 1, role: "link", name: "Financeiro" },
      { ref: 2, role: "botão", name: "Ativar integração por código" },
      { ref: 3, role: "campo", name: "Buscar uma integração" },
    ]);
    expect(rail(apps)).toMatchObject({ action: "click", ref: 2 });
    expect(rail(apps, { submitted: true })).toBeNull();

    const modal = (values: string[], disabled = true) =>
      at("https://portal.ifood.com.br/apps", [...boxes(values), { ref: 20, role: "botão", name: "Continuar", disabled }, ...apps.elements], "Ativar uma integração | Digite aqui o código de ativação");
    expect(rail(modal(["", "", "", "", "-", "", "", "", ""]))).toMatchObject({ action: "fill", ref: 10, value: "KMQP-JDRF" });
    expect(rail(modal(["K", "M", "Q", "P", "-", "J", "D", "R", "F"], false))).toMatchObject({ action: "click", ref: 20 });
    // O parceiro colou e não clicou em Continuar: a IA clica (com o código já enviado, não pede para colar de novo).
    expect(rail(modal(["K", "M", "Q", "P", "-", "J", "D", "R", "F"], false), { submitted: true })).toMatchObject({ action: "click", ref: 20 });
    expect(rail(modal(["", "", "", "", "-", "", "", "", ""]), { submitted: true })).toBeNull();
    // O texto da página longa vem cortado antes do modal: os elementos dele bastam (não clica de novo em Ativar).
    const cut = at("https://portal.ifood.com.br/apps", [...boxes(["", "", "", "", "-", "", "", "", ""]), { ref: 20, role: "botão", name: "Continuar", disabled: true }, ...apps.elements]);
    expect(rail(cut)).toMatchObject({ action: "fill", ref: 10, value: "KMQP-JDRF" });
    // Sem o código de vinculação, a LLM decide.
    expect(rail(modal(["", "", "", "", "-", "", "", "", ""]), { linkCode: null })).toBeNull();

    // "Permitir integração" depois do código (as caixinhas do modal anterior continuam na página): autoriza, não volta a elas.
    const allow = at("https://portal.ifood.com.br/apps", [...boxes(["", "", "", "", "-", "", "", "", ""]), { ref: 21, role: "botão", name: "Cancelar" }, { ref: 22, role: "botão", name: "Autorizar" }]);
    expect(rail(allow, { submitted: true })).toMatchObject({ action: "click", ref: 22 });
    expect(guard(rail(allow, { submitted: true })!, allow, ALLOWED)).toMatchObject({ next: { type: "confirm", action: { ref: 22 } } });

    // Com o código de autorização na tela, volta ao Dish Desk.
    expect(rail(apps, { authCode: "LHQX-ZZZZ" })).toMatchObject({ action: "switch", value: panelHost });
  });

  it("no Dish Desk: vai ao portal com o código; com o código de autorização, cola e conecta", () => {
    const form = (value?: string) =>
      at(
        "https://www.dishdesk.com.br/configuracoes/integracoes?conectar=IFOOD",
        [
          { ref: 1, role: "campo", name: "Código de autorização", ...(value && { value }) },
          { ref: 2, role: "botão", name: "Conectar" },
        ],
        "iFood. Abra o Portal do Parceiro e confira este código. KMQP-JDRF",
      );
    expect(rail(form())).toMatchObject({ action: "login", value: "https://portal.ifood.com.br/apps" });
    expect(rail(form(), { opened: ["portal.ifood.com.br"] })).toMatchObject({ action: "switch", value: "portal.ifood.com.br" });
    expect(rail(form(), { authCode: "LHQX-ZZZZ" })).toMatchObject({ action: "fill", ref: 1, value: "LHQX-ZZZZ" });
    expect(rail(form("LHQX-ZZZZ"), { authCode: "LHQX-ZZZZ" })).toMatchObject({ action: "click", ref: 2 });
    // O campo com o código de uma tentativa anterior: troca pelo novo.
    expect(rail(form("OLDX-CODE"), { authCode: "LHQX-ZZZZ" })).toMatchObject({ action: "fill", ref: 1, value: "LHQX-ZZZZ" });

    // O iFood recusou o código depois do Conectar: gera um novo código de vinculação (o erro antigo não repete o clique).
    const refused = {
      ...form("LHQX-ZZZZ"),
      elements: [...form("LHQX-ZZZZ").elements, { ref: 3, role: "botão", name: "Gerar outro" }],
      text: "iFood. Abra o Portal e confira este código. KMQP-JDRF Não foi possível conectar o iFood: o código de autorização não foi aceito (gere um novo código de vinculação).",
    };
    expect(rail(refused, { authCode: "LHQX-ZZZZ", connected: true })).toMatchObject({ action: "click", ref: 3 });
    expect(rail(refused, { authCode: null, connected: false })).toMatchObject({ action: "login" });
    // Outra tela do Dish Desk: a LLM decide.
    expect(rail(at("https://www.dishdesk.com.br/configuracoes/horario", []))).toBeNull();

    // O "Conectar" da lista atrás do modal (mais antigo) não é o do modal.
    const behind = { ...form("LHQX-ZZZZ"), elements: [{ ref: 0, role: "botão", name: "Conectar" }, ...form("LHQX-ZZZZ").elements] };
    expect(rail(behind, { authCode: "LHQX-ZZZZ" })).toMatchObject({ action: "click", ref: 2 });

    // A autorização trouxe várias lojas: conecta as marcadas, com a confirmação do parceiro (pode ter adiantado etapas no portal).
    const stores = at(
      "https://www.dishdesk.com.br/configuracoes/integracoes?conectar=IFOOD",
      [
        { ref: 0, role: "botão", name: "Conectar" },
        { ref: 40, role: "caixa de seleção", name: "Loja do iFood", checked: true },
        { ref: 41, role: "botão", name: "Conectar 3 lojas" },
      ],
      "iFood. Nova integração. A autorização do iFood trouxe 4 lojas. Marque as que vão ser conectadas a este restaurante.",
    );
    expect(rail(stores, { authCode: "LHQX-ZZZZ" })).toMatchObject({ action: "click", ref: 41, irreversible: true });
  });
});

describe("agente da extensão: a mensagem de teste", () => {
  const progress = (status: Partial<Record<string, OnboardingStepStatus>>): OnboardingDto => {
    const steps = ONBOARDING_STEPS.map((step) => ({ step, status: status[step] ?? "skipped", detail: null }));
    return { tenantId: "t", steps, firstMessage: null, completed: steps.every((item) => item.status !== "todo" && item.status !== "error"), autoOpen: false };
  };
  const partner = (text: string) => ({ kind: "partner", content: { text } });
  const agent = (say: string) => ({ kind: "agent", content: { next: { type: "reply", say } } });
  const waiting = progress({ whatsapp: "done", first_message: "todo" });

  it("só falta a mensagem de teste: pede ao parceiro, sem a LLM; ainda não chegou, avisa; chegou, termina", () => {
    const said = [partner("Quero configurar o Dish Desk."), agent("Vou realizar o teste da primeira mensagem."), partner("ok")];
    const asked = firstMessageTurn("SETUP", waiting, said);
    expect(asked).toMatchObject({ type: "reply", say: expect.stringMatching(/^Falta só um teste: de outro celular, mande uma mensagem para o WhatsApp/) });

    const after = [...said, agent(asked!.say), partner("pronto")];
    expect(firstMessageTurn("SETUP", waiting, after)).toMatchObject({ type: "reply", say: expect.stringContaining("Ainda não chegou") });
    expect(firstMessageTurn("SETUP", progress({ whatsapp: "done", first_message: "done" }), after)).toMatchObject({ type: "done" });
  });

  it("sem WhatsApp, a instrução é pelo Instagram; com outro passo a fazer, com uma pergunta ou no suporte, a LLM decide", () => {
    expect(firstMessageTurn("SETUP", progress({ instagram: "done", first_message: "todo" }), [])).toMatchObject({
      say: expect.stringContaining("mensagem direta para o Instagram"),
    });
    expect(firstMessageTurn("SETUP", progress({ members: "todo", first_message: "todo" }), [])).toBeNull();
    expect(firstMessageTurn("SETUP", waiting, [partner("Posso testar do meu próprio número?")])).toBeNull();
    expect(firstMessageTurn("SUPPORT", waiting, [])).toBeNull();
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
      // Texto: a resposta crua da LLM (ex.: um JSON quebrado).
      return { status: 200, body: { choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) } }] } };
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

  it("a implantação não pergunta o que já está feito no Dish Desk", async () => {
    const channel = await admin.channel.create({
      data: { tenantId: fx.b.id, type: "WHATSAPP", name: "+55 11 90000-0001", externalId: `wa-pergunta-${fx.b.id}`, credentials: new Uint8Array(), status: "CONNECTED" },
    });
    try {
      const { body: session } = await start(fx.b.id, "SETUP").expect(201);
      const { body: first } = await turn(session.id, { message: "Quero configurar o Dish Desk", page: dishDesk });
      expect(first.next).toEqual({ type: "reply", say: INTAKE_INTRO + INTAKE_QUESTIONS[1]!.say });
      const { body: second } = await turn(session.id, { message: "Sim", page: dishDesk });
      expect(second.next).toEqual({ type: "reply", say: INTAKE_QUESTIONS[2]!.say });
    } finally {
      await admin.channel.delete({ where: { id: channel.id } });
    }
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

  it("iFood: as caixinhas são campo de código; o parceiro cola o código de vinculação que o painel mostra com Copiar", async () => {
    const { body: session } = await start(fx.b.id, "SETUP").expect(201);
    const form = { ...page("http://localhost:3000/configuracoes/integracoes?conectar=IFOOD", []), text: "iFood. Abra o Portal e confira este código. KMQP-JDRF" };
    answer({ say: "Vou abrir o portal.", action: "reply" });
    await turn(session.id, { message: "Como conecto o iFood?", page: form });

    const modal = page("https://portal.ifood.com.br/apps", [
      ...Array.from({ length: 9 }, (_, index) => ({ ref: 10 + index, role: "campo", name: "", sensitive: "code" as const })),
      { ref: 20, role: "botão", name: "Continuar", disabled: true },
    ]);
    const calls = llm.requests.length;
    const { body } = await turn(session.id, { result: { ok: true }, page: modal });
    expect(body.next).toMatchObject({ type: "your_turn", ref: 10, field: "code", copy: "KMQP-JDRF" });
    expect(llm.requests.length).toBe(calls);

    // O parceiro colou e clicou em Continuar no iFood: o modal "Integração autorizada" traz o código num campo (o texto vem
    // cortado antes do modal). A IA volta ao Dish Desk, sem clicar de novo em "Ativar integração por código".
    const authorized = page("https://portal.ifood.com.br/apps", [
      { ref: 30, role: "campo", name: "", value: "JPVM-MVWN" },
      { ref: 31, role: "link", name: "Copiar" },
      { ref: 32, role: "botão", name: "Ativar integração por código" },
    ]);
    const { body: back } = await turn(session.id, { message: "Pronto, terminei.", page: { ...authorized, text: "Integrações Minhas integrações" } });
    expect(back.next).toMatchObject({ type: "act", action: { type: "switch", host: "localhost" } });
  });

  it("iFood: código recusado ao conectar → gera outro e volta ao portal sem reaproveitar o código de autorização antigo", async () => {
    const { body: session } = await start(fx.b.id, "SETUP").expect(201);
    const form = (code: string, value: string | null, error = "") => ({
      url: "http://localhost:3000/configuracoes/integracoes?conectar=IFOOD",
      title: "Dish Desk",
      elements: [
        { ref: 1, role: "campo", name: "Código de autorização", ...(value && { value }) },
        { ref: 2, role: "botão", name: "Conectar" },
        { ref: 3, role: "botão", name: "Gerar outro" },
      ],
      text: `iFood. Abra o Portal e confira este código. ${code} ${error}`,
    });
    const portal = { ...page("https://portal.ifood.com.br/apps", []), text: "Integração ativada. Código de autorização: LHQX-ZZZZ" };
    const ok = { result: { ok: true } };

    answer({ say: "Vou ver.", action: "reply" });
    await turn(session.id, { message: "Como conecto o iFood?", page: form("KMQP-JDRF", null) });
    expect((await turn(session.id, { ...ok, page: portal })).body.next).toMatchObject({ type: "act", action: { type: "switch", host: "localhost" } });
    // O parceiro cola o código de autorização no Dish Desk, com o botão Copiar do painel.
    expect((await turn(session.id, { ...ok, page: form("KMQP-JDRF", null) })).body.next).toMatchObject({ type: "your_turn", ref: 1, copy: "LHQX-ZZZZ" });
    expect((await turn(session.id, { ...ok, page: form("KMQP-JDRF", "LHQX-ZZZZ") })).body.next).toMatchObject({ action: { type: "click", label: "Conectar" } });
    const refused = form("KMQP-JDRF", "LHQX-ZZZZ", "Não foi possível conectar o iFood: o código de autorização não foi aceito (gere um novo código de vinculação).");
    expect((await turn(session.id, { ...ok, page: refused })).body.next).toMatchObject({ action: { type: "click", label: "Gerar outro" } });
    // Código novo: o de autorização antigo não serve; volta ao portal.
    expect((await turn(session.id, { ...ok, page: form("WXYZ-2345", "LHQX-ZZZZ") })).body.next).toMatchObject({ type: "login", url: "https://portal.ifood.com.br/apps" });

    // Várias lojas na autorização: o Conectar das lojas pede a confirmação do parceiro.
    const stores = {
      url: "http://localhost:3000/configuracoes/integracoes?conectar=IFOOD",
      title: "Dish Desk",
      elements: [{ ref: 41, role: "botão", name: "Conectar 3 lojas" }],
      text: "iFood. A autorização do iFood trouxe 4 lojas. Marque as que vão ser conectadas a este restaurante.",
    };
    expect((await turn(session.id, { ...ok, page: stores })).body.next).toMatchObject({ type: "confirm", action: { type: "click", ref: 41 } });
  });

  it("um JSON quebrado da LLM é pedido de novo, sem dizer que a IA está fora do ar", async () => {
    const { body: session } = await start(fx.b.id, "SUPPORT").expect(201);
    answers.push('{"say": "Vou abrir.", "action": "click",\n}');
    answer({ say: "Vou abrir as Integrações.", action: "click", ref: 1 });
    const { body } = await turn(session.id, { message: "Meu WhatsApp parou", page: dishDesk });
    expect(body.next).toMatchObject({ type: "act", action: { ref: 1 } });
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
