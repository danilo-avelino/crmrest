import type { CanceledOrderRow, OrderAlertDto, OrderDto } from "@dishdesk/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerCancellationsCard, FraudAlert } from "./fraud-alert";

const request = vi.fn();
vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ request }) }));

const row = (id: number, patch: Partial<CanceledOrderRow> = {}): CanceledOrderRow => ({
  id: `pedido-${id}`,
  displayCode: String(id),
  channelType: "CARDAPIO_WEB",
  restaurantName: null,
  total: "172.00",
  placedAt: "2026-10-24T22:00:00.000Z",
  reason: "Ninguém recebeu na entrega",
  imported: false,
  fraud: null,
  address: "Rua das Acácias, 120 · Bloco B, apto 34",
  ...patch,
});

const order = {
  id: "pedido-atual",
  displayCode: "4821",
  channelType: "IFOOD",
  total: "186.40",
  items: [{ name: "Pizza calabresa G", quantity: 2, unitPrice: "69.90", notes: null, options: [] }],
} as Pick<OrderDto, "id" | "displayCode" | "channelType" | "total" | "items">;

const alert = (patch: Partial<OrderAlertDto> = {}, rows: CanceledOrderRow[] = [row(4710)]): OrderAlertDto => ({
  customerName: "Marcos Vieira",
  cancellations: { ordersCount: 9, canceledCount: rows.length, fraudCount: rows.filter((r) => r.fraud).length, bySource: [{ channelType: "CARDAPIO_WEB", orders: rows.length }], rows },
  address: "Rua das Acácias, 120 · Bloco B, apto 34",
  addressMatches: [],
  decision: null,
  actionable: true,
  ...patch,
});

function show(value: OrderAlertDto, { cancelable = true, teamOnly = false } = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FraudAlert order={order} alert={value} cancelable={cancelable} teamOnly={teamOnly} />
    </QueryClientProvider>,
  );
}

describe("alerta de fraude", () => {
  afterEach(() => {
    cleanup();
    request.mockReset();
  });

  it("mostra o resumo, o pedido e os cancelamentos, só para a equipe", () => {
    show(alert());
    const section = screen.getByRole("region", { name: "Alerta de fraude" }).textContent;
    expect(section).toContain("Só a equipe vê");
    expect(section).toContain("Marcos Vieira tem 1 pedido cancelado de 9 feitos");
    expect(section).toContain("iFood #4821");
    expect(section).toContain("Ninguém recebeu na entrega");
    expect(section).toContain("Nada é cancelado sem você confirmar.");
  });

  it("nunca sugere pagamento online", () => {
    show(alert({ addressMatches: [{ placedAt: "2026-10-11T22:00:00.000Z", reason: null, markedBy: "Ana Silva" }] }));
    expect(screen.getByRole("region", { name: "Alerta de fraude" }).textContent?.toLowerCase()).not.toContain("pagamento");
  });

  it("endereço marcado, sem cancelamentos: bloco próprio, sem dados do outro cliente", () => {
    show(alert({ addressMatches: [{ placedAt: "2026-10-11T22:00:00.000Z", reason: "Ninguém recebeu", markedBy: "Ana Silva" }] }, []));
    const section = screen.getByRole("region", { name: "Alerta de fraude" }).textContent;
    expect(section).toContain("Marcos Vieira não tem cancelamentos");
    expect(section).toContain("Este endereço tem um pedido marcado como fraude");
    expect(section).toContain("Motivo: Ninguém recebeu · Marcado por Ana");
  });

  it("motivo que falta, pedido importado e marca de fraude aparecem na linha", () => {
    show(alert({}, [row(1, { reason: null }), row(2, { imported: true }), row(3, { fraud: { by: "Ana Silva", at: "2026-10-11T23:05:00.000Z" } })]));
    expect(screen.getByText("Motivo não informado")).toBeTruthy();
    expect(screen.getByText("Importado")).toBeTruthy();
    expect(screen.getByText("Fraude")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remover marca" })).toBeTruthy();
  });

  it("com mais de 3, mostra os 3 mais recentes e abre a lista completa", () => {
    show(alert({}, [row(1), row(2), row(3), row(4)]));
    expect(screen.getByText("Mostrando 3 de 4")).toBeTruthy();
    expect(screen.queryByText("#4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ver todos os 4 cancelamentos" }));
    expect(screen.getByRole("heading", { name: "Cancelamentos de Marcos Vieira" })).toBeTruthy();
    expect(screen.getByText("#4")).toBeTruthy();
  });

  it("manter: trava os botões enquanto salva e avisa se falhar", async () => {
    let fail: (error: Error) => void = () => {};
    request.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    show(alert());
    fireEvent.click(screen.getByRole("button", { name: "Manter pedido" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/orders/pedido-atual/keep", { method: "POST" }));
    expect(screen.getByRole("button", { name: "Cancelar pedido" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Carregando/ }));
    expect(request).toHaveBeenCalledTimes(1);
    fail(new Error("sem rede"));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("sem cancelamento pelo Dish Desk: sem o botão, com o aviso do sistema de origem; manter continua", () => {
    show(alert(), { cancelable: false });
    expect(screen.queryByRole("button", { name: "Cancelar pedido" })).toBeNull();
    expect(screen.getByText("Cancele este pedido no Gestor de Pedidos do iFood.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manter pedido" })).toBeTruthy();
  });

  it("recolher vira uma linha; abrir volta", () => {
    show(alert());
    fireEvent.click(screen.getByRole("button", { name: "Recolher" }));
    expect(screen.queryByRole("region", { name: "Alerta de fraude" })).toBeNull();
    expect(screen.getByRole("button", { name: "Manter pedido" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    expect(screen.getByRole("region", { name: "Alerta de fraude" })).toBeTruthy();
  });

  it("decidido: linha discreta, sem botões; dá para rever o alerta", () => {
    show(alert({ decision: { kind: "CANCELED", by: "Ana Silva", at: "2026-11-02T22:44:00.000Z", fraud: true } }));
    expect(screen.queryByRole("button", { name: "Manter pedido" })).toBeNull();
    expect(screen.getByText(/Pedido cancelado por Ana às/)).toBeTruthy();
    expect(screen.getByText(/marcado como fraude/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver alerta" }));
    expect(screen.getByRole("region", { name: "Alerta de fraude" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manter pedido" })).toBeNull();
  });

  it("aguardando o iFood: linha sem botões", () => {
    show(alert({ decision: { kind: "CANCELING", by: "Ana Silva", at: "2026-11-02T22:44:00.000Z", fraud: false } }));
    expect(screen.getByText("Cancelamento pedido, aguardando o iFood")).toBeTruthy();
    expect(screen.getByText("Aguardando")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ver alerta" })).toBeNull();
  });

  it("pedido de outra unidade: mostra o alerta, mas não oferece decidir", () => {
    show(alert({ actionable: false }));
    expect(screen.queryByRole("button", { name: "Manter pedido" })).toBeNull();
    expect(screen.getByText("Pedido de outra unidade: a decisão é de quem atende lá.")).toBeTruthy();
  });
});

describe("modal de cancelamento", () => {
  afterEach(() => {
    cleanup();
    request.mockReset();
  });

  const open = () => fireEvent.click(screen.getByRole("button", { name: "Cancelar pedido" }));
  const confirmButton = () => screen.getAllByRole("button", { name: /Cancelar pedido|Tentar de novo/ }).at(-1)!;

  it("a marca de fraude vem desligada e mostra o endereço; a mensagem mostra o canal e o tom", async () => {
    request.mockResolvedValueOnce({
      reasons: [{ code: "1", description: "Suspeita de golpe" }],
      reasonMode: "list",
      message: { text: "Pedido #4821 cancelado.", via: "chat do iFood", tone: "Direto" },
      address: "Rua das Acácias, 120",
    });
    show(alert());
    open();
    const mark = (await screen.findByRole("checkbox", { name: /Marcar como fraude/ })) as HTMLInputElement;
    expect(mark.checked).toBe(false);
    expect(screen.getByText("Os próximos pedidos para Rua das Acácias, 120 vão mostrar este pedido no alerta.")).toBeTruthy();
    expect(screen.getByText("Pedido #4821 cancelado.")).toBeTruthy();
    expect(screen.getByText(/Vai pelo chat do iFood, no tom Direto/)).toBeTruthy();
  });

  it("marcar como fraude vai junto no cancelamento; a recusa mantém o modal com a mensagem da plataforma", async () => {
    request
      .mockResolvedValueOnce({ reasons: [{ code: "1", description: "Suspeita de golpe" }], reasonMode: "list", message: null, address: "Rua A, 1" })
      .mockRejectedValueOnce(new Error("sem rede"));
    show(alert());
    open();
    fireEvent.click(await screen.findByRole("radio", { name: "Suspeita de golpe" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Marcar como fraude/ }));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(request).toHaveBeenCalledWith("/orders/pedido-atual/cancel", { method: "POST", body: { code: "1", markFraud: true } }));
    expect((await screen.findByRole("alert")).textContent).toContain("O pedido continua ativo");
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  it("retirada: sem endereço para marcar; sem conversa: avisa que a mensagem não sai", async () => {
    request.mockResolvedValueOnce({ reasons: [], reasonMode: "text", message: null, address: null });
    show(alert());
    open();
    expect(await screen.findByText(/Pedido para retirada: não tem endereço para marcar/)).toBeTruthy();
    expect(screen.getByText(/o cancelamento não envia mensagem/)).toBeTruthy();
    expect(screen.getByText("Depois de confirmado, o cancelamento não pode ser desfeito.")).toBeTruthy();
  });

  it("erro ao carregar os motivos: dá para tentar de novo", async () => {
    request.mockRejectedValueOnce(new Error("sem rede"));
    show(alert());
    open();
    expect((await screen.findByRole("alert")).textContent).toContain("Não conseguimos carregar os motivos do iFood");
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });
});

describe("marca de fraude num pedido cancelado", () => {
  afterEach(() => {
    cleanup();
    request.mockReset();
  });

  const cancellations = (rows: CanceledOrderRow[]) => ({ ordersCount: 2, canceledCount: rows.length, fraudCount: rows.filter((r) => r.fraud).length, bySource: [], rows });
  const showCard = (rows: CanceledOrderRow[]) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CustomerCancellationsCard cancellations={cancellations(rows)} />
      </QueryClientProvider>,
    );

  it("sem cancelamentos: estado vazio", () => {
    showCard([]);
    expect(screen.getByText("Nenhum cancelamento")).toBeTruthy();
  });

  it("marcar pede confirmação e mostra o endereço", async () => {
    request.mockResolvedValueOnce(undefined);
    showCard([row(4710)]);
    fireEvent.click(screen.getByRole("button", { name: "Marcar como fraude" }));
    expect(screen.getByRole("heading", { name: "Marcar o pedido #4710 como fraude?" })).toBeTruthy();
    expect(screen.getByText("Rua das Acácias, 120 · Bloco B, apto 34")).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Marcar como fraude" }).at(-1)!);
    await waitFor(() => expect(request).toHaveBeenCalledWith("/orders/pedido-4710/fraud", { method: "POST" }));
  });

  it("retirada: avisa que não há endereço para marcar", () => {
    showCard([row(4391, { address: null })]);
    fireEvent.click(screen.getByRole("button", { name: "Marcar como fraude" }));
    expect(screen.getByText(/É um pedido para retirada, sem endereço para marcar/)).toBeTruthy();
  });

  it("remover a marca também pede confirmação", async () => {
    request.mockResolvedValueOnce(undefined);
    showCard([row(4710, { fraud: { by: "Ana Silva", at: "2026-11-02T22:42:00.000Z" } })]);
    fireEvent.click(screen.getByRole("button", { name: "Remover marca" }));
    expect(screen.getByRole("heading", { name: "Remover a marca de fraude?" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Remover marca" }).at(-1)!);
    await waitFor(() => expect(request).toHaveBeenCalledWith("/orders/pedido-4710/fraud", { method: "DELETE" }));
  });
});
