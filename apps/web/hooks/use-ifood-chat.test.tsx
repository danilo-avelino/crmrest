import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectIfoodChat, useIfoodChat, useIfoodChatState, useIfoodExtensionMissing } from "./use-ifood-chat";

vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ request: vi.fn().mockRejectedValue(new Error("sem API")) }) }));

const WIDGET_ORIGIN = "https://embeddables.ifood.com.br";

/**
 * Põe o iframe do widget na página. Com `version`, a extensão responde: ao ping, à leitura (com o HTML de `page`) e aos
 * cliques; sem ela, ninguém responde.
 */
function widget(version?: string, page: () => string = () => "") {
  const iframe = document.createElement("iframe");
  iframe.src = `${WIDGET_ORIGIN}/widget`;
  document.body.append(iframe);
  return vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((message: { id: number; op: string }) => {
    if (!version) return;
    const reply = message.op === "ping" ? { version } : message.op === "html" ? { html: [page()] } : {};
    window.dispatchEvent(new MessageEvent("message", { origin: WIDGET_ORIGIN, data: { dishdesk: "ifood-bridge", id: message.id, ok: true, ...reply } }));
  });
}

function setup() {
  const { result } = renderHook(() => {
    useIfoodChat(true);
    return useIfoodExtensionMissing();
  });
  return () => result.current;
}

const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("falta da extensão do iFood", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("avisa quando o widget está na página e a extensão não responde duas vezes seguidas", async () => {
    widget();
    const missing = setup();
    await pass(4_500); // o primeiro ping venceu: pode ser o widget ainda carregando
    expect(missing()).toBe(false);
    await pass(7_000);
    expect(missing()).toBe(true);
  });

  it("não avisa enquanto o widget não carregou", async () => {
    const missing = setup();
    await pass(60_000);
    expect(missing()).toBe(false);
  });

  it("não avisa com a extensão respondendo", async () => {
    widget("0.3.0");
    const missing = setup();
    await pass(60_000);
    expect(missing()).toBe(false);
  });
});

describe("autorização da loja no widget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("o convite some depois da autorização pelo código (sem \"autorização em andamento\"): o motor volta sozinho", async () => {
    let page = "<div><p>Para ver as conversas, autorize o widget no Portal do Parceiro.</p></div>";
    widget("0.3.0", () => page);
    const { result } = renderHook(() => useIfoodChat(true));
    await pass(4_000);
    expect(result.current).toBe("unauthorized");

    // Autorizado no Portal: o widget volta com as abas.
    page = '<div><button id="HOME">Home</button><button id="CHAT">Chat</button><div class="chats-tabs"></div></div>';
    await pass(4_000);
    expect(result.current).toBe("idle");
    await pass(61_000);
    expect(result.current).toBe("driving");
  });
});

describe("situação do chat do iFood", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const INVITE =
    '<div><p>Ops! Você precisa autorizar o widget</p><a href="https://portal.ifood.com.br/apps/code?c=ABCD-EFGH" target="_blank"><button>Ir para o Portal do Parceiro</button></a><button>Já tenho o código</button></div>';
  const PANEL = '<div><button id="HOME">Home</button><button id="CHAT">Chat</button><div class="chats-tabs"></div></div>';

  function setupState() {
    const { result } = renderHook(() => {
      useIfoodChat(true);
      return useIfoodChatState();
    });
    return () => result.current;
  }

  it("conectado quando o widget mostra as abas", async () => {
    widget("0.3.0", () => PANEL);
    const state = setupState();
    await pass(4_000);
    expect(state().status).toBe("connected");
  });

  it("desconectado com o convite: Conectar abre o Portal pelo painel e passa o widget para a espera da autorização", async () => {
    let page = INVITE;
    const postMessage = widget("0.3.0", () => page);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const state = setupState();
    await pass(4_000);
    expect(state()).toEqual({ status: "unauthorized", invite: { url: "https://portal.ifood.com.br/apps/code?c=ABCD-EFGH", skip: 1 } });

    await act(() => connectIfoodChat());
    expect(open).toHaveBeenCalledWith("https://portal.ifood.com.br/apps/code?c=ABCD-EFGH", "_blank", "noopener");
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ op: "click", selector: "button", index: 1 }), WIDGET_ORIGIN);

    page = "<div><span>Autorização em andamento</span><span>Não feche esta janela.</span></div>";
    await pass(3_500);
    expect(state()).toEqual({ status: "authorizing", invite: null });
  });

  it("desligado quando o motor para", async () => {
    widget("0.3.0", () => PANEL);
    const { result, rerender } = renderHook(({ enabled }) => {
      useIfoodChat(enabled);
      return useIfoodChatState();
    }, { initialProps: { enabled: true } });
    await pass(4_000);
    expect(result.current.status).toBe("connected");
    rerender({ enabled: false });
    expect(result.current.status).toBe("off");
  });
});
