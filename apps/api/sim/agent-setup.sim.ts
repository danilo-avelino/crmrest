// Simulação de uma implantação do zero com o agente da extensão (E31): a LLM de verdade (AI_BASE_URL, por padrão o
// Ollama local) decide cada passo num navegador falso (Dish Desk, Portal do Parceiro do iFood e Portal do Cardápio Web)
// e um parceiro simulado responde. Usa o mesmo prompt, as mesmas travas e o mesmo laço de marcações da API.
// O que mede: quantas ações o PARCEIRO precisou fazer (menos é melhor). Uso: pnpm sim:agent
import {
  AGENT_HOSTS,
  type AgentAction,
  type AgentPageAction,
  ONBOARDING_STEPS,
  type OnboardingDto,
  type OnboardingMark,
  type OnboardingStep,
  type PageSnapshot,
} from "@dishdesk/shared";
import { describe, it } from "vitest";
import { AgentService, type DecideContext, MAX_FAILURES } from "../src/agent/agent.service.js";
import { extrasOf } from "../src/agent/intake.js";
import { LlmClient } from "../src/ai/llm.client.js";
import type { Env } from "../src/config/env.js";

const PANEL = "https://www.dishdesk.com.br";
const MAX_TURNS = Number(process.env.SIM_MAX_TURNS ?? 70);
/** Ações seguidas da IA antes de ela parar e perguntar (igual à extensão: MAX_ACTIONS). */
const MAX_ACTIONS = 25;

// ---------- O parceiro ----------

// SIM_PERSONA=minimo: o parceiro que só usa o WhatsApp e deixa o resto no padrão ou para depois.
const MINIMAL = process.env.SIM_PERSONA === "minimo";
const FACTS = MINIMAL
  ? {
      systems: "Só uso o WhatsApp.",
      hours: "Deixa no padrão.",
      personality: "Pode ser o padrão.",
      link: "Deixo para depois.",
      staff: "Deixo para depois.",
    }
  : {
      systems: "Uso WhatsApp, iFood e Cardápio Web. Instagram não uso.",
      hours: "Segunda a sexta das 11:00 às 23:00; sábado e domingo das 11:00 às 00:00.",
      personality: "Descontraído.",
      link: "O link do meu cardápio é https://avelino.cardapioweb.com",
      staff: "Maria Souza, maria@avelino.com.br, atendimento.",
    };

// ---------- O mundo ----------

type Tab = { url: string; modal?: string; sub?: string; form: Record<string, string>; message?: string };
type Def = {
  role: string;
  name: string;
  value?: string;
  sensitive?: "password" | "code" | "card";
  options?: string[];
  click?: () => void;
  fill?: (value: string) => void;
};
type Rendered = { snapshot: PageSnapshot; defs: Map<number, Def> };

function newWorld() {
  return {
    connected: { WHATSAPP: false, INSTAGRAM: false, IFOOD: false, CARDAPIO_WEB: false },
    logged: { ifood: false, cw: false },
    ifood: { linkCode: "FPTL-SJKD", authCode: "LHQX-ZZZZ", authorized: false },
    cw: { key: "CWK-9F3A-77B1", generated: false },
    hours: false,
    personality: false,
    links: false,
    members: 1,
    firstMessage: false,
    marks: {} as Partial<Record<OnboardingStep, OnboardingMark>>,
  };
}

const SETTINGS_TABS: [string, string][] = [
  ["Links de pedido", "/configuracoes"],
  ["Mensagens automáticas", "/configuracoes/mensagens"],
  ["Horário", "/configuracoes/horario"],
  ["Respostas rápidas", "/configuracoes/respostas-rapidas"],
  ["Notificações", "/configuracoes/notificacoes"],
  ["Integrações", "/configuracoes/integracoes"],
  ["Usuários", "/configuracoes/usuarios"],
  ["Pagamento", "/configuracoes/pagamento"],
];
const SYSTEMS: [keyof ReturnType<typeof newWorld>["connected"], string][] = [
  ["WHATSAPP", "WhatsApp"],
  ["INSTAGRAM", "Instagram"],
  ["IFOOD", "iFood"],
  ["CARDAPIO_WEB", "Cardápio Web"],
];

class Simulation {
  w = newWorld();
  tabs: Tab[] = [{ url: `${PANEL}/inbox`, form: {} }];
  active = 0;
  last: Rendered | null = null;

  get tab(): Tab {
    return this.tabs[this.active]!;
  }

  progress(): OnboardingDto {
    const { w } = this;
    const marked = (step: OnboardingStep) => w.marks[step];
    const steps = ONBOARDING_STEPS.map((step) => {
      const done: Record<OnboardingStep, boolean> = {
        whatsapp: w.connected.WHATSAPP,
        instagram: w.connected.INSTAGRAM,
        ifood: w.connected.IFOOD,
        cardapio_web: w.connected.CARDAPIO_WEB,
        business_hours: w.hours,
        personality: w.personality,
        order_links: w.links,
        members: w.members > 1,
        first_message: w.firstMessage,
      };
      const mark = marked(step);
      const status = done[step] || (mark === "confirmed" && step !== "first_message")
        ? ("done" as const)
        : mark === "skipped"
          ? ("skipped" as const)
          : mark === "in_progress"
            ? ("in_progress" as const)
            : ("todo" as const);
      return { step, status, detail: null };
    });
    return {
      tenantId: "sim",
      steps,
      firstMessage: null,
      completed: steps.every((item) => item.status !== "todo"),
      autoOpen: false,
    };
  }

  load(tab: Tab, href: string) {
    const url = new URL(href, tab.url);
    tab.url = url.origin + url.pathname;
    tab.sub = undefined;
    tab.form = {};
    tab.message = undefined;
    const shortcut = url.searchParams.get("conectar") ?? url.searchParams.get("gerenciar");
    tab.modal = shortcut && SYSTEMS.some(([type]) => type === shortcut) ? shortcut : undefined;
  }

  openTab(url: string) {
    this.tabs.push({ url, form: {} });
    this.active = this.tabs.length - 1;
  }

  /** O parceiro entrou com usuário e senha nos portais que estão abertos. */
  userLogsIn() {
    for (const tab of this.tabs) {
      const host = new URL(tab.url).hostname;
      if (host.endsWith("ifood.com.br")) this.w.logged.ifood = true;
      if (host.endsWith("cardapioweb.com")) this.w.logged.cw = true;
    }
  }

  render(): Rendered {
    const tab = this.tab;
    const host = new URL(tab.url).hostname;
    const path = new URL(tab.url).pathname;
    const defs = new Map<number, Def>();
    const text: string[] = [];
    let ref = 0;
    const add = (def: Def) => defs.set(++ref, def);
    const field = (name: string, extra: Partial<Def> = {}) =>
      add({ role: "campo", name, value: tab.form[name], fill: (value) => (tab.form[name] = value), ...extra });
    let title = host;

    if (host.endsWith("dishdesk.com.br")) {
      title = "Dish Desk";
      this.renderDishDesk(tab, path, text, add, field);
    } else if (host === "portal.ifood.com.br") {
      title = "Portal do Parceiro";
      this.renderIfood(text, add, field);
    } else if (host.endsWith("cardapioweb.com")) {
      title = "Cardápio Web";
      this.renderCardapioWeb(tab, text, add, field);
    } else text.push("Página sem conteúdo.");

    const elements = [...defs.entries()].map(([id, def]) => ({
      ref: id,
      role: def.role,
      name: def.name,
      ...(def.value ? { value: def.value } : {}),
      ...(def.sensitive ? { sensitive: def.sensitive } : {}),
      ...(def.options ? { options: def.options } : {}),
    }));
    const rendered = { snapshot: { url: tab.url, title, elements, text: text.join(" ").slice(0, 6000) }, defs };
    this.last = rendered;
    return rendered;
  }

  private renderDishDesk(tab: Tab, path: string, text: string[], add: (def: Def) => void, field: (name: string, extra?: Partial<Def>) => void) {
    const { w } = this;
    const go = (href: string) => () => this.load(tab, href);
    add({ role: "link", name: "Inbox", click: go("/inbox") });
    add({ role: "link", name: "Clientes", click: go("/clientes") });
    add({ role: "link", name: "Configurações", click: go("/configuracoes") });
    if (!path.startsWith("/configuracoes")) {
      text.push("Inbox. Nenhuma conversa ainda. Clientes. Configurações.");
      return;
    }
    for (const [label, href] of SETTINGS_TABS) add({ role: "link", name: label, click: go(href) });
    text.push("Configurações. Danilo Lanches. " + SETTINGS_TABS.map(([label]) => label).join(" "));
    if (tab.message) text.push(tab.message);

    if (path === "/configuracoes/integracoes") {
      text.push("Integrações. Conecte canais de atendimento e marketplaces ao Dish Desk.");
      add({ role: "botão", name: "Adicionar integração" });
      for (const [type, label] of SYSTEMS) {
        const verb = w.connected[type] ? "Gerenciar" : "Conectar";
        text.push(`${label} ${w.connected[type] ? "Conectado" : "Não conectado"}.`);
        add({ role: "botão", name: `${verb} ${label}`, click: () => (tab.modal = type) });
      }
      this.renderModal(tab, text, add, field);
    } else if (path === "/configuracoes/horario") {
      text.push("Horário de funcionamento. Mensagem fora do horário.");
      for (const name of ["Segunda a sexta · Abre", "Segunda a sexta · Fecha", "Sábado e domingo · Abre", "Sábado e domingo · Fecha"]) field(name);
      field("Mensagem fora do horário");
      add({
        role: "botão",
        name: "Salvar horário",
        click: () => {
          if (tab.form["Segunda a sexta · Abre"] && tab.form["Segunda a sexta · Fecha"]) {
            w.hours = true;
            tab.message = "Horário salvo.";
          } else tab.message = "Confira os horários.";
        },
      });
    } else if (path === "/configuracoes/mensagens") {
      text.push("Mensagens automáticas. Personalidade do atendimento.");
      const options = ["Cordial", "Formal", "Jovial", "Descontraído", "Acolhedor", "Direto"];
      field("Personalidade do atendimento", { role: "lista", options });
      add({
        role: "botão",
        name: "Salvar mensagens",
        click: () => {
          if (options.includes(tab.form["Personalidade do atendimento"] ?? "")) {
            w.personality = true;
            tab.message = "Mensagens salvas.";
          }
        },
      });
    } else if (path === "/configuracoes") {
      text.push("Links de pedido. Onde os clientes fazem pedido.");
      field("Link do cardápio digital");
      field("Link do iFood");
      add({
        role: "botão",
        name: "Salvar links",
        click: () => {
          if (tab.form["Link do cardápio digital"]?.startsWith("http")) {
            w.links = true;
            tab.message = "Links salvos.";
          }
        },
      });
    } else if (path === "/configuracoes/usuarios") {
      text.push(`Usuários. ${w.members} usuário(s).`);
      add({ role: "botão", name: "Novo usuário", click: () => (tab.modal = "USER") });
      if (tab.modal === "USER") {
        text.push("Novo usuário. Senha temporária em branco: convite por e-mail.");
        field("Nome");
        field("E-mail");
        field("Senha temporária", { sensitive: "password" });
        field("Perfil", { role: "lista", options: ["Atendimento", "Admin"] });
        add({
          role: "botão",
          name: "Criar usuário",
          click: () => {
            if (tab.form["Nome"] && tab.form["E-mail"]?.includes("@")) {
              w.members += 1;
              tab.modal = undefined;
            }
          },
        });
        add({ role: "botão", name: "Cancelar", click: () => (tab.modal = undefined) });
      }
    } else text.push("Esta tela não faz parte da implantação.");
  }

  private renderModal(tab: Tab, text: string[], add: (def: Def) => void, field: (name: string, extra?: Partial<Def>) => void) {
    const { w } = this;
    const close = () => (tab.modal = undefined);
    const connect = (type: keyof typeof w.connected, valid: boolean, error: string) => () => {
      if (valid) {
        w.connected[type] = true;
        close();
      } else tab.message = error;
    };
    if (tab.modal === "WHATSAPP") {
      text.push("WhatsApp. Nova integração. Escaneie o QR Code com o celular: WhatsApp → Aparelhos conectados → Conectar um aparelho. Aguardando a conexão.");
    } else if (tab.modal === "INSTAGRAM") {
      text.push("Instagram. Nova integração. A conta precisa ser profissional.");
      add({ role: "botão", name: "Entrar com o Instagram" });
    } else if (tab.modal === "IFOOD") {
      text.push(
        `iFood. Nova integração. Abra o Portal do Parceiro com o login do responsável pela loja e confira este código. Clique em Autorizar e copie o código de autorização para o campo abaixo. ${w.ifood.linkCode} O código vale por 10 minutos.`,
      );
      add({ role: "link", name: "Abrir o Portal do Parceiro", click: () => this.openTab("https://portal.ifood.com.br/") });
      field("Código de autorização");
      field("Nome (opcional)");
      add({ role: "botão", name: "Conectar", click: connect("IFOOD", tab.form["Código de autorização"]?.toUpperCase() === w.ifood.authCode, "Código de autorização inválido.") });
    } else if (tab.modal === "CARDAPIO_WEB") {
      text.push("Cardápio Web. Nova integração. No Portal do Cardápio Web, em Configurações → Integrações → API, gere a chave e cole no campo abaixo.");
      field("Chave da API");
      field("Nome (opcional)");
      add({ role: "botão", name: "Conectar", click: connect("CARDAPIO_WEB", tab.form["Chave da API"] === w.cw.key, "Chave inválida.") });
    } else return;
    add({ role: "botão", name: "Cancelar", click: close });
  }

  private renderIfood(text: string[], add: (def: Def) => void, field: (name: string, extra?: Partial<Def>) => void) {
    const { w } = this;
    if (!w.logged.ifood) {
      text.push("Entrar no Portal do Parceiro iFood.");
      field("E-mail");
      field("Senha", { sensitive: "password" });
      add({ role: "botão", name: "Entrar" });
      return;
    }
    text.push(`Portal do Parceiro. O aplicativo Dish Desk pede acesso à sua loja. Código de vinculação: ${w.ifood.linkCode}. Confira o código e clique em Autorizar.`);
    if (w.ifood.authorized) text.push(`Autorizado. Código de autorização: ${w.ifood.authCode}. Copie para o Dish Desk.`);
    else add({ role: "botão", name: "Autorizar", click: () => (w.ifood.authorized = true) });
  }

  private renderCardapioWeb(tab: Tab, text: string[], add: (def: Def) => void, field: (name: string, extra?: Partial<Def>) => void) {
    const { w } = this;
    if (!w.logged.cw) {
      text.push("Cardápio Web. Cardápio digital para restaurantes.");
      field("E-mail");
      field("Senha", { sensitive: "password" });
      add({ role: "botão", name: "Entrar" });
      return;
    }
    const sub = tab.sub ?? "home";
    const go = (to: string) => () => (tab.sub = to);
    text.push("Painel Cardápio Web.");
    add({ role: "link", name: "Painel", click: go("home") });
    add({ role: "link", name: "Configurações", click: go("config") });
    if (sub === "config") {
      text.push("Configurações da loja.");
      add({ role: "link", name: "Integrações", click: go("integrations") });
    } else if (sub === "integrations") {
      text.push("Integrações. API. Gere a chave para integrar o seu sistema.");
      add({ role: "link", name: "API", click: go("api") });
    } else if (sub === "api") {
      text.push("API. Chave de acesso.");
      if (w.cw.generated) text.push(`Chave da API: ${w.cw.key}`);
      else add({ role: "botão", name: "Gerar chave", click: () => (w.cw.generated = true) });
    }
  }

  execute(action: AgentPageAction): { ok: boolean; error?: string } {
    if (action.type === "switch") {
      const found = this.tabs.findLastIndex((tab) => new URL(tab.url).hostname.endsWith(action.host));
      if (found === -1) return { ok: false, error: `Não há aba aberta em ${action.host}.` };
      this.active = found;
      return { ok: true };
    }
    if (action.type === "navigate") {
      if (action.newTab) this.openTab(action.url);
      else this.load(this.tab, action.url);
      return { ok: true };
    }
    const def = this.last?.defs.get(action.ref);
    if (!def) return { ok: false, error: `Elemento ${action.ref} não encontrado.` };
    if (action.type === "click") def.click?.();
    else if (def.fill) def.fill(action.value);
    return { ok: true };
  }
}

// ---------- A simulação ----------

type EventRow = DecideContext["events"][number];
const row = (kind: string, content: Record<string, unknown>): EventRow => ({ kind, content: content as EventRow["content"] });

/** Responde como o parceiro; devolve o texto e se foi uma ação à toa (o parceiro já tinha dito ou a IA perguntou o que não precisava). */
function partnerReply(say: string, sim: Simulation, told: Set<string>): { text: string; wasted: boolean } {
  const lower = say.toLowerCase();
  const wants = (pattern: RegExp) => pattern.test(lower);
  const asks: [string, RegExp][] = [
    ["systems", /usa|usam|trabalha|integra|quais|sistemas/],
    ["hours", /hor[áa]rio|abre|fecha|funcionamento/],
    ["personality", /personalidade|tom |estilo/],
    ["link", /link|card[áa]pio/],
    ["staff", /atendente|e-mail|equipe|usu[áa]rio/],
  ];
  const wanted = asks.filter(([, pattern]) => wants(pattern)).map(([key]) => key as keyof typeof FACTS);
  if (wants(/qr code|escane|aparelhos conectados/) && sim.tab.modal === "WHATSAPP") {
    sim.w.connected.WHATSAPP = true;
    return { text: "Pronto, escaneei o QR Code.", wasted: false };
  }
  if (wants(/mensagem de teste|outro celular/)) {
    sim.w.firstMessage = true;
    return { text: "Mandei a mensagem de teste.", wasted: false };
  }
  if (wants(/pronto|entr(e|ar)|login|senha/) && sim.tabs.length > 1) {
    sim.userLogsIn();
    return { text: "Pronto, entrei.", wasted: false };
  }
  if (wanted.length >= 2) {
    const all = wanted.map((key) => FACTS[key]).join(" ");
    wanted.forEach((key) => told.add(key));
    return { text: all, wasted: false };
  }
  if (wanted.length === 1) {
    const key = wanted[0]!;
    const repeated = told.has(key);
    told.add(key);
    return { text: repeated ? `Já falei: ${FACTS[key]}` : FACTS[key], wasted: repeated };
  }
  return { text: "Não sei, faça o que achar melhor.", wasted: true };
}

describe.skipIf(!process.env.SIM_AGENT)("simulação: implantação do zero", () => {
  it("implanta o Dish Desk com o mínimo de ações do parceiro", { timeout: 60 * 60_000 }, async () => {
    const env = {
      AI_BASE_URL: process.env.AI_BASE_URL ?? "http://localhost:11434/v1",
      AI_MODEL: process.env.AI_MODEL ?? "gemma4:12b",
      AI_API_KEY: process.env.AI_API_KEY,
      AI_TIMEOUT_MS: 180_000,
      WEB_ORIGIN: PANEL,
    } as unknown as Env;
    const service = new AgentService(null as never, new LlmClient(env), env);
    const sim = new Simulation();
    const granted: string[] = [];
    const told = new Set<string>();
    const log = (line: string) => process.stdout.write(`${line}\n`);

    const user = { messages: 0, pronto: 0, confirms: 0, permissions: 0, wasted: 0 };
    // O registro inteiro da sessão; a IA relê só os 12 últimos (como na API) e o resto chega por `extrasOf`.
    const all: EventRow[] = [];
    let failures = 0;
    let turns = 0;
    let acts = 0;
    let ai = 0;
    let outcome = "limite de voltas";

    let input: { message?: string; result?: { ok: boolean; error?: string }; confirmed?: boolean; granted?: string } = {
      message: "Quero configurar o Dish Desk no meu restaurante.",
    };
    user.messages++;
    log(`PARCEIRO: ${input.message}`);

    while (turns++ < MAX_TURNS) {
      const { snapshot } = sim.render();
      const seen = { seen: snapshot.text.slice(0, 2000) };
      if (input.message) all.push(row("partner", { text: input.message, ...seen }));
      if (input.result) {
        const summary = input.result.ok ? "a ação deu certo." : `a ação falhou: ${input.result.error}.`;
        all.push(row("result", { summary, ...(!input.message && seen) }));
      }
      if (input.confirmed === false) all.push(row("result", { summary: "o parceiro não confirmou a ação; ela não foi feita." }));
      if (input.granted) all.push(row("result", { summary: `o parceiro permitiu agir em ${input.granted}.` }));
      failures = input.message || input.result?.ok ? 0 : input.result ? failures + 1 : failures;
      if (failures >= MAX_FAILURES) {
        outcome = "a IA se perdeu (3 falhas seguidas)";
        break;
      }

      const context: DecideContext = {
        session: { id: "sim", kind: "SETUP" },
        restaurant: "Danilo Lanches",
        events: all.slice(-12),
        progress: sim.progress(),
        ...extrasOf(all),
      };
      const allowed = [...AGENT_HOSTS, new URL(PANEL).hostname, ...granted];
      const started = Date.now();
      const decided = await service.decideWithMarks(context, snapshot, allowed, {
        mark: async (step, mark, summary, said) => {
          sim.w.marks[step] = mark;
          log(`  [marcou ${step} = ${mark}${said ? " (decisão da IA)" : ""}]`);
          if (said) all.push(row("agent", said));
          all.push(row("result", summary));
          return sim.progress();
        },
        intakeDone: async () => {
          all.push(row("result", { intake: true }));
        },
      });
      ai++;
      const next: AgentAction = decided.next;
      all.push(row("agent", { next }));
      log(`IA (${((Date.now() - started) / 1000).toFixed(0)}s, ${new URL(snapshot.url).host}${new URL(snapshot.url).pathname}): [${next.type}] ${next.say}${"action" in next ? ` -> ${JSON.stringify(next.action)}` : ""}`);

      if (next.type === "act" || next.type === "confirm") {
        if (next.type === "confirm") {
          user.confirms++;
          log("PARCEIRO: [clicou em Confirmar]");
        } else if (++acts >= MAX_ACTIONS) {
          user.messages++;
          acts = 0;
          input = { message: "Pode continuar." };
          log("PARCEIRO: Pode continuar. (a IA parou por excesso de ações seguidas)");
          continue;
        }
        const result = sim.execute(next.action);
        input = next.type === "confirm" ? { confirmed: true, result } : { result };
      } else if (next.type === "login") {
        acts = 0;
        user.pronto++;
        sim.execute({ type: "navigate", url: next.url, newTab: true });
        sim.userLogsIn();
        log("PARCEIRO: [entrou no portal e clicou em Pronto]");
        input = { message: "Pronto, terminei." };
      } else if (next.type === "your_turn") {
        acts = 0;
        user.pronto++;
        sim.userLogsIn();
        log("PARCEIRO: [digitou os dados e clicou em Pronto]");
        input = { message: "Pronto, terminei." };
      } else if (next.type === "permission") {
        user.permissions++;
        granted.push(next.host);
        log(`PARCEIRO: [permitiu ${next.host}]`);
        input = { granted: next.host };
      } else if (next.type === "reply" || (next.type === "done" && !sim.progress().completed)) {
        acts = 0;
        const reply = partnerReply(next.say, sim, told);
        user.messages++;
        if (reply.wasted) user.wasted++;
        log(`PARCEIRO${reply.wasted ? " (ação à toa)" : ""}: ${reply.text}`);
        input = { message: reply.text };
      } else if (next.type === "done" && sim.progress().completed) {
        outcome = "concluída";
        break;
      } else {
        outcome = `parou em ${next.type}`;
        break;
      }
    }

    const progress = sim.progress();
    const total = user.messages + user.pronto + user.confirms + user.permissions;
    log("\n===== RESULTADO =====");
    log(`Desfecho: ${outcome}`);
    log(`Voltas da IA: ${ai}`);
    log(`Ações do parceiro: ${total} (mensagens ${user.messages}, Pronto ${user.pronto}, confirmações ${user.confirms}, permissões ${user.permissions}); à toa: ${user.wasted}`);
    log(progress.steps.map((item) => `${item.step}=${item.status}`).join(" "));
  });
});
