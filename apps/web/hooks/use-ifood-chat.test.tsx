import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIfoodChat, useIfoodExtensionMissing } from "./use-ifood-chat";

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
  vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((message: { id: number; op: string }) => {
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
