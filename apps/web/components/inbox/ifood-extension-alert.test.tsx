import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IfoodExtensionAlert, IfoodWidgetAlert } from "./ifood-extension-alert";

const STORE_URL = "https://chromewebstore.google.com/detail/dish-desk/teste";
const state = { missing: true, extensionUrl: STORE_URL as string | null };
const chat = { status: "connected", invite: null, revealed: false };
const reconnect = vi.fn(async () => undefined);
vi.mock("@/hooks/use-ifood-chat", () => ({
  useIfoodExtensionMissing: () => state.missing,
  useIfoodChatState: () => chat,
  reconnectIfoodChat: () => reconnect(),
}));
vi.mock("@/components/ifood-widget", () => ({ useIfoodWidget: () => ({ data: { extensionUrl: state.extensionUrl } }) }));

describe("aviso da extensão do iFood", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.assign(state, { missing: true, extensionUrl: STORE_URL });
  });

  it("não aparece com a extensão instalada", () => {
    state.missing = false;
    render(<IfoodExtensionAlert />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Instalar abre a página da extensão e passa a oferecer o Recarregar", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<IfoodExtensionAlert />);
    expect(screen.getByRole("status").textContent).toContain("falta a extensão do Dish Desk no Chrome");
    expect(screen.queryByRole("button", { name: "Recarregar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Instalar" }));
    expect(open).toHaveBeenCalledWith(STORE_URL, "_blank", "noopener");
    expect(screen.getByRole("status").textContent).toContain("recarregue a página");
    expect(screen.getByRole("button", { name: "Recarregar" })).toBeTruthy();
  });

  it("sem o endereço da loja, avisa sem o botão", () => {
    state.extensionUrl = null;
    render(<IfoodExtensionAlert />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("aviso do widget do iFood desconectado", () => {
  afterEach(() => {
    cleanup();
    reconnect.mockClear();
    Object.assign(chat, { status: "connected", revealed: false });
  });

  it("não aparece com o widget conectado", () => {
    render(<IfoodWidgetAlert />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("desconectado: avisa e Reconectar chama a reconexão", () => {
    chat.status = "unauthorized";
    render(<IfoodWidgetAlert />);
    expect(screen.getByRole("status").textContent).toContain("widget do iFood desconectou");
    fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("com o convite à mostra, diz onde clicar, sem o botão", () => {
    Object.assign(chat, { status: "unauthorized", revealed: true });
    render(<IfoodWidgetAlert />);
    expect(screen.getByRole("status").textContent).toContain("Ir para o portal do parceiro");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
