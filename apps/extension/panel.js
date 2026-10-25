// Painel lateral do agente de implantação e suporte (E31). A tela é uma página do Dish Desk num iframe: ela tem o
// login, conversa com a API e decide cada passo. Este arquivo é a ponte entre ela e a aba que o parceiro está vendo:
// lê a página, executa a ação e devolve o resultado, por postMessage (como a ponte do widget do iFood).

const PANELS = ["https://www.dishdesk.com.br", "http://localhost:3000"];
const TAG = "agent-bridge";
const PAGE_PATH = "/extensao/agente";
/** Depois de um clique ou de abrir um endereço, espera a página carregar (no máximo isto). */
const LOAD_TIMEOUT_MS = 15_000;
/** O contorno "IA clicando" fica na tela este tempo antes da ação, para o parceiro ver onde a IA vai mexer. */
const HIGHLIGHT_MS = 500;

// Em dev, o painel local: chrome.storage.local.set({ dishdeskOrigin: "http://localhost:3000" }) no console da extensão.
chrome.storage.local.get("dishdeskOrigin").then(({ dishdeskOrigin }) => {
  const origin = PANELS.includes(dishdeskOrigin) ? dishdeskOrigin : PANELS[0];
  const frame = document.createElement("iframe");
  frame.src = `${origin}${PAGE_PATH}`;
  frame.allow = "clipboard-write";
  document.body.append(frame);

  window.addEventListener("message", async (event) => {
    const request = event.data;
    if (event.source !== frame.contentWindow || event.origin !== origin || request?.dishdesk !== TAG || !request.op) return;
    const reply = (body) => frame.contentWindow.postMessage({ dishdesk: TAG, id: request.id, ...body }, origin);
    try {
      if (!Object.hasOwn(OPERATIONS, request.op)) throw new Error(`Operação desconhecida: ${request.op}`);
      reply({ ok: true, ...(await OPERATIONS[request.op](request)) });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Da faixa na aba (Pausar, Continuar) e do parceiro mexendo na página enquanto a IA age (agent-page.js).
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!sender.tab || !message?.dishdeskAgent) return;
    frame.contentWindow.postMessage({ dishdesk: TAG, event: message.dishdeskAgent }, origin);
  });
});

/** A aba que o parceiro está vendo, na janela deste painel. */
async function currentTab() {
  const { id: windowId } = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab?.id) throw new Error("Nenhuma aba aberta.");
  return tab;
}

/** Roda uma função do agent-page.js na aba (injetado na primeira vez). Sem permissão para o site, o Chrome recusa. */
async function inPage(tab, name, ...args) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["agent-page.js"] });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (call, params) => window.__dishdeskAgent[call](...params),
    args: [name, args],
  });
  return result?.result;
}

/** Espera a aba terminar de carregar (um clique pode abrir outra página; um clique comum não muda nada). */
async function settled(tabId) {
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 400));
  while (Date.now() - started < LOAD_TIMEOUT_MS) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const OPERATIONS = {
  ping: () => ({ version: chrome.runtime.getManifest().version }),
  snapshot: async () => ({ page: await inPage(await currentTab(), "snapshot") }),
  act: async ({ action }) => {
    const tab = await currentTab();
    if (action.type === "navigate") await chrome.tabs.update(tab.id, { url: action.url });
    else {
      await inPage(tab, "highlight", action.ref, action.type === "click" ? "click" : "fill");
      await new Promise((resolve) => setTimeout(resolve, HIGHLIGHT_MS));
      await inPage(tab, "act", action);
    }
    await settled(tab.id);
    return {};
  },
  focus: async ({ ref }) => {
    await inPage(await currentTab(), "focus", ref);
    return {};
  },
  indicate: async ({ indicator }) => {
    await inPage(await currentTab(), "indicate", indicator);
    return {};
  },
  // Site fora da lista: o Chrome pergunta ao parceiro. Precisa do clique dele (o do iframe vale para este painel).
  permission: async ({ host }) => ({ granted: await chrome.permissions.request({ origins: [`https://${host}/*`] }) }),
};
