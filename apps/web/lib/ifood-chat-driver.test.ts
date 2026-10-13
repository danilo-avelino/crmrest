import type { IfoodChatOutboxItem, IfoodChatSendResult, IfoodChatSync } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { CHAT_ITEM, CHAT_TAB, LAUNCHER, readWidget } from "./ifood-chat-dom";
import { type Bridge, IfoodChatDriver } from "./ifood-chat-driver";

type FakeMessage = { side: "store" | "customer" | "center"; text: string; time: string };
type FakeChat = { code: string; customer: string; open: boolean; ended?: boolean; stamp?: string; messages: FakeMessage[] };

const TODAY = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(new Date());

/** Widget do iFood de mentira, com a mesma estrutura de HTML do verdadeiro (classes à parte) e as posições que a extensão anota. */
function fakeWidget(chats: FakeChat[], options: { authorized?: boolean; geometry?: boolean } = {}) {
  const { authorized = true, geometry = true } = options;
  const state = { panel: false, tab: "HOME", drawer: null as string | null, draft: "", modal: false, clicks: [] as string[] };
  const rect = (x: number, width: number) => (geometry ? ` data-dd-rect="${x},0,${width},40"` : "");
  const bubble = (message: FakeMessage) => {
    const x = message.side === "store" ? 700 : message.side === "customer" ? 612 : 620;
    return `<div class="row"><div><div${rect(x, message.side === "center" ? 320 : 250)}><div><span>${message.text}</span></div><div><span>${message.time}</span></div></div></div></div>`;
  };
  const item = (chat: FakeChat) => {
    const last = chat.messages.at(-1);
    return `<div><button><div><span class="ellipse">#${chat.code} - ${chat.customer}</span><span class="ellipse">${last?.text ?? ""}</span><span class="ellipse">Loja Teste</span><span>${chat.stamp ?? `${last?.time.slice(0, 5)} • ${TODAY}`}</span></div></button><button><span class="ifdl-icon-filled ifdl-icon-send-message"></span></button></div>`;
  };
  const list = (open: boolean) => `<div role="tabpanel">${chats.filter((chat) => chat.open === open).map(item).join("") || "<span>Nenhuma conversa por aqui</span>"}</div>`;
  const render = () => {
    const chat = chats.find((candidate) => candidate.code === state.drawer);
    const drawer = chat
      ? `<div data-hit-region="true"${rect(600, 360)}><div><div><span>#${chat.code} - ${chat.customer}</span><button><span class="ifdl-icon-line ifdl-icon-close"></span></button></div>
           <div><div><div>Mensagem automática</div><span>Enviamos uma mensagem automática pro cliente.</span></div>${chat.messages.map(bubble).join("")}</div>
           ${chat.ended ? "<div><span>Conversa encerrada</span></div>" : '<div><textarea placeholder="Digite sua mensagem..."></textarea><button><span class="ifdl-icon-filled ifdl-icon-send-message"></span></button></div>'}</div></div>`
      : "";
    const panel = state.panel
      ? `<div data-hit-region="true"><div><button><span class="ifdl-icon-line ifdl-icon-close"></span></button></div>
           ${state.tab === "CHAT" ? `<div class="chats-tabs">${list(true)}${list(false)}</div>` : "<span>Widget do iFood</span>"}
           <div><button id="HOME"></button><button id="CHAT"></button></div></div>`
      : "";
    const modal = state.modal ? '<div data-hit-region="true"><span>Conheça o widget do iFood!</span><button>Ir para o portal do parceiro</button></div>' : "";
    return `<body><div id="root"><div><div data-column-index="3">${drawer}</div><div data-column-index="2">${panel}<div data-hit-region="true"><button id="embeddables-main-button"></button></div></div></div>${modal}</div></body>`;
  };
  const bridge: Bridge = async (op, params = {}) => {
    const selector = String(params.selector ?? "");
    if (op === "html") return { html: [render()] };
    state.clicks.push(`${op} ${selector}${params.index === undefined ? "" : ` [${String(params.index)}]`}`);
    const open = chats.find((chat) => chat.code === state.drawer);
    if (op === "fill") state.draft = String(params.text);
    else if (selector === LAUNCHER) {
      if (authorized) state.panel = !state.panel;
      else state.modal = true;
    } else if (selector === CHAT_TAB) state.tab = "CHAT";
    else if (selector === CHAT_ITEM) state.drawer = readWidget(render()).chats.find((chat) => chat.index === params.index)!.orderCode;
    else if (selector.includes("ifdl-icon-close")) state.drawer = null;
    else if (selector.includes("ifdl-icon-send") && open) {
      open.messages.push({ side: "store", text: state.draft, time: "12:30:00" });
      state.draft = "";
    } else throw new Error(`Elemento não encontrado: ${selector}`);
    return {};
  };
  return { bridge, state };
}

function fakeApi(found = true) {
  const calls = { synced: [] as IfoodChatSync[], results: [] as [string, IfoodChatSendResult][] };
  const outbox: IfoodChatOutboxItem[] = [];
  return {
    calls,
    outbox,
    api: {
      sync: async (body: IfoodChatSync) => (calls.synced.push(body), { found }),
      claim: async () => outbox.splice(0),
      result: async (messageId: string, body: IfoodChatSendResult) => void calls.results.push([messageId, body]),
    },
  };
}

const order = (messages: FakeMessage[], extra: Partial<FakeChat> = {}): FakeChat => ({ code: "6530", customer: "CARLOS MENDES", open: true, messages, ...extra });
const steps = async (driver: IfoodChatDriver, count: number, claim = false) => {
  let status = "working";
  for (let step = 0; step < count; step++) status = await driver.step(claim);
  return status;
};
const instant = () => Promise.resolve();

describe("motor do chat do iFood", () => {
  it("abre o widget na aba Chat, copia a conversa com o lado de cada mensagem e a deixa fechada", async () => {
    const widget = fakeWidget([order([{ side: "store", text: "Recebemos o seu pedido!", time: "06:55:21" }, { side: "customer", text: "Pode mandar sem cebola?", time: "06:57:01" }])]);
    const { api, calls } = fakeApi();
    await steps(new IfoodChatDriver(widget.bridge, api, instant), 3);

    expect(widget.state).toMatchObject({ panel: true, tab: "CHAT", drawer: null });
    expect(calls.synced).toEqual([
      {
        orderCode: "6530",
        messages: [
          { direction: "OUTBOUND", text: "Recebemos o seu pedido!", time: "06:55:21" },
          { direction: "INBOUND", text: "Pode mandar sem cebola?", time: "06:57:01" },
        ],
      },
    ]);
  });

  it("só abre a conversa de novo quando a lista mostra mensagem nova", async () => {
    const chat = order([{ side: "customer", text: "Olá", time: "10:00:00" }]);
    const widget = fakeWidget([chat]);
    const { api, calls } = fakeApi();
    const driver = new IfoodChatDriver(widget.bridge, api, instant);
    await steps(driver, 6);
    expect(calls.synced).toHaveLength(1);

    chat.messages.push({ side: "customer", text: "Tem alguém aí?", time: "10:05:00" });
    await steps(driver, 2);
    expect(calls.synced).toHaveLength(2);
    expect(calls.synced[1]!.messages.map((message) => message.text)).toEqual(["Olá", "Tem alguém aí?"]);
  });

  it("conversa encerrada de outro dia fica de fora; pedido que o Dish Desk ainda não tem é tentado de novo depois", async () => {
    const widget = fakeWidget([
      order([{ side: "customer", text: "Antiga", time: "20:00:00" }], { code: "1111", open: false, stamp: "20:00 • 01/01" }),
      order([{ side: "customer", text: "Nova", time: "09:00:00" }], { code: "2222" }),
    ]);
    const { api, calls } = fakeApi(false);
    let now = Date.now();
    const driver = new IfoodChatDriver(widget.bridge, api, instant, () => now);
    await steps(driver, 6);
    expect(calls.synced.map((sync) => sync.orderCode)).toEqual(["2222"]);
    now += 31_000;
    await steps(driver, 1);
    expect(calls.synced.map((sync) => sync.orderCode)).toEqual(["2222", "2222"]);
  });

  it("sem saber o lado dos balões (extensão antiga, balão centralizado), não copia a conversa", async () => {
    for (const widget of [
      fakeWidget([order([{ side: "customer", text: "Olá", time: "10:00:00" }])], { geometry: false }),
      fakeWidget([order([{ side: "center", text: "Olá", time: "10:00:00" }])]),
    ]) {
      const { api, calls } = fakeApi();
      await steps(new IfoodChatDriver(widget.bridge, api, instant), 4);
      expect(calls.synced).toEqual([]);
      expect(widget.state.drawer).toBeNull();
    }
  });

  it("resposta da Inbox: digita na conversa do pedido, confirma que apareceu e avisa a API", async () => {
    const chat = order([{ side: "customer", text: "Pode mandar sem cebola?", time: "06:57:01" }]);
    const widget = fakeWidget([chat]);
    const { api, calls, outbox } = fakeApi();
    const driver = new IfoodChatDriver(widget.bridge, api, instant);
    await steps(driver, 3);

    outbox.push({ messageId: "m-1", conversationId: "c-1", orderCode: "6530", text: "Pode sim!" });
    await steps(driver, 1, true);
    expect(chat.messages.at(-1)).toMatchObject({ side: "store", text: "Pode sim!" });
    expect(calls.results).toEqual([["m-1", { status: "SENT" }]]);
    expect(widget.state.drawer).toBeNull();

    // A lista mudou: a conversa é copiada de novo, já com a resposta.
    await steps(driver, 1);
    expect(calls.synced.at(-1)!.messages.at(-1)).toEqual({ direction: "OUTBOUND", text: "Pode sim!", time: "12:30:00" });
  });

  it("resposta para conversa encerrada ou que não está no widget: falha com o motivo", async () => {
    const widget = fakeWidget([order([{ side: "customer", text: "Obrigado", time: "11:00:00" }], { ended: true })]);
    const { api, calls, outbox } = fakeApi();
    const driver = new IfoodChatDriver(widget.bridge, api, instant);
    await steps(driver, 3);
    outbox.push({ messageId: "m-1", conversationId: "c-1", orderCode: "6530", text: "Por nada!" }, { messageId: "m-2", conversationId: "c-2", orderCode: "9999", text: "Olá" });
    await steps(driver, 2, true);
    expect(calls.results).toEqual([
      ["m-1", { status: "FAILED", error: "O iFood já encerrou a conversa deste pedido." }],
      ["m-2", { status: "FAILED", error: "O chat deste pedido não está aberto no widget do iFood." }],
    ]);
  });

  it("loja que não autorizou o widget: para e avisa", async () => {
    const widget = fakeWidget([], { authorized: false });
    const driver = new IfoodChatDriver(widget.bridge, fakeApi().api, instant);
    expect(await steps(driver, 2)).toBe("unauthorized");
    expect(widget.state.clicks).toEqual([`click ${LAUNCHER}`]);
  });
});
