import type { IntegrationDto, OrderHistoryImport } from "@dishdesk/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderHistorySection } from "./order-history-section";

const toast = vi.fn();
vi.mock("@/components/auth/auth-provider", () => ({ useAuth: () => ({ request: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));

const history = (patch: Partial<OrderHistoryImport>): OrderHistoryImport => ({
  status: "running",
  progress: 40,
  imported: 3,
  from: "2025-05-10T00:00:00.000Z",
  to: "2026-11-02T00:00:00.000Z",
  startedAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:05:00.000Z",
  ...patch,
});

function show(orderHistory: OrderHistoryImport | null) {
  const queryClient = new QueryClient();
  const tree = (state: OrderHistoryImport | null) => (
    <QueryClientProvider client={queryClient}>
      <OrderHistorySection tenantId="t1" item={{ id: "c1", orderHistory: state } as IntegrationDto} canEdit queryKey={["integrations", "t1"]} />
    </QueryClientProvider>
  );
  const view = render(tree(orderHistory));
  return { update: (next: OrderHistoryImport | null) => view.rerender(tree(next)) };
}

describe("importação do histórico de pedidos", () => {
  afterEach(() => {
    cleanup();
    toast.mockClear();
  });

  it("mostra o que já foi importado e o período percorrido, sem total inventado", () => {
    show(history({}));
    expect(screen.getByText(/3 cancelamentos até agora, de/)).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
  });

  it("avisa uma vez quando termina com a tela aberta", () => {
    const { update } = show(history({}));
    update(history({ status: "done", progress: 100, imported: 7 }));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("Histórico de pedidos importado");
    update(history({ status: "done", progress: 100, imported: 7, updatedAt: "2026-11-02T10:06:00.000Z" }));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("não avisa ao abrir a tela com a importação já concluída, nem quando termina em parte", () => {
    show(history({ status: "done", progress: 100 }));
    expect(toast).not.toHaveBeenCalled();
    cleanup();
    const { update } = show(history({}));
    update(history({ status: "partial" }));
    expect(toast).not.toHaveBeenCalled();
  });
});
