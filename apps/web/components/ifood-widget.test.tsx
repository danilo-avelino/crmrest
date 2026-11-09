import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IfoodWidget } from "./ifood-widget";

const widget = { widgetId: "widget-1", merchantIds: ["loja-1"], chat: false, extensionUrl: null };
vi.mock("@/components/auth/auth-provider", () => ({
  useAuth: () => ({ session: { accessToken: "token" }, request: async () => widget }),
}));
vi.mock("@/hooks/use-ifood-chat", () => ({ useIfoodChat: () => "idle" }));
// O next/script vira um marcador: o teste vê se o script do iFood entrou na página.
vi.mock("next/script", () => ({ default: ({ src }: { src: string }) => <i data-testid="script" data-src={src} /> }));

const QUESTION = "Usar o widget do iFood neste computador?";

async function show() {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <IfoodWidget />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(client.getQueryState(["ifood-widget"])?.status).toBe("success"));
}

describe("pergunta do widget do iFood", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(cleanup);

  it("pergunta antes de carregar o widget; Sim carrega e não pergunta mais", async () => {
    await show();
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(screen.queryByTestId("script")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sim, usar o widget" }));
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.getByTestId("script").dataset.src).toBe("https://widgets.ifood.com.br/widget.js");

    cleanup();
    await show();
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.getByTestId("script")).toBeTruthy();
  });

  it("Não: não carrega e volta a perguntar só numa sessão nova", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Não" }));
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.queryByTestId("script")).toBeNull();

    cleanup();
    await show();
    expect(screen.queryByText(QUESTION)).toBeNull();

    cleanup();
    sessionStorage.clear(); // aba nova
    await show();
    expect(screen.getByText(QUESTION)).toBeTruthy();
  });

  it("Não com \"Não perguntar de novo\": nunca mais pergunta neste computador; o Sim fica bloqueado com a caixa marcada", async () => {
    await show();
    fireEvent.click(screen.getByLabelText("Não perguntar de novo neste computador"));
    expect((screen.getByRole("button", { name: "Sim, usar o widget" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Não" }));

    cleanup();
    sessionStorage.clear();
    await show();
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.queryByTestId("script")).toBeNull();
  });
});
