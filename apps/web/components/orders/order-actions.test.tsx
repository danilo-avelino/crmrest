import type { OrderListItem } from "@dishdesk/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderActions } from "./order-actions";

const request = vi.fn();
/** Por onde a equipe fala com o cliente (consulta do botão "Abrir conversa"); fora dos testes dele, sem canal. */
const customerChat = vi.fn();
const push = vi.fn();
vi.mock("@/components/auth/auth-provider", () => ({
  useAuth: () => ({
    request: (...args: [string, { method?: string }?]) => (args[0].endsWith("/customer-chat") && !args[1] ? customerChat(args[0]) : request(...args)),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
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
  answerable: true,
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
  beforeEach(() => customerChat.mockResolvedValue({ channel: null, contactName: null }));
  afterEach(() => {
    cleanup();
    request.mockReset();
    customerChat.mockReset();
    push.mockReset();
  });

  it("Abrir conversa: só com canal para falar com o cliente; abre a conversa e leva à Inbox", async () => {
    customerChat.mockResolvedValue({ channel: "WHATSAPP", contactName: "Marcos" });
    request.mockResolvedValueOnce({ conversationId: "conversa-9" });
    show({ status: "DELIVERED", nextAction: null, cancelable: false });
    fireEvent.click(await screen.findByRole("button", { name: "Abrir conversa" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/inbox?conversa=conversa-9"));
    expect(request).toHaveBeenCalledWith("/orders/pedido-1/customer-chat", { method: "POST" });
  });

  it("sem canal para falar com o cliente: não mostra Abrir conversa", async () => {
    show();
    await waitFor(() => expect(customerChat).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Abrir conversa" })).toBeNull();
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
    request
      .mockResolvedValueOnce({ reasons: [{ code: "503", description: "ITEM INDISPONÍVEL" }], reasonMode: "list", message: null, address: null })
      .mockResolvedValueOnce(undefined);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar pedido" }));
    const reason = await screen.findByRole("radio", { name: "ITEM INDISPONÍVEL" });
    expect(request).toHaveBeenCalledWith("/orders/pedido-1/cancellation-reasons");

    const confirm = screen.getAllByRole("button", { name: "Cancelar pedido" }).at(-1)!;
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(reason);
    fireEvent.click(screen.getAllByRole("button", { name: "Cancelar pedido" }).at(-1)!);
    await waitFor(() => expect(request).toHaveBeenCalledWith("/orders/pedido-1/cancel", { method: "POST", body: { code: "503", markFraud: false } }));
    expect(await screen.findByText("Cancelamento pedido, aguardando o iFood.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("status", { hidden: true }).textContent).toContain("Enviado ao iFood"));
  });

  it("o iFood não oferece motivos: avisa que não dá para cancelar", async () => {
    request.mockResolvedValueOnce({ reasons: [], reasonMode: "list", message: null, address: null });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar pedido" }));
    expect(await screen.findByText("Não dá para cancelar agora")).toBeTruthy();
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

  it("Dish Desk só acompanhando: avisa do pedido do cliente, sem botões", () => {
    show({ status: "PREPARING", nextAction: null, cancelable: false, dispute: { ...dispute, answerable: false } });
    const notice = screen.getByRole("alert").textContent;
    expect(notice).toContain("O cliente pediu o cancelamento do pedido: “Pedi errado”");
    expect(notice).toContain("Responda no sistema de pedidos da loja até");
    expect(screen.queryByRole("button")).toBeNull();
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
