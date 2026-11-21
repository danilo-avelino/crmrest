import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppPhone } from "./whatsapp-phone";

const request = vi.fn();
vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ request }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => vi.fn() }));

function show(onOpen = vi.fn(), client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <WhatsAppPhone contactId="cliente-1" tenantId="loja-1" phone="+5586994478163" onOpen={onOpen} />
    </QueryClientProvider>,
  );
  return onOpen;
}

describe("telefone do cliente", () => {
  afterEach(() => {
    cleanup();
    request.mockReset();
  });

  it("com WhatsApp conectado que atende a loja: o clique abre a conversa, uma vez só", async () => {
    let finish: (value: { conversationId: string }) => void = () => {};
    request.mockImplementation((path: string) =>
      path === "/channels"
        ? Promise.resolve([{ tenantId: "grupo", servedTenantIds: ["loja-1"], type: "WHATSAPP", status: "CONNECTED" }])
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const onOpen = show();
    const button = await screen.findByRole("button", { name: /Conversar pelo WhatsApp/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByText("Carregando…")).toBeTruthy();
    finish({ conversationId: "conversa-9" });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("conversa-9"));
    expect(request.mock.calls.filter(([path]) => path === "/contacts/cliente-1/whatsapp-chat")).toHaveLength(1);
  });

  it("sem WhatsApp conectado na loja do cliente: só o número", async () => {
    request.mockResolvedValue([{ tenantId: "outra-loja", servedTenantIds: [], type: "WHATSAPP", status: "CONNECTED" }]);
    const client = new QueryClient();
    show(vi.fn(), client);
    await waitFor(() => expect(client.getQueryState(["channels"])?.status).toBe("success"));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("(86) 99447-8163")).toBeTruthy();
  });
});
