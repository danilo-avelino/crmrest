import type { OrderListItem } from "@dishdesk/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderActions } from "./order-actions";

const request = vi.fn();
vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ request }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => vi.fn() }));

const order = (patch: Partial<OrderListItem>) =>
  ({
    id: "pedido-1",
    displayCode: "7001",
    channelType: "IFOOD",
    status: "PLACED",
    nextAction: "CONFIRM",
    cancelable: true,
    dispute: null,
    ...patch,
  }) as OrderListItem;

const dispute = {
  id: "disputa-1",
  action: "CANCELLATION",
  message: "Pedi errado",
  expiresAt: "2026-10-13T21:09:00.000Z",
  timeoutAction: "ACCEPT_CANCELLATION",
  acceptReasons: ["CUSTOMER_REQUEST"],
};

function show(patch: Partial<OrderListItem> = {}) {
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OrderActions order={order(patch)} />
    </QueryClientProvider>,
  );
  const update = (next: Partial<OrderListItem>) =>
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <OrderActions order={order(next)} />
      </QueryClientProvider>,
    );
  return { update };
}

describe("ações do pedido do iFood", () => {
  afterEach(() => {
    cleanup();
    request.mockReset();
  });

  it("o botão muda com o status do pedido", () => {
    const { update } = show();
    expect(screen.getByRole("button", { name: "Confirmar pedido" })).toBeTruthy();
    update({ status: "CONFIRMED", nextAction: "READY" });
    expect(screen.getByRole("button", { name: "Marcar como pronto" })).toBeTruthy();
    update({ status: "READY", nextAction: "DISPATCH" });
    expect(screen.getByRole("button", { name: "Despachar" })).toBeTruthy();
  });

  it("sem etapa nem cancelamento (entregue, ou outra origem): não mostra nada", () => {
    show({ status: "DELIVERED", nextAction: null, cancelable: false });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("depois de enviar, espera o iFood mudar o pedido antes de oferecer a próxima etapa", async () => {
    request.mockResolvedValue({ action: "CONFIRM" });
    const { update } = show();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar pedido" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Enviado ao iFood"));
    expect(request).toHaveBeenCalledWith("/orders/pedido-1/advance", { method: "POST" });
    expect(screen.queryByRole("button")).toBeNull();

    update({ status: "CONFIRMED", nextAction: "READY" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Marcar como pronto" })).toBeTruthy();
  });

  it("cancelar: escolhe um dos motivos do iFood e só então pede o cancelamento", async () => {
    request.mockResolvedValueOnce({ reasons: [{ code: "503", description: "ITEM INDISPONÍVEL" }] }).mockResolvedValueOnce(undefined);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar pedido" }));
    const reason = await screen.findByRole("radio", { name: "ITEM INDISPONÍVEL" });
    expect(request).toHaveBeenCalledWith("/orders/pedido-1/cancellation-reasons");

    const confirm = screen.getAllByRole("button", { name: "Cancelar pedido" }).at(-1)!;
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(reason);
    fireEvent.click(screen.getAllByRole("button", { name: "Cancelar pedido" }).at(-1)!);
    await waitFor(() => expect(request).toHaveBeenCalledWith("/orders/pedido-1/cancel", { method: "POST", body: { code: "503" } }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Enviado ao iFood"));
  });

  it("o iFood não oferece motivos: avisa que não dá para cancelar", async () => {
    request.mockResolvedValueOnce({ reasons: [] });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar pedido" }));
    expect(await screen.findByText("O iFood não permite cancelar este pedido agora.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fechar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancelar pedido" })).toBeNull(); // o modal não oferece confirmar
  });

  it("cliente pediu o cancelamento: mostra o pedido e o prazo; recusar pede o motivo", async () => {
    request.mockResolvedValue(undefined);
    const { update } = show({ status: "PREPARING", nextAction: "READY", dispute });
    const notice = screen.getByRole("alert").textContent;
    expect(notice).toContain("O cliente pediu o cancelamento do pedido: “Pedi errado”");
    expect(notice).toContain("Responda até");
    expect(notice).toContain("Sem resposta, o iFood cancela.");

    fireEvent.click(screen.getByRole("button", { name: "Recusar" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Loja com muita demanda" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Recusar" }).at(-1)!);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/orders/pedido-1/dispute", { method: "POST", body: { accept: false, reason: "HIGH_STORE_DEMAND" } }),
    );
    // Recusado: o status não muda; a espera acaba quando a negociação sai do pedido.
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    update({ status: "PREPARING", nextAction: "READY", dispute: null });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Marcar como pronto" })).toBeTruthy();
  });

  it("aceitar o pedido do cliente: só com um dos motivos que o iFood ofereceu", async () => {
    request.mockResolvedValue(undefined);
    show({ dispute });
    fireEvent.click(screen.getByRole("button", { name: "Aceitar" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Pedido do cliente" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Aceitar" }).at(-1)!);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/orders/pedido-1/dispute", { method: "POST", body: { accept: true, reason: "CUSTOMER_REQUEST" } }),
    );
  });
});
