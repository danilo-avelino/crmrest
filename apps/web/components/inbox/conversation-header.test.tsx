import type { ConversationListItem } from "@dishdesk/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHeader } from "./conversation-pane";

const request = vi.fn();
vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ request, session: null }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => vi.fn() }));

const conversation = {
  id: "conversa-1",
  status: "OPEN",
  teamOnly: false,
  createdAt: new Date().toISOString(),
  orderCode: null,
  assignedUser: null,
  tenant: { id: "loja-1", name: "Loja" },
  contact: { id: "cliente-1", name: "Carla Dias" },
  channel: { type: "WHATSAPP" },
} as unknown as ConversationListItem;

function show(unanswered: boolean, onResolved = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationHeader conversation={conversation} unanswered={unanswered} onResolved={onResolved} nextConversationId={() => "conversa-2"} />
    </QueryClientProvider>,
  );
  return onResolved;
}
const resolves = () => request.mock.calls.filter(([path, init]) => path === "/conversations/conversa-1" && init?.method === "PATCH");

describe("Resolver com o cliente sem resposta", () => {
  afterEach(() => {
    cleanup();
    request.mockReset();
  });

  it("avisa antes que conta como má conduta; voltar não resolve", async () => {
    request.mockResolvedValue([]);
    show(true);
    fireEvent.click(screen.getByRole("button", { name: "Resolver" }));
    expect(await screen.findByText("O cliente está sem resposta")).toBeTruthy();
    expect(screen.getByText(/Resolver mesmo assim conta como má conduta/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Voltar e responder" }));
    await waitFor(() => expect(screen.queryByText("O cliente está sem resposta")).toBeNull());
    expect(resolves()).toHaveLength(0);
  });

  it("resolver mesmo assim: resolve uma vez só, com Carregando…", async () => {
    let finish: () => void = () => {};
    request.mockImplementation((path: string) =>
      path === "/conversations/conversa-1" ? new Promise<void>((resolve) => (finish = resolve)) : Promise.resolve([]),
    );
    const onResolved = show(true);
    fireEvent.click(screen.getByRole("button", { name: "Resolver" }));
    const confirm = await screen.findByRole("button", { name: "Resolver mesmo assim" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByText("Carregando…")).toBeTruthy();
    finish();
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("conversa-2"));
    expect(resolves()).toHaveLength(1);
    expect(resolves()[0]![1].body).toEqual({ status: "RESOLVED" });
  });

  it("cliente respondido: resolve direto, sem aviso", async () => {
    request.mockResolvedValue([]);
    const onResolved = show(false);
    fireEvent.click(screen.getByRole("button", { name: "Resolver" }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("conversa-2"));
    expect(screen.queryByText("O cliente está sem resposta")).toBeNull();
  });
});
