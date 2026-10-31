import type { AgentPageAction, PageSnapshot } from "@dishdesk/shared";

const TAG = "agent-bridge";
/** Ler a página é rápido; uma ação espera a página carregar (até 15 s, na extensão). */
const TIMEOUT_MS = { default: 5_000, act: 20_000, permission: 60_000 } as const;

/** O que o agente pede à extensão (apps/extension/panel.js): ler a aba, agir nela, pôr o foco num campo, pedir um site. */
export type AgentBridge = {
  snapshot(): Promise<PageSnapshot>;
  act(action: AgentPageAction): Promise<void>;
  focus(ref: number): Promise<void>;
  permission(host: string): Promise<boolean>;
};

let sequence = 0;

/**
 * IDs da extensão do Dish Desk (NEXT_PUBLIC_EXTENSION_IDS, separados por vírgula). Sem a variável, só em
 * desenvolvimento vale qualquer extensão (a carregada sem compactar muda de ID a cada pasta).
 */
const EXTENSION_IDS = (process.env.NEXT_PUBLIC_EXTENSION_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);

function isDishDeskExtension(origin: string): boolean {
  if (!origin.startsWith("chrome-extension://")) return false;
  if (!EXTENSION_IDS.length) return process.env.NODE_ENV !== "production";
  return EXTENSION_IDS.some((id) => origin === `chrome-extension://${id}`);
}

/**
 * O painel lateral da extensão, onde esta página roda num iframe; null fora dele (ex.: a página aberta numa aba). Só o
 * painel da extensão do Dish Desk recebe a página e as ações: outra extensão que abra esta página não.
 */
export function extensionPanel(): { target: Window; origin: string } | null {
  if (typeof window === "undefined" || window.parent === window) return null;
  const origin = window.location.ancestorOrigins?.[0];
  return origin && isDishDeskExtension(origin) ? { target: window.parent, origin } : null;
}

function call<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const panel = extensionPanel();
    if (!panel) return reject(new Error("Abra o assistente pelo ícone da extensão do Dish Desk."));
    const id = ++sequence;
    function onMessage(event: MessageEvent<{ dishdesk?: string; id?: number; ok?: boolean; error?: string } & T>) {
      if (event.origin !== panel!.origin || event.data?.dishdesk !== TAG || event.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.error));
    }
    const timer = setTimeout(
      () => {
        window.removeEventListener("message", onMessage);
        reject(new Error("A extensão do Dish Desk não respondeu."));
      },
      TIMEOUT_MS[op as keyof typeof TIMEOUT_MS] ?? TIMEOUT_MS.default,
    );
    window.addEventListener("message", onMessage);
    panel.target.postMessage({ dishdesk: TAG, id, op, ...params }, panel.origin);
  });
}

/**
 * O indicador na aba (board da extensão): a faixa no topo (controlando, pausado ou esperando o parceiro; `off` tira) e o
 * contorno no elemento (`ref`): a IA clicando ou preenchendo, ou o campo que é a vez do parceiro. Numa página que a
 * extensão não lê, não aparece nada.
 */
export type AgentIndicator = {
  state: "controlling" | "paused" | "waiting" | "off";
  ref?: number;
  mark?: "your_turn";
};

export function indicate(indicator: AgentIndicator): void {
  call("indicate", { indicator }).catch(() => undefined);
}

/**
 * O que o parceiro fez na aba: começou a usar a página enquanto a IA agia (`user-input`) ou clicou em Pausar/Continuar
 * na faixa. Devolve a função que para de ouvir.
 */
export function onPageEvent(handler: (event: "user-input" | "pause" | "resume") => void): () => void {
  const panel = extensionPanel();
  if (!panel) return () => undefined;
  const listener = (event: MessageEvent<{ dishdesk?: string; event?: string }>) => {
    if (event.origin !== panel.origin || event.data?.dishdesk !== TAG) return;
    const name = event.data.event;
    if (name === "user-input" || name === "pause" || name === "resume") handler(name);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

export const agentBridge: AgentBridge = {
  snapshot: async () => (await call<{ page: PageSnapshot }>("snapshot")).page,
  act: async (action) => void (await call("act", { action })),
  focus: async (ref) => void (await call("focus", { ref })),
  permission: async (host) => (await call<{ granted: boolean }>("permission", { host })).granted,
};
